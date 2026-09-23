/*
 * Базовые DSP-примитивы: резонаторы Клатта, БПФ, передискретизация,
 * генератор случайных чисел, кодирование WAV.
 * Никаких нейросетей — только классическая цифровая обработка сигналов.
 */
(function (g) {
  'use strict';
  const VS = g.VoiceSynth = g.VoiceSynth || {};
  const DSP = VS.DSP = {};

  DSP.dbToLin = (db) => Math.pow(10, db / 20);
  DSP.linToDb = (x) => 20 * Math.log10(Math.max(x, 1e-12));
  DSP.clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
  DSP.lerp = (a, b, k) => a + (b - a) * k;

  // Детерминированный ГПСЧ (mulberry32), чтобы синтез был воспроизводимым.
  DSP.rng = function (seed) {
    let s = seed >>> 0;
    const next = function () {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    next.gauss = function () {
      const u = Math.max(next(), 1e-9);
      const v = next();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };
    return next;
  };

  // Двухполюсный резонатор Клатта: y = A*x + B*y1 + C*y2 (единичное усиление на 0 Гц).
  class Resonator {
    constructor() { this.a = 1; this.b = 0; this.c = 0; this.y1 = 0; this.y2 = 0; this.gain = 1; }
    set(f, bw, fs) {
      const r = Math.exp(-Math.PI * bw / fs);
      this.c = -r * r;
      this.b = 2 * r * Math.cos(2 * Math.PI * f / fs);
      this.a = 1 - this.b - this.c;
      this.gain = 1;
      return this;
    }
    // Полосовой вариант с единичным усилением на центральной частоте.
    setPeak(f, bw, fs) {
      this.set(f, bw, fs);
      const w = 2 * Math.PI * f / fs;
      const re = 1 - this.b * Math.cos(w) - this.c * Math.cos(2 * w);
      const im = this.b * Math.sin(w) + this.c * Math.sin(2 * w);
      const mag = Math.abs(this.a) / Math.sqrt(re * re + im * im);
      this.gain = 1 / Math.max(mag, 1e-9);
      return this;
    }
    step(x) {
      const y = this.a * x + this.b * this.y1 + this.c * this.y2;
      this.y2 = this.y1;
      this.y1 = y;
      return y * this.gain;
    }
    reset() { this.y1 = this.y2 = 0; }
  }
  DSP.Resonator = Resonator;

  // Антирезонатор (нуль передаточной функции) — для носовых.
  class AntiResonator {
    constructor() { this.a0 = 1; this.a1 = 0; this.a2 = 0; this.x1 = 0; this.x2 = 0; }
    set(f, bw, fs) {
      const r = Math.exp(-Math.PI * bw / fs);
      const c = -r * r;
      const b = 2 * r * Math.cos(2 * Math.PI * f / fs);
      const a = 1 - b - c;
      this.a0 = 1 / a;
      this.a1 = -b / a;
      this.a2 = -c / a;
      return this;
    }
    step(x) {
      const y = this.a0 * x + this.a1 * this.x1 + this.a2 * this.x2;
      this.x2 = this.x1;
      this.x1 = x;
      return y;
    }
  }
  DSP.AntiResonator = AntiResonator;

  // Итеративное БПФ по основанию 2 (на месте).
  DSP.fft = function (re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const ar = re[i + k + len / 2], ai = im[i + k + len / 2];
          const tr = ar * cr - ai * ci, ti = ar * ci + ai * cr;
          re[i + k + len / 2] = re[i + k] - tr;
          im[i + k + len / 2] = im[i + k] - ti;
          re[i + k] += tr;
          im[i + k] += ti;
          const ncr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr;
          cr = ncr;
        }
      }
    }
  };

  // Передискретизация: ФНЧ (окно Блэкмана, sinc) + линейная интерполяция.
  DSP.resample = function (x, fsIn, fsOut) {
    if (fsIn === fsOut) return Float32Array.from(x);
    let src = x;
    if (fsOut < fsIn) {
      const fc = 0.45 * fsOut / fsIn;
      const taps = 63, half = (taps - 1) / 2;
      const h = new Float32Array(taps);
      let sum = 0;
      for (let i = 0; i < taps; i++) {
        const m = i - half;
        const sinc = m === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * m) / (Math.PI * m);
        const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / (taps - 1)) + 0.08 * Math.cos(4 * Math.PI * i / (taps - 1));
        h[i] = sinc * w;
        sum += h[i];
      }
      for (let i = 0; i < taps; i++) h[i] /= sum;
      src = new Float32Array(x.length);
      for (let n = 0; n < x.length; n++) {
        let acc = 0;
        for (let k = 0; k < taps; k++) {
          const idx = n + k - half;
          if (idx >= 0 && idx < x.length) acc += h[k] * x[idx];
        }
        src[n] = acc;
      }
    }
    const outLen = Math.floor(x.length * fsOut / fsIn);
    const out = new Float32Array(outLen);
    const step = fsIn / fsOut;
    for (let i = 0; i < outLen; i++) {
      const pos = i * step;
      const i0 = Math.floor(pos);
      const fr = pos - i0;
      const a = src[i0] || 0;
      const b = i0 + 1 < src.length ? src[i0 + 1] : a;
      out[i] = a + (b - a) * fr;
    }
    return out;
  };

  DSP.rms = function (x, from, to) {
    from = from || 0;
    to = to === undefined ? x.length : to;
    let s = 0;
    for (let i = from; i < to; i++) s += x[i] * x[i];
    return Math.sqrt(s / Math.max(1, to - from));
  };

  DSP.median = function (arr) {
    if (!arr.length) return NaN;
    const a = Array.from(arr).sort((p, q) => p - q);
    const m = a.length >> 1;
    return a.length % 2 ? a[m] : 0.5 * (a[m - 1] + a[m]);
  };

  DSP.percentile = function (arr, p) {
    if (!arr.length) return NaN;
    const a = Array.from(arr).sort((x, y) => x - y);
    const idx = DSP.clamp(Math.round((a.length - 1) * p), 0, a.length - 1);
    return a[idx];
  };

  // Кодирование моно 16-бит PCM WAV.
  DSP.encodeWav = function (samples, fs) {
    const n = samples.length;
    const buf = new ArrayBuffer(44 + n * 2);
    const v = new DataView(buf);
    const str = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, fs, true); v.setUint32(28, fs * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) {
      const s = DSP.clamp(samples[i], -1, 1);
      v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return buf;
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = VS;
})(typeof globalThis !== 'undefined' ? globalThis : this);
