import threading
import time

import cv2


class TrackingController:
    def __init__(self, camera, detector, pan_axis, tilt_axis, trigger,
                 pan_pid, tilt_pid, lock_threshold_px=28, lock_frames_required=4,
                 auto_fire_enabled=True):
        self.camera = camera
        self.detector = detector
        self.pan_axis = pan_axis
        self.tilt_axis = tilt_axis
        self.trigger = trigger
        self.pan_pid = pan_pid
        self.tilt_pid = tilt_pid
        self.lock_threshold_px = lock_threshold_px
        self.lock_frames_required = lock_frames_required
        self.auto_fire_enabled = auto_fire_enabled

        self.mode = "auto"  # допустимые значения: "auto" | "manual" (как в веб-API)
        self._lock_streak = 0
        self._running = False
        self._thread = None

        self._state_lock = threading.Lock()
        self._latest_frame = None
        self._status = {
            "fps": 0.0,
            "targets": 0,
            "locked": False,
            "pan_position": 0,
            "tilt_angle": tilt_axis.angle,
            "armed": trigger.armed,
            "mode": self.mode,
        }

    def start(self):
        self._running = True
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
        return self

    def stop(self):
        self._running = False
        if self._thread is not None:
            self._thread.join(timeout=1.0)

    def set_mode(self, mode):
        if mode not in ("auto", "manual"):
            raise ValueError("mode must be 'auto' or 'manual'")
        self.mode = mode
        if mode == "manual":
            self.pan_axis.set_speed(0)
        else:
            self.pan_pid.reset()
            self.tilt_pid.reset()
        self._lock_streak = 0

    def manual_move(self, pan_speed, tilt_delta):
        if self.mode != "manual":
            return
        self.pan_axis.set_speed(pan_speed)
        self.tilt_axis.nudge(tilt_delta)

    def get_frame_jpeg(self):
        with self._state_lock:
            frame = None if self._latest_frame is None else self._latest_frame.copy()
        if frame is None:
            return None
        ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
        return buf.tobytes() if ok else None

    def get_status(self):
        with self._state_lock:
            return dict(self._status)

    def _run(self):
        frame_times = []
        while self._running:
            frame = self.camera.read()
            if frame is None:
                time.sleep(0.01)
                continue

            t0 = time.monotonic()
            h, w = frame.shape[:2]
            cx, cy = w // 2, h // 2

            detections = []
            target = None
            locked = False

            if self.mode == "auto":
                detections = self.detector.detect(frame)
                if detections:
                    target = max(detections, key=lambda d: d.area)

                if target is not None:
                    tx, ty = target.center
                    err_x = tx - cx
                    err_y = ty - cy

                    pan_cmd = self.pan_pid.update(err_x)
                    tilt_cmd = self.tilt_pid.update(-err_y)  # ось Y кадра растёт вниз - знак инвертирован

                    self.pan_axis.set_speed(pan_cmd)
                    self.tilt_axis.nudge(tilt_cmd)

                    if abs(err_x) <= self.lock_threshold_px and abs(err_y) <= self.lock_threshold_px:
                        self._lock_streak += 1
                    else:
                        self._lock_streak = 0
                    locked = self._lock_streak >= self.lock_frames_required

                    if locked and self.auto_fire_enabled and self.trigger.ready():
                        threading.Thread(
                            target=self.trigger.fire, kwargs={"reason": "авто"}, daemon=True
                        ).start()
                else:
                    self.pan_axis.set_speed(0)
                    self.pan_pid.reset()
                    self.tilt_pid.reset()
                    self._lock_streak = 0

            self._draw_hud(frame, cx, cy, detections, target, locked)

            frame_times.append(t0)
            frame_times = [t for t in frame_times if t0 - t < 1.0]

            with self._state_lock:
                self._latest_frame = frame
                self._status.update({
                    "fps": round(float(len(frame_times)), 1),
                    "targets": len(detections),
                    "locked": locked,
                    "pan_position": self.pan_axis.position,
                    "tilt_angle": round(self.tilt_axis.angle, 1),
                    "armed": self.trigger.armed,
                    "mode": self.mode,
                })

    def _draw_hud(self, frame, cx, cy, detections, target, locked):
        # Подписи рисуются встроенным шрифтом OpenCV (Hershey), который не
        # поддерживает кириллицу, поэтому "LOCK" намеренно остаётся латиницей.
        # Русский текст интерфейса - в HTML/JS (там это обычный текст браузера).
        for d in detections:
            color = (0, 220, 0) if d is target else (90, 90, 90)
            cv2.rectangle(frame, (d.x1, d.y1), (d.x2, d.y2), color, 2)
            cv2.putText(frame, f"{d.confidence:.2f}", (d.x1, max(0, d.y1 - 6)),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 1, cv2.LINE_AA)

        crosshair_color = (0, 0, 255) if locked else (0, 200, 255)
        cv2.drawMarker(frame, (cx, cy), crosshair_color, cv2.MARKER_CROSS, 24, 2)
        cv2.circle(frame, (cx, cy), self.lock_threshold_px, crosshair_color, 1)

        if locked:
            cv2.putText(frame, "LOCK", (cx + 16, cy - 16), cv2.FONT_HERSHEY_SIMPLEX,
                        0.7, (0, 0, 255), 2, cv2.LINE_AA)
