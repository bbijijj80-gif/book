(() => {
  const els = {
    connDot: document.getElementById("conn-dot"),
    fps: document.getElementById("fps"),
    targets: document.getElementById("targets"),
    panPos: document.getElementById("pan-pos"),
    tiltAngle: document.getElementById("tilt-angle"),
    videoWrap: document.getElementById("video-wrap"),
    lockBanner: document.getElementById("lock-banner"),
    armToggle: document.getElementById("arm-toggle"),
    armLabel: document.getElementById("arm-label"),
    modeToggle: document.getElementById("mode-toggle"),
    noDetectorHint: document.getElementById("no-detector-hint"),
    joystick: document.getElementById("joystick"),
    joystickKnob: document.getElementById("joystick-knob"),
    btnCenter: document.getElementById("btn-center"),
    btnFire: document.getElementById("btn-fire"),
    btnEstop: document.getElementById("btn-estop"),
  };

  let armed = false;
  let mode = "auto";
  let detectionAvailable = true;

  async function postJSON(url, body) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
      });
      return res.ok ? await res.json().catch(() => ({})) : null;
    } catch (err) {
      return null;
    }
  }

  function applyMode(newMode) {
    mode = newMode;
    for (const btn of els.modeToggle.querySelectorAll(".seg")) {
      btn.classList.toggle("active", btn.dataset.mode === mode);
    }
    els.joystick.classList.toggle("active", mode === "manual");
  }

  function applyArmed(newArmed) {
    armed = newArmed;
    els.armToggle.classList.toggle("armed", armed);
    els.armToggle.classList.toggle("safe", !armed);
    els.armLabel.textContent = armed ? "ВЗВЕДЕНО" : "НЕ ВЗВЕДЕНО";
    els.btnFire.disabled = !armed;
  }

  function applyDetectionAvailable(available) {
    detectionAvailable = available;
    const autoBtn = els.modeToggle.querySelector('[data-mode="auto"]');
    autoBtn.disabled = !available;
    els.noDetectorHint.style.display = available ? "none" : "block";
  }

  async function refreshStatus() {
    try {
      const res = await fetch("/api/status");
      if (!res.ok) throw new Error("bad status");
      const s = await res.json();
      els.connDot.classList.remove("offline");
      els.fps.textContent = s.fps ?? "--";
      els.targets.textContent = s.targets ?? "--";
      els.panPos.textContent = s.pan_position ?? "--";
      els.tiltAngle.textContent = s.tilt_angle ?? "--";
      els.videoWrap.classList.toggle("locked", !!s.locked);
      els.lockBanner.classList.toggle("show", !!s.locked);
      if (typeof s.armed === "boolean" && s.armed !== armed) applyArmed(s.armed);
      if (typeof s.mode === "string" && s.mode !== mode) applyMode(s.mode);
      if (typeof s.detection_available === "boolean" && s.detection_available !== detectionAvailable) {
        applyDetectionAvailable(s.detection_available);
      }
    } catch (err) {
      els.connDot.classList.add("offline");
    }
  }
  setInterval(refreshStatus, 700);
  refreshStatus();

  els.armToggle.addEventListener("click", async () => {
    const next = !armed;
    if (next && !confirm("Перевести турель во взведённое состояние? Она сможет стрелять автоматически.")) {
      return;
    }
    const res = await postJSON("/api/arm", { armed: next });
    if (res) applyArmed(!!res.armed);
  });

  els.modeToggle.addEventListener("click", async (e) => {
    const btn = e.target.closest(".seg");
    if (!btn) return;
    const res = await postJSON("/api/mode", { mode: btn.dataset.mode });
    if (res) applyMode(res.mode);
  });

  els.btnCenter.addEventListener("click", () => postJSON("/api/center"));

  els.btnFire.addEventListener("click", () => {
    if (!armed) return;
    postJSON("/api/fire");
  });

  els.btnEstop.addEventListener("click", () => {
    postJSON("/api/emergency_stop");
    applyArmed(false);
    applyMode("manual");
  });

  // Джойстик: перетаскивание отправляет команды ручного наведения (азимут/наклон).
  let dragging = false;
  let sendTimer = null;
  const MAX_PAN_SPEED = 500;
  const MAX_TILT_STEP = 2.5;

  function knobPosition(clientX, clientY) {
    const rect = els.joystick.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const r = rect.width / 2;
    let dx = (clientX - cx) / r;
    let dy = (clientY - cy) / r;
    const mag = Math.hypot(dx, dy);
    if (mag > 1) { dx /= mag; dy /= mag; }
    return { dx, dy };
  }

  function setKnob(dx, dy) {
    els.joystickKnob.style.left = `${33 + dx * 25}%`;
    els.joystickKnob.style.top = `${33 + dy * 25}%`;
  }

  function resetKnob() {
    setKnob(0, 0);
  }

  function startDrag(clientX, clientY) {
    if (mode !== "manual") return;
    dragging = true;
    handleDrag(clientX, clientY);
  }

  function handleDrag(clientX, clientY) {
    if (!dragging) return;
    const { dx, dy } = knobPosition(clientX, clientY);
    setKnob(dx, dy);
    clearTimeout(sendTimer);
    sendTimer = setTimeout(() => {
      postJSON("/api/manual_move", {
        pan: dx * MAX_PAN_SPEED,
        tilt: -dy * MAX_TILT_STEP,
      });
    }, 60);
  }

  function endDrag() {
    if (!dragging) return;
    dragging = false;
    resetKnob();
    postJSON("/api/manual_move", { pan: 0, tilt: 0 });
  }

  els.joystick.addEventListener("pointerdown", (e) => {
    els.joystick.setPointerCapture(e.pointerId);
    startDrag(e.clientX, e.clientY);
  });
  els.joystick.addEventListener("pointermove", (e) => handleDrag(e.clientX, e.clientY));
  els.joystick.addEventListener("pointerup", endDrag);
  els.joystick.addEventListener("pointercancel", endDrag);

  applyMode("auto");
  applyArmed(false);
})();
