import time


class PID:
    def __init__(self, kp, ki, kd, output_limit=None):
        self.kp, self.ki, self.kd = kp, ki, kd
        self.output_limit = output_limit
        self._integral = 0.0
        self._prev_error = 0.0
        self._prev_time = None

    def reset(self):
        self._integral = 0.0
        self._prev_error = 0.0
        self._prev_time = None

    def update(self, error):
        now = time.monotonic()
        dt = (now - self._prev_time) if self._prev_time else 0.0
        self._prev_time = now

        self._integral += error * dt
        derivative = (error - self._prev_error) / dt if dt > 0 else 0.0
        self._prev_error = error

        output = self.kp * error + self.ki * self._integral + self.kd * derivative
        if self.output_limit is not None:
            output = max(-self.output_limit, min(self.output_limit, output))
        return output
