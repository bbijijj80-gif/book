import logging
import threading
import time

from gpiozero import DigitalOutputDevice

logger = logging.getLogger("turret.trigger")


class Trigger:
    """Drives a relay/MOSFET module wired into the Nerf blaster's trigger
    circuit. Starts disarmed; call arm() explicitly (the web UI's ARM switch
    does this) before fire() will do anything."""

    def __init__(self, pin, active_high=True, fire_duration_ms=250,
                 cooldown_ms=900, burst_count=1, burst_interval_ms=180,
                 max_continuous_fire_seconds=4, pin_factory=None):
        self._out = DigitalOutputDevice(
            pin, active_high=active_high, initial_value=False, pin_factory=pin_factory
        )

        self.fire_duration = fire_duration_ms / 1000.0
        self.cooldown = cooldown_ms / 1000.0
        self.burst_count = max(1, burst_count)
        self.burst_interval = burst_interval_ms / 1000.0
        self.max_continuous_fire_seconds = max_continuous_fire_seconds

        self._armed = False
        self._lock = threading.Lock()
        self._last_fire_end = 0.0

    @property
    def armed(self):
        return self._armed

    def arm(self):
        self._armed = True
        logger.info("ARMED")

    def disarm(self):
        self._armed = False
        logger.info("DISARMED")

    def ready(self):
        return self._armed and (time.monotonic() - self._last_fire_end) >= self.cooldown

    def fire(self, reason="manual"):
        """Blocking burst fire - call from a worker thread, never from the
        video/control loop, since it sleeps for the shot duration."""
        if not self._lock.acquire(blocking=False):
            return False
        try:
            if not self._armed:
                return False
            if (time.monotonic() - self._last_fire_end) < self.cooldown:
                return False

            logger.info("fire burst start reason=%s shots=%d", reason, self.burst_count)
            started_at = time.monotonic()
            for shot in range(self.burst_count):
                if not self._armed:
                    break
                if time.monotonic() - started_at > self.max_continuous_fire_seconds:
                    logger.warning("fire burst aborted: max_continuous_fire_seconds exceeded")
                    break
                self._out.on()
                time.sleep(self.fire_duration)
                self._out.off()
                if shot < self.burst_count - 1:
                    time.sleep(self.burst_interval)

            self._last_fire_end = time.monotonic()
            return True
        finally:
            self._lock.release()

    def emergency_stop(self):
        self._out.off()
        self._armed = False
        logger.warning("EMERGENCY STOP")
