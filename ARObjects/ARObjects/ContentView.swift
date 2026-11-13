import RealityKit
import SwiftUI
import UniformTypeIdentifiers

struct ARViewContainer: UIViewRepresentable {
    let controller: ARController

    func makeUIView(context: Context) -> ARView { controller.arView }
    func updateUIView(_ uiView: ARView, context: Context) {}
}

struct ContentView: View {
    @StateObject private var controller = ARController()
    @Environment(\.scenePhase) private var scenePhase

    @State private var color: Color = .orange
    @State private var metallic = false
    @State private var showImporter = false
    @State private var showTextPrompt = false
    @State private var textInput = ""
    @State private var confirmClear = false

    private var modelTypes: [UTType] {
        var types: [UTType] = [.usdz, .usd, .realityFile]
        for ext in ["usda", "usdc", "obj", "stl", "ply"] {
            if let type = UTType(filenameExtension: ext) { types.append(type) }
        }
        return types
    }

    var body: some View {
        ZStack {
            ARViewContainer(controller: controller)
                .ignoresSafeArea()

            VStack(spacing: 10) {
                topBar
                if let message = controller.message {
                    Text(message)
                        .font(.footnote)
                        .padding(10)
                        .background(.red.opacity(0.85), in: RoundedRectangle(cornerRadius: 12))
                        .foregroundStyle(.white)
                }
                Spacer()
                if controller.selectedName != nil { selectionBar }
                bottomPanel
            }
            .padding()
        }
        .onAppear { controller.startSession() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { controller.startSession() }
            if phase == .background { controller.pauseSession() }
        }
        .fileImporter(isPresented: $showImporter, allowedContentTypes: modelTypes) { result in
            if case .success(let url) = result {
                controller.importModel(from: url, color: color, metallic: metallic)
            }
        }
        .alert("Объёмный текст", isPresented: $showTextPrompt) {
            TextField("Текст", text: $textInput)
            Button("Создать") {
                controller.addText(textInput, color: color, metallic: metallic)
                textInput = ""
            }
            Button("Отмена", role: .cancel) { textInput = "" }
        }
        .confirmationDialog("Удалить все объекты?", isPresented: $confirmClear, titleVisibility: .visible) {
            Button("Удалить все", role: .destructive) { controller.deleteAll() }
        }
    }

    private var topBar: some View {
        HStack {
            Text(controller.objectCount == 0
                 ? "Наведите на пол или стол и выберите фигуру"
                 : "Объектов: \(controller.objectCount)")
                .font(.footnote.weight(.medium))
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(.ultraThinMaterial, in: Capsule())
            Spacer()
            if controller.objectCount > 0 {
                Button { confirmClear = true } label: {
                    Image(systemName: "trash")
                        .padding(10)
                        .background(.ultraThinMaterial, in: Circle())
                }
                .tint(.red)
            }
        }
    }

    private var selectionBar: some View {
        HStack(spacing: 14) {
            Text(controller.selectedName ?? "")
                .font(.subheadline.weight(.semibold))
                .lineLimit(1)
            Spacer()
            Button { controller.liftSelected(by: 0.05) } label: { Image(systemName: "arrow.up") }
            Button { controller.liftSelected(by: -0.05) } label: { Image(systemName: "arrow.down") }
            Button(role: .destructive) { controller.deleteSelected() } label: { Image(systemName: "trash") }
        }
        .font(.title3)
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16))
    }

    private var bottomPanel: some View {
        VStack(spacing: 12) {
            HStack {
                ColorPicker("Цвет", selection: $color, supportsOpacity: false)
                    .fixedSize()
                Spacer()
                Toggle("Металл", isOn: $metallic)
                    .fixedSize()
            }
            .font(.subheadline)

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    ForEach(ShapeKind.allCases) { kind in
                        toolButton(kind.title, icon: kind.icon) {
                            controller.addShape(kind, color: color, metallic: metallic)
                        }
                    }
                    toolButton("Текст", icon: "textformat") { showTextPrompt = true }
                    toolButton("3D-файл", icon: "square.and.arrow.down") { showImporter = true }
                }
            }
        }
        .padding(14)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 20))
    }

    private func toolButton(_ title: String, icon: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 6) {
                Image(systemName: icon).font(.title2)
                Text(title).font(.caption)
            }
            .frame(width: 68, height: 62)
            .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 14))
        }
        .buttonStyle(.plain)
    }
}
