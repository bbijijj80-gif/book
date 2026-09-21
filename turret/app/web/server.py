import threading
import time

from flask import Flask, Response, jsonify, render_template, request


def create_app(controller, trigger, pan_axis, tilt_axis, tilt_center_angle):
    app = Flask(__name__)

    @app.route("/")
    def index():
        return render_template("index.html")

    @app.route("/video_feed")
    def video_feed():
        def generate():
            while True:
                jpeg = controller.get_frame_jpeg()
                if jpeg is not None:
                    yield (b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + jpeg + b"\r\n")
                time.sleep(0.03)

        return Response(generate(), mimetype="multipart/x-mixed-replace; boundary=frame")

    @app.route("/api/status")
    def status():
        return jsonify(controller.get_status())

    @app.route("/api/arm", methods=["POST"])
    def arm():
        want_armed = bool((request.get_json(force=True) or {}).get("armed"))
        trigger.arm() if want_armed else trigger.disarm()
        return jsonify({"armed": trigger.armed})

    @app.route("/api/mode", methods=["POST"])
    def mode():
        new_mode = (request.get_json(force=True) or {}).get("mode")
        if new_mode not in ("auto", "manual"):
            return jsonify({"error": "mode must be 'auto' or 'manual'"}), 400
        controller.set_mode(new_mode)
        return jsonify({"mode": controller.mode})

    @app.route("/api/manual_move", methods=["POST"])
    def manual_move():
        data = request.get_json(force=True) or {}
        controller.manual_move(float(data.get("pan", 0)), float(data.get("tilt", 0)))
        return jsonify({"ok": True})

    @app.route("/api/fire", methods=["POST"])
    def fire():
        if not trigger.armed:
            return jsonify({"ok": False, "reason": "disarmed"}), 409
        if not trigger.ready():
            return jsonify({"ok": False, "reason": "cooldown"}), 409
        threading.Thread(target=trigger.fire, kwargs={"reason": "ручной"}, daemon=True).start()
        return jsonify({"ok": True})

    @app.route("/api/center", methods=["POST"])
    def center():
        pan_axis.set_speed(0)
        pan_axis.set_center()
        tilt_axis.set_angle(tilt_center_angle)
        return jsonify({"ok": True})

    @app.route("/api/emergency_stop", methods=["POST"])
    def emergency_stop():
        pan_axis.set_speed(0)
        trigger.emergency_stop()
        controller.set_mode("manual")
        return jsonify({"ok": True})

    return app
