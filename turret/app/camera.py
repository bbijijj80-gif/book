import threading
import time

import cv2


class CameraStream:
    """Потоковый читатель кадров с USB (UVC) веб-камеры: захват идёт в
    отдельном потоке, чтобы медленный cv2.VideoCapture.read() не тормозил
    цикл детекции и управления."""

    def __init__(self, index=0, width=640, height=480, fps=30):
        self.cap = cv2.VideoCapture(index)
        self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
        self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
        self.cap.set(cv2.CAP_PROP_FPS, fps)
        if not self.cap.isOpened():
            raise RuntimeError(
                f"Не удалось открыть камеру с индексом {index}. "
                f"Проверьте `ls /dev/video*` и что камера не занята другим процессом."
            )

        ok, frame = self.cap.read()
        if not ok:
            raise RuntimeError("Камера открылась, но не удалось прочитать первый кадр.")

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
