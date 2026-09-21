from gpiozero import AngularServo


class TiltAxis:
    """Small hobby servo (SG90/MG90S-class) driving the tilt (up/down) axis."""

    def __init__(self, pin, min_angle=30, max_angle=150, center_angle=90,
                 min_pulse_width=0.0005, max_pulse_width=0.0025, pin_factory=None):
        self.min_angle = min_angle
        self.max_angle = max_angle
        self._servo = AngularServo(
            pin,
            min_angle=min_angle,
            max_angle=max_angle,
            min_pulse_width=min_pulse_width,
            max_pulse_width=max_pulse_width,
            pin_factory=pin_factory,
        )
        self._angle = max(min_angle, min(max_angle, center_angle))
        self._servo.angle = self._angle

    @property
    def angle(self):
        return self._angle

    def set_angle(self, angle):
        self._angle = max(self.min_angle, min(self.max_angle, angle))
        self._servo.angle = self._angle
        return self._angle

    def nudge(self, delta):
        return self.set_angle(self._angle + delta)
