import ARKit
import Combine
import ModelIO
import RealityKit
import SwiftUI
import UIKit

/// Фигуры, которые можно создать прямо в приложении.
enum ShapeKind: String, CaseIterable, Identifiable {
    case box, sphere, cylinder, cone, slab

    var id: String { rawValue }

    var title: String {
        switch self {
        case .box: return "Куб"
        case .sphere: return "Шар"
        case .cylinder: return "Цилиндр"
        case .cone: return "Конус"
        case .slab: return "Плита"
        }
    }

    var icon: String {
        switch self {
        case .box: return "cube.fill"
        case .sphere: return "circle.fill"
        case .cylinder: return "cylinder.fill"
        case .cone: return "cone.fill"
        case .slab: return "rectangle.fill"
        }
    }

    var mesh: MeshResource {
        switch self {
        case .box: return .generateBox(size: 0.15, cornerRadius: 0.005)
        case .sphere: return .generateSphere(radius: 0.09)
        case .cylinder: return .generateCylinder(height: 0.2, radius: 0.07)
        case .cone: return .generateCone(height: 0.22, radius: 0.09)
        case .slab: return .generateBox(size: [0.3, 0.02, 0.3], cornerRadius: 0.003)
        }
    }
}

enum ImportError: LocalizedError {
    case unsupportedFormat
    case emptyModel

    var errorDescription: String? {
        switch self {
        case .unsupportedFormat: return "этот формат не поддерживается"
        case .emptyModel: return "в файле нет геометрии"
        }
    }
}

/// Управляет AR-сценой: камера, размещение, выбор и удаление объектов.
@MainActor
final class ARController: NSObject, ObservableObject {
    let arView = ARView(frame: .zero)

    @Published var selectedName: String?
    @Published var objectCount = 0
    @Published var message: String?

    private var selected: Entity?
    private var anchors: [AnchorEntity] = []
    private var messageTask: Task<Void, Never>?

    override init() {
        super.init()

        let coaching = ARCoachingOverlayView()
        coaching.session = arView.session
        coaching.goal = .anyPlane
        coaching.frame = arView.bounds
        coaching.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        arView.addSubview(coaching)

        let tap = UITapGestureRecognizer(target: self, action: #selector(handleTap(_:)))
        arView.addGestureRecognizer(tap)
    }

    // MARK: - Сессия

    func startSession() {
        guard ARWorldTrackingConfiguration.isSupported else {
            show("Это устройство не поддерживает AR")
            return
        }
        let config = ARWorldTrackingConfiguration()
        config.planeDetection = [.horizontal, .vertical]
        config.environmentTexturing = .automatic

        // На устройствах с LiDAR реальные предметы будут заслонять виртуальные.
        if ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh) {
            config.sceneReconstruction = .mesh
            arView.environment.sceneUnderstanding.options.insert(.occlusion)
        }
        // Люди, проходящие перед объектом, тоже его заслоняют.
        if ARWorldTrackingConfiguration.supportsFrameSemantics(.personSegmentationWithDepth) {
            config.frameSemantics.insert(.personSegmentationWithDepth)
        }
        arView.session.run(config)
    }

    func pauseSession() {
        arView.session.pause()
    }

    // MARK: - Создание объектов

    func addShape(_ kind: ShapeKind, color: Color, metallic: Bool) {
        let model = ModelEntity(mesh: kind.mesh, materials: [material(color, metallic)])
        place(model, name: kind.title)
    }

    func addText(_ text: String, color: Color, metallic: Bool) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let mesh = MeshResource.generateText(
            trimmed,
            extrusionDepth: 0.03,
            font: .systemFont(ofSize: 0.12, weight: .bold),
            containerFrame: .zero,
            alignment: .center,
            lineBreakMode: .byWordWrapping
        )
        let model = ModelEntity(mesh: mesh, materials: [material(color, metallic)])
        place(model, name: "«\(trimmed)»")
    }

    func importModel(from url: URL, color: Color, metallic: Bool) {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }

        do {
            let fm = FileManager.default
            let dir = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            try fm.createDirectory(at: dir, withIntermediateDirectories: true)
            let local = dir.appendingPathComponent(url.lastPathComponent)
            try fm.copyItem(at: url, to: local)

            let native = ["usdz", "usd", "usda", "usdc", "reality"]
            let entity: Entity
            if native.contains(local.pathExtension.lowercased()) {
                entity = try Entity.load(contentsOf: local)
            } else {
                // OBJ / STL / PLY: конвертируем через Model I/O в USD.
                let asset = MDLAsset(url: local)
                guard asset.count > 0 else { throw ImportError.emptyModel }
                guard MDLAsset.canExportFileExtension("usdc") else { throw ImportError.unsupportedFormat }
                let converted = dir.appendingPathComponent("converted.usdc")
                try asset.export(to: converted)
                entity = try Entity.load(contentsOf: converted)
                // У таких файлов материалы не переносятся — красим выбранным цветом.
                applyMaterial(material(color, metallic), to: entity)
            }

            for animation in entity.availableAnimations {
                entity.playAnimation(animation.repeat())
            }
            let name = url.deletingPathExtension().lastPathComponent
            place(entity, name: name, normalizeSize: true)
        } catch {
            show("Не удалось загрузить модель: \(error.localizedDescription)")
        }
    }

    // MARK: - Действия с выбранным объектом

    func liftSelected(by delta: Float) {
        selected?.position.y += delta
    }

    func deleteSelected() {
        guard let entity = selected else { return }
        if let anchor = entity.parent as? AnchorEntity {
            anchor.removeFromParent()
            anchors.removeAll { $0 === anchor }
        } else {
            entity.removeFromParent()
        }
        select(nil)
        objectCount = anchors.count
    }

    func deleteAll() {
        anchors.forEach { $0.removeFromParent() }
        anchors.removeAll()
        select(nil)
        objectCount = 0
    }

    // MARK: - Внутреннее

    @objc private func handleTap(_ recognizer: UITapGestureRecognizer) {
        let point = recognizer.location(in: arView)
        var hit = arView.entity(at: point)
        // Поднимаемся до контейнера, который лежит прямо в якоре.
        while let current = hit, !(current.parent is AnchorEntity), current.parent != nil {
            hit = current.parent
        }
        select(hit)
    }

    private func select(_ entity: Entity?) {
        selected = entity
        selectedName = entity?.name
    }

    private func material(_ color: Color, _ metallic: Bool) -> SimpleMaterial {
        SimpleMaterial(color: UIColor(color), roughness: metallic ? 0.2 : 0.5, isMetallic: metallic)
    }

    private func applyMaterial(_ material: SimpleMaterial, to entity: Entity) {
        if var model = entity.components[ModelComponent.self] {
            model.materials = model.materials.map { _ in material }
            entity.components.set(model)
        }
        entity.children.forEach { applyMaterial(material, to: $0) }
    }

    /// Ставит объект в реальный мир: на поверхность в центре экрана
    /// или, если поверхность ещё не найдена, в 60 см перед камерой.
    private func place(_ content: Entity, name: String, normalizeSize: Bool = false) {
        let container = ModelEntity()
        container.name = name
        container.addChild(content)

        var bounds = content.visualBounds(relativeTo: container)
        guard !bounds.isEmpty, bounds.extents.x.isFinite else {
            show("Не удалось загрузить модель: в файле нет геометрии")
            return
        }

        // Модели из интернета бывают в любых единицах — приводим к разумному размеру.
        let largest = max(bounds.extents.x, bounds.extents.y, bounds.extents.z)
        if normalizeSize, largest > 0, largest > 2 || largest < 0.05 {
            content.scale *= 0.4 / largest
            bounds = content.visualBounds(relativeTo: container)
        }

        // Центрируем и ставим «дном» на поверхность.
        content.position -= SIMD3<Float>(bounds.center.x, bounds.min.y, bounds.center.z)

        let size = simd_max(bounds.extents, SIMD3<Float>(repeating: 0.02))
        let shape = ShapeResource.generateBox(size: size)
            .offsetBy(translation: [0, size.y / 2, 0])
        container.collision = CollisionComponent(shapes: [shape])

        let position = placementPosition()
        let camera = arView.cameraTransform.translation
        let yaw = atan2(camera.x - position.x, camera.z - position.z)
        container.orientation = simd_quatf(angle: yaw, axis: [0, 1, 0])

        let anchor = AnchorEntity(world: position)
        anchor.addChild(container)
        arView.scene.addAnchor(anchor)
        anchors.append(anchor)

        // Перетаскивание одним пальцем, поворот и масштаб двумя.
        arView.installGestures([.translation, .rotation, .scale], for: container)

        objectCount = anchors.count
        select(container)
    }

    private func placementPosition() -> SIMD3<Float> {
        let center = CGPoint(x: arView.bounds.midX, y: arView.bounds.midY)
        if let hit = arView.raycast(from: center, allowing: .estimatedPlane, alignment: .any).first {
            let t = hit.worldTransform.columns.3
            return [t.x, t.y, t.z]
        }
        let camera = arView.cameraTransform
        let back = camera.matrix.columns.2 // камера смотрит вдоль -Z
        return camera.translation - 0.6 * SIMD3<Float>(back.x, back.y, back.z)
    }

    private func show(_ text: String) {
        message = text
        messageTask?.cancel()
        messageTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            if !Task.isCancelled { self?.message = nil }
        }
    }
}
