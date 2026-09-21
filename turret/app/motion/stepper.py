import threading
import time

from gpiozero import DigitalOutputDevice


class StepperAxis:
    """Velocity-controlled pan axis for a NEMA17 driven through a STEP/DIR
    stepper driver (A4988 / DRV8825 / TMC2209-compatible pinout).

    This bit-bangs STEP pulses from a Python thread, which is precise enough
    to smoothly follow a person at camera-tracking speeds but is not a
    hard-realtime pulse generator - don't expect CNC-grade timing."""

    def __init__(self, step_pin, dir_pin, enable_pin=None, enable_active_low=True,
                 min_steps_per_sec=30, max_steps_per_sec=1000, soft_limit_steps=None,
                 pin_factory=None):
        self._step = DigitalOutputDevice(step_pin, pin_factory=pin_factory)
        self._dir = DigitalOutputDevice(dir_pin, pin_factory=pin_factory)
        self._enable = None
        if enable_pin is not None:
            self._enable = DigitalOutputDevice(
                enable_pin, active_high=not enable_active_low, pin_factory=pin_factory
            )

        self.min_speed = min_steps_per_sec
        self.max_speed = max_steps_per_sec
        self.soft_limit_steps = soft_limit_steps

        self._target_speed = 0.0  # signed steps/sec
        self._position = 0
        self._lock = threading.Lock()
        self._running = False
        self._thread = None

    @property
    def position(self):
        with self._lock:
            return self._position

    def enable(self):
        if self._enable is not None:
            self._enable.on()

    def disable(self):
        if self._enable is not None:
            self._enable.off()

    def set_center(self):
        with self._lock:
            self._position = 0

    def set_speed(self, steps_per_sec):
        with self._lock:
            self._target_speed = steps_per_sec

    def start(self):
        self.enable()
        self._running = True
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
        return self

    def stop(self):
        self._running = False
        self.set_speed(0)
        if self._thread is not None:
            self._thread.join(timeout=1.0)
        self.disable()

    def _run(self):
        while self._running:
            with self._lock:
                speed = self._target_speed
                pos = self._position

            magnitude = min(abs(speed), self.max_speed)
            if magnitude < self.min_speed:
                time.sleep(0.02)
                continue

            direction = speed > 0
            if self.soft_limit_steps is not None:
                if (direction and pos >= self.soft_limit_steps) or \
                        (not direction and pos <= -self.soft_limit_steps):
                    time.sleep(0.02)
                    continue

            self._dir.value = direction
            half_period = 1.0 / (2.0 * magnitude)

            self._step.on()
            time.sleep(half_period)
            self._step.off()
            time.sleep(half_period)

            with self._lock:
                self._position += 1 if direction else -1
