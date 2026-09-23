/*
 * Системные голоса-заготовки и хранилище пользовательских голосов.
 *
 * Параметры голоса:
 *  f0       — средняя высота тона, Гц
 *  range    — множитель мелодического диапазона (выразительность интонации)
 *  scale    — масштаб формант (≈ обратная длина речевого тракта): 1 — мужчина, ~1.17 — женщина, ~1.3 — ребёнок
 *  formants — (необязательно) измеренные F1–F3 гласных а, о, у, э, и, ы
 *  tilt     — наклон спектра источника (0 — звонкий/яркий, 0.9 — мягкий/глухой)
 *  oq       — открытая фаза голосовой щели (больше — мягче, «воздушнее»)
 *  breath   — придыхание, jitter/shimmer — естественная нестабильность, rate — темп
 */
(function (g) {
  'use strict';
  const VS = g.VoiceSynth = g.VoiceSynth || {};

  const PRESETS = [
    { id: 'alexey', name: 'Алексей', desc: 'мужской, средний', f0: 112, range: 1.0, scale: 1.0, tilt: 0.3, oq: 0.5, breath: 0.03, jitter: 0.006, shimmer: 0.03, rate: 1.0 },
    { id: 'maria', name: 'Мария', desc: 'женский, мягкий', f0: 205, range: 1.15, scale: 1.17, tilt: 0.45, oq: 0.65, breath: 0.08, jitter: 0.005, shimmer: 0.025, rate: 1.03 },
    { id: 'boris', name: 'Борис', desc: 'низкий бас', f0: 80, range: 0.85, scale: 0.92, tilt: 0.25, oq: 0.45, breath: 0.025, jitter: 0.008, shimmer: 0.04, rate: 0.9 },
    { id: 'nika', name: 'Ника', desc: 'детский, звонкий', f0: 285, range: 1.3, scale: 1.3, tilt: 0.35, oq: 0.6, breath: 0.05, jitter: 0.007, shimmer: 0.03, rate: 1.08 },
    { id: 'olga', name: 'Ольга', desc: 'дикторский, спокойный', f0: 175, range: 0.9, scale: 1.12, tilt: 0.4, oq: 0.6, breath: 0.04, jitter: 0.004, shimmer: 0.02, rate: 0.95 },
  ];

  const KEY = 'voiceSynth.customVoices.v1';

  function safeGet() {
    try {
      const raw = g.localStorage && g.localStorage.getItem(KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }
  function safeSet(arr) {
    try { g.localStorage && g.localStorage.setItem(KEY, JSON.stringify(arr)); return true; } catch (e) { return false; }
  }

  const Voices = {
    PRESETS,
    listCustom() { return safeGet(); },
    all() { return PRESETS.concat(safeGet()); },
    get(id) { return this.all().find((v) => v.id === id) || PRESETS[0]; },
    saveCustom(v) {
      const arr = safeGet().filter((x) => x.id !== v.id);
      arr.push(v);
      return safeSet(arr);
    },
    removeCustom(id) { return safeSet(safeGet().filter((x) => x.id !== id)); },
    validate(v) {
      if (!v || typeof v !== 'object') return null;
      const num = (x, lo, hi, d) => (typeof x === 'number' && isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d);
      const out = {
        id: typeof v.id === 'string' ? v.id.slice(0, 64) : 'custom-' + Date.now(),
        name: String(v.name || 'Мой голос').slice(0, 60),
        desc: String(v.desc || 'пользовательский').slice(0, 80),
        custom: true,
        f0: num(v.f0, 50, 500, 120), range: num(v.range, 0.3, 2.5, 1), scale: num(v.scale, 0.75, 1.5, 1),
        tilt: num(v.tilt, 0, 0.92, 0.35), oq: num(v.oq, 0.3, 0.85, 0.55), breath: num(v.breath, 0, 0.3, 0.03),
        jitter: num(v.jitter, 0, 0.05, 0.006), shimmer: num(v.shimmer, 0, 0.15, 0.03), rate: num(v.rate, 0.5, 1.8, 1),
        created: v.created || new Date().toISOString(),
      };
      if (v.formants && typeof v.formants === 'object') {
        out.formants = {};
        ['a', 'o', 'u', 'e', 'i', 'y'].forEach((k) => {
          const f = v.formants[k];
          if (Array.isArray(f) && f.length >= 3 && f.every((x) => typeof x === 'number' && x > 100 && x < 5000)) out.formants[k] = f.slice(0, 3);
        });
      }
      if (v.stats) out.stats = v.stats;
      return out;
    },
  };

  VS.Voices = Voices;

  if (typeof module !== 'undefined' && module.exports) module.exports = VS;
})(typeof globalThis !== 'undefined' ? globalThis : this);
