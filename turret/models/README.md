# Веса детектора (MobileNet-SSD, Caffe)

Сюда должны попасть два файла:

- `MobileNetSSD_deploy.prototxt`
- `MobileNetSSD_deploy.caffemodel`

Проще всего получить их запуском `../scripts/download_model.sh` из каталога
`turret/` — скрипт скачивает `deploy.prototxt` и
`mobilenet_iter_73000.caffemodel` из репозитория `chuanqi305/MobileNet-SSD`
и сохраняет их сюда под указанными выше именами.

Если скачивание не удалось (на Pi нет интернета или зеркало недоступно),
скачайте эти же два файла на другом компьютере и скопируйте сюда вручную.
