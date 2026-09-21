import threading
import time

import cv2


class CameraStream:
    """Threaded reader for a USB (UVC) webcam so frame capture never blocks the
    detection/control loop on a slow cv2.VideoCapture.read()."""

    def __init__(self, index=0, width=640, height=480, fps=30):
        self.cap = cv2.VideoCapture(index)
        self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
        self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
        self.cap.set(cv2.CAP_PROP_FPS, fps)
        if not self.cap.isOpened():
            raise RuntimeError(
                f"Could not open camera index {index}. "
                f"Check `ls /dev/video*` and that no other process is using it."
            )

        ok, frame = self.cap.read()
        if not ok:
            raise RuntimeError("Camera opened but failed to read an initial frame.")

        self._lock = threading.Lock()
        self._frame = frame
        self._running = False
        self._thread = None

    def start(self):
        self._running = True
        self._thread = threading.Thread(target=self._update, daemon=True)
        self._thread.start()
        return self

    def _update(self):
        while self._running:
            ok, frame = self.cap.read()
            if not ok:
                time.sleep(0.05)
                continue
            with self._lock:
                self._frame = frame

    def read(self):
        with self._lock:
            return None if self._frame is None else self._frame.copy()

    def stop(self):
        self._running = False
        if self._thread is not None:
            self._thread.join(timeout=1.0)
        self.cap.release()
