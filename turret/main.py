import atexit
import logging
import sys

from app.camera import CameraStream
from app.config import load_config
from app.detector import PersonDetector
from app.model_fetch import ensure_model_weights
from app.motion.servo import TiltAxis
from app.motion.stepper import StepperAxis
from app.motion.trigger import Trigger
from app.pid import PID
from app.tracking import TrackingController
from app.web.server import create_app

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s"
)
logger = logging.getLogger("turret.main")


def build_pin_factory(name):
    if name == "pigpio":
        try:
            from gpiozero.pins.pigpio import PIGPIOFactory
            return PIGPIOFactory()
        except Exception as exc:
            logger.warning(
                "фабрика пинов pigpio недоступна (%s); использую бэкенд gpiozero "
                "по умолчанию. Для более плавной работы сервы/шаговика запустите: "
                "sudo apt install pigpio && sudo systemctl enable --now pigpiod",
                exc,
            )
    return None


def main():
    cfg = load_config("config.yaml")
    pin_factory = build_pin_factory(cfg.gpio.pin_factory)

    camera = CameraStream(
        index=cfg.camera.index, width=cfg.camera.width,
        height=cfg.camera.height, fps=cfg.camera.fps,
    ).start()

    weights_ready = ensure_model_weights(
        prototxt_path=cfg.detection.prototxt,
        model_path=cfg.detection.model,
        prototxt_url=cfg.detection.prototxt_url,
        model_url=cfg.detection.model_url,
        timeout=cfg.detection.download_timeout_seconds,
    )

    detector = None
    if weights_ready:
        try:
            detector = PersonDetector(
                prototxt=cfg.detection.prototxt,
                model=cfg.detection.model,
                confidence_threshold=cfg.detection.confidence_threshold,
                resize=cfg.detection.resize,
            )
        except Exception as exc:
            logger.warning(
                "файлы весов есть, но модель не загрузилась (%s) - либо файл "
                "повреждён, либо несовместимая версия OpenCV (нужен cv2.dnn."
                "readNetFromCaffe, см. комментарий в requirements.txt); "
                "турель запускается в РУЧНОМ режиме",
                exc,
            )
            detector = None

    if detector is None:
        logger.warning("детектор недоступен - доступно только ручное управление (AUTO отключен)")

    pan_axis = StepperAxis(
        step_pin=cfg.gpio.stepper.step_pin,
        dir_pin=cfg.gpio.stepper.dir_pin,
        enable_pin=cfg.gpio.stepper.enable_pin,
        enable_active_low=cfg.gpio.stepper.enable_active_low,
        min_steps_per_sec=cfg.gpio.stepper.min_steps_per_sec,
        max_steps_per_sec=cfg.gpio.stepper.max_steps_per_sec,
        soft_limit_steps=cfg.gpio.stepper.soft_limit_steps,
        pin_factory=pin_factory,
    ).start()

    tilt_axis = TiltAxis(
        pin=cfg.gpio.servo.pin,
        min_angle=cfg.gpio.servo.min_angle,
        max_angle=cfg.gpio.servo.max_angle,
        center_angle=cfg.gpio.servo.center_angle,
        min_pulse_width=cfg.gpio.servo.min_pulse_width,
        max_pulse_width=cfg.gpio.servo.max_pulse_width,
        pin_factory=pin_factory,
    )

    trigger = Trigger(
        pin=cfg.gpio.trigger.pin,
        active_high=cfg.gpio.trigger.active_high,
        fire_duration_ms=cfg.gpio.trigger.fire_duration_ms,
        cooldown_ms=cfg.gpio.trigger.cooldown_ms,
        burst_count=cfg.gpio.trigger.burst_count,
        burst_interval_ms=cfg.gpio.trigger.burst_interval_ms,
        max_continuous_fire_seconds=cfg.safety.max_continuous_fire_seconds,
        pin_factory=pin_factory,
    )
    if cfg.safety.start_armed:
        trigger.arm()

    pan_pid = PID(
        cfg.tracking.pan_kp, cfg.tracking.pan_ki, cfg.tracking.pan_kd,
        output_limit=cfg.gpio.stepper.max_steps_per_sec,
    )
    tilt_pid = PID(
        cfg.tracking.tilt_kp, cfg.tracking.tilt_ki, cfg.tracking.tilt_kd,
        output_limit=cfg.tracking.tilt_max_deg_per_frame,
    )

    controller = TrackingController(
        camera=camera, detector=detector, pan_axis=pan_axis, tilt_axis=tilt_axis,
        trigger=trigger, pan_pid=pan_pid, tilt_pid=tilt_pid,
        lock_threshold_px=cfg.tracking.lock_threshold_px,
        lock_frames_required=cfg.tracking.lock_frames_required,
        auto_fire_enabled=cfg.safety.auto_fire_enabled,
    ).start()

    def shutdown():
        logger.info("Завершение работы...")
        controller.stop()
        pan_axis.stop()
        trigger.emergency_stop()
        camera.stop()

    atexit.register(shutdown)

    app = create_app(controller, trigger, pan_axis, tilt_axis, cfg.gpio.servo.center_angle)
    app.run(host=cfg.web.host, port=cfg.web.port, threaded=True)


if __name__ == "__main__":
    sys.exit(main() or 0)
