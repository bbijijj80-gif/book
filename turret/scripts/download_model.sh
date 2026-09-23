#!/usr/bin/env bash
# Скачивает веса MobileNet-SSD (Caffe) для детектора людей.
set -euo pipefail

DEST="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/models"
mkdir -p "$DEST"

PROTOTXT_URL="https://raw.githubusercontent.com/chuanqi305/MobileNet-SSD/master/deploy.prototxt"
MODEL_URL="https://raw.githubusercontent.com/chuanqi305/MobileNet-SSD/master/mobilenet_iter_73000.caffemodel"

echo "Скачиваю $PROTOTXT_URL"
curl -fL "$PROTOTXT_URL" -o "$DEST/MobileNetSSD_deploy.prototxt"

echo "Скачиваю $MODEL_URL (~23 МБ)"
curl -fL "$MODEL_URL" -o "$DEST/MobileNetSSD_deploy.caffemodel"

echo "Готово: веса сохранены в $DEST"
