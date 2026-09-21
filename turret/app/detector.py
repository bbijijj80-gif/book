from dataclasses import dataclass
from typing import List

import cv2
import numpy as np

VOC_CLASSES = [
    "background", "aeroplane", "bicycle", "bird", "boat", "bottle", "bus",
    "car", "cat", "chair", "cow", "diningtable", "dog", "horse", "motorbike",
    "person", "pottedplant", "sheep", "sofa", "train", "tvmonitor",
]
PERSON_CLASS_ID = VOC_CLASSES.index("person")


@dataclass
class Detection:
    x1: int
    y1: int
    x2: int
    y2: int
    confidence: float

    @property
    def center(self):
        return (self.x1 + self.x2) // 2, (self.y1 + self.y2) // 2

    @property
    def area(self):
        return max(0, self.x2 - self.x1) * max(0, self.y2 - self.y1)


class PersonDetector:
    """Person detector using the MobileNet-SSD (Caffe) model via OpenCV's DNN
    module. Chosen for CPU-only inference on a Raspberry Pi 4 - no GPU/PyTorch
    dependency needed. See models/README.md to fetch the weight files."""

    def __init__(self, prototxt, model, confidence_threshold=0.5, resize=300):
        self.net = cv2.dnn.readNetFromCaffe(prototxt, model)
        self.confidence_threshold = confidence_threshold
        self.resize = resize

    def detect(self, frame) -> List[Detection]:
        h, w = frame.shape[:2]
        blob = cv2.dnn.blobFromImage(
            cv2.resize(frame, (self.resize, self.resize)),
            scalefactor=0.007843,
            size=(self.resize, self.resize),
            mean=127.5,
        )
        self.net.setInput(blob)
        raw = self.net.forward()

        detections = []
        for i in range(raw.shape[2]):
            confidence = float(raw[0, 0, i, 2])
            class_id = int(raw[0, 0, i, 1])
            if class_id != PERSON_CLASS_ID or confidence < self.confidence_threshold:
                continue

            box = raw[0, 0, i, 3:7] * np.array([w, h, w, h])
            x1, y1, x2, y2 = box.astype(int)
            x1, y1 = max(0, x1), max(0, y1)
            x2, y2 = min(w - 1, x2), min(h - 1, y2)
            if x2 <= x1 or y2 <= y1:
                continue

            detections.append(Detection(x1, y1, x2, y2, confidence))
        return detections
