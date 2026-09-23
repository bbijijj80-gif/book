/*
 * Анализ записанного голоса — классическая обработка сигналов, без нейросетей:
 *  - уровень фонового шума (проверка «тихого места»);
 *  - частота основного тона (алгоритм YIN) → средняя высота, диапазон, джиттер;
 *  - форманты гласных (линейное предсказание, LPC) → длина речевого тракта, тембр;
 *  - наклон спектра (LTAS) и апериодичность → яркость/мягкость, придыхание;
 *  - темп речи по известному тексту фразы.
 * Там, где нужна привязка к шкалам синтезатора, используется «анализ через синтез»:
 * синтезатор произносит ту же фразу, и параметры подбираются так, чтобы измерения совпали.
 */
(function (g) {
  'use strict';
  const VS = g.VoiceSynth = g.VoiceSynth || {};
  const DSP = VS.DSP;

  const FS_P = 16000;
  const FS_L = 11025;
  const HOP_MS = 10;

  // ---------- Энергия ----------
  function energyTrack(x, fs, winMs) {
    const hop = Math.round(fs * HOP_MS / 1000);
    const win = Math.round(fs * (winMs || 25) / 1000);
    const n = Math.max(0, Math.floor((x.length - win) / hop) + 1);
    const db = new Float32Array(n);
    for (let i = 0; i < n; i++) db[i] = DSP.linToDb(DSP.rms(x, i * hop, i * hop + win));
    return db;
  }

  // ---------- YIN ----------
  function makeYin(fmin, fmax) {
    const W = Math.round(FS_P * 0.02);
    const tauMin = Math.floor(FS_P / fmax), tauMax = Math.ceil(FS_P / fmin);
    const d = new Float32Array(tauMax + 2), c = new Float32Array(tauMax + 2);
    const frame = function (x16, st) {
      for (let tau = 1; tau <= tauMax + 1; tau++) {
        let s = 0;
        for (let j = 0; j < W; j++) { const df = x16[st + j] - x16[st + j + tau]; s += df * df; }
        d[tau] = s;
      }
      let run = 0;
      c[0] = 1;
      for (let tau = 1; tau <= tauMax + 1; tau++) { run += d[tau]; c[tau] = run > 0 ? d[tau] * tau / run : 1; }
      let best = -1;
      for (let tau = tauMin; tau <= tauMax; tau++) {
        if (c[tau] < 0.15) { while (tau + 1 <= tauMax && c[tau + 1] < c[tau]) tau++; best = tau; break; }
      }
      if (best < 0) {
        let mv = Infinity;
        for (let tau = tauMin; tau <= tauMax; tau++) if (c[tau] < mv) { mv = c[tau]; best = tau; }
      }
      let tf = best;
      if (best > 1 && best < tauMax + 1) {
        const a = c[best - 1], b = c[best], cc = c[best + 1];
        const den = a - 2 * b + cc;
        if (Math.abs(den) > 1e-9) tf = best + DSP.clamp((a - cc) / (2 * den), -1, 1);
      }
      return { f0: FS_P / tf, ap: c[best] };
    };
    frame.span = W + tauMax + 2;
    return frame;
  }

  function yinTrack(x16, fmin, fmax) {
    const yin = makeYin(fmin || 60, fmax || 500);
    const hop = Math.round(FS_P * HOP_MS / 1000);
    const n = Math.max(0, Math.floor((x16.length - yin.span) / hop) + 1);
    const f0 = new Float32Array(n), ap = new Float32Array(n);
    for (let fi = 0; fi < n; fi++) {
      const r = yin(x16, fi * hop);
      f0[fi] = r.f0;
      ap[fi] = r.ap;
    }
    return { f0, ap };
  }

  // Наклон спектра по громким вокализованным кадрам — одинаковая процедура для записи и для синтеза.
  function voicedTiltDb(x16) {
    const db = energyTrack(x16, FS_P, 25);
    const mx = DSP.percentile(Array.from(db), 0.99);
    const yin = makeYin(60, 500);
    const hop = Math.round(FS_P * HOP_MS / 1000);
    const idx = [];
    for (let i = 0; i < db.length; i++) {
      if (db[i] <= mx - 12 || i * hop + yin.span >= x16.length) continue;
      const r = yin(x16, i * hop);
      if (r.ap < 0.3 && r.f0 >= 60 && r.f0 <= 500) idx.push(i);
    }
    return spectralTilt(x16, idx);
  }

  // ---------- LPC ----------
  function lpc(frame, order) {
    const r = new Float64Array(order + 1);
    for (let k = 0; k <= order; k++) {
      let s = 0;
      for (let i = k; i < frame.length; i++) s += frame[i] * frame[i - k];
      r[k] = s;
    }
    if (r[0] <= 1e-12) return null;
    r[0] *= 1.0001; // небольшая регуляризация
    const a = new Float64Array(order + 1);
    a[0] = 1;
    let err = r[0];
    for (let i = 1; i <= order; i++) {
      let acc = r[i];
      for (let j = 1; j < i; j++) acc += a[j] * r[i - j];
      const k = -acc / err;
      const tmp = a.slice();
      for (let j = 1; j < i; j++) a[j] = tmp[j] + k * tmp[i - j];
      a[i] = k;
      err *= 1 - k * k;
      if (err <= 0) return null;
    }
    return a;
  }

  function lpcPeaks(a, fs) {
    const N = 512;
    const env = new Float64Array(N);
    for (let b = 0; b < N; b++) {
      const w = Math.PI * b / N;
      let re = 0, im = 0;
      for (let k = 0; k < a.length; k++) { re += a[k] * Math.cos(w * k); im -= a[k] * Math.sin(w * k); }
      env[b] = -10 * Math.log10(re * re + im * im + 1e-18);
    }
    const peaks = [];
    for (let b = 1; b < N - 1; b++) {
      if (env[b] > env[b - 1] && env[b] >= env[b + 1]) {
        const y0 = env[b - 1], y1 = env[b], y2 = env[b + 1];
        const den = y0 - 2 * y1 + y2;
        const sh = Math.abs(den) > 1e-9 ? 0.5 * (y0 - y2) / den : 0;
        peaks.push((b + sh) * fs / 2 / N);
      }
    }
    return peaks;
  }

  function pickFormants(peaks) {
    const f = peaks.filter((p) => p > 180);
    const F1 = f.find((p) => p < 1150);
    if (!F1) return null;
    const F2 = f.find((p) => p > F1 + 150 && p < 3200);
    if (!F2) return null;
    const F3 = f.find((p) => p > F2 + 200 && p < 4300);
    if (!F3) return null;
    return [F1, F2, F3];
  }

  // Форманты кадра с центром в момент tMs (сигнал уже в 11025 Гц).
  function formantsAt(x11, tMs) {
    const win = Math.round(FS_L * 0.025);
    const c = Math.round(tMs * FS_L / 1000);
    const st = c - (win >> 1);
    if (st < 1 || st + win >= x11.length) return null;
    const fr = new Float64Array(win);
    for (let i = 0; i < win; i++) {
      const pe = x11[st + i] - 0.97 * x11[st + i - 1];
      fr[i] = pe * (0.54 - 0.46 * Math.cos(2 * Math.PI * i / (win - 1)));
    }
    const a = lpc(fr, 12);
    if (!a) return null;
    return pickFormants(lpcPeaks(a, FS_L));
  }

  // ---------- Наклон спектра (LTAS): энергия 1–4 кГц относительно 0.1–1 кГц ----------
  function spectralTilt(x16, frameIdx) {
    const N = 512;
    const re = new Float64Array(N), im = new Float64Array(N);
    let lo = 0, hi = 0;
    const hop = Math.round(FS_P * HOP_MS / 1000);
    for (const fi of frameIdx) {
      const st = fi * hop;
      if (st + N > x16.length) continue;
      for (let i = 0; i < N; i++) { re[i] = x16[st + i] * (0.54 - 0.46 * Math.cos(2 * Math.PI * i / (N - 1))); im[i] = 0; }
      DSP.fft(re, im);
      for (let b = 1; b < N / 2; b++) {
        const f = b * FS_P / N;
        const p = re[b] * re[b] + im[b] * im[b];
        if (f >= 100 && f < 1000) lo += p;
        else if (f >= 1000 && f < 4000) hi += p;
      }
    }
    return 10 * Math.log10((hi + 1e-12) / (lo + 1e-12));
  }

  // ---------- Проверка тишины ----------
  function measureNoise(x, fs) {
    const db = energyTrack(x, fs, 50);
    if (!db.length) return { medianDb: -100, maxDb: -100, verdict: 'quiet' };
    const skip = Math.min(db.length - 1, 20); // первые 200 мс — щелчок включения микрофона
    const arr = Array.from(db).slice(skip);
    const med = DSP.median(arr), mx = DSP.percentile(arr, 0.98);
    let verdict = 'quiet';
    if (med > -42 || mx > -25) verdict = 'noisy';
    else if (med > -52 || mx > -35) verdict = 'ok';
    return { medianDb: med, maxDb: mx, verdict };
  }

  // Общий разбор записи: высота тона, энергия, вокализованность по кадрам 10 мс.
  function baseAnalysis(x, fs, noiseDb) {
    const x16 = DSP.resample(x, fs, FS_P);
    const db = energyTrack(x16, FS_P, 25);
    const { f0, ap } = yinTrack(x16);
    const n = Math.min(db.length, f0.length);
    const maxDb = DSP.percentile(Array.from(db), 0.99);
    const floor = noiseDb !== undefined && isFinite(noiseDb) ? noiseDb : DSP.percentile(Array.from(db), 0.1);
    const thr = Math.max(floor + 10, maxDb - 40);
    const active = new Uint8Array(n), voiced = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      active[i] = db[i] > thr ? 1 : 0;
      voiced[i] = active[i] && ap[i] < 0.3 && f0[i] >= 60 && f0[i] <= 500 && db[i] > maxDb - 30 ? 1 : 0;
    }
    // исправление октавных ошибок
    const vf = [];
    for (let i = 0; i < n; i++) if (voiced[i]) vf.push(f0[i]);
    const med = DSP.median(vf);
    for (let i = 0; i < n; i++) {
      if (!voiced[i]) continue;
      if (f0[i] > med * 1.8) f0[i] /= 2;
      else if (f0[i] < med * 0.55) f0[i] *= 2;
      if (f0[i] > med * 1.9 || f0[i] < med * 0.5) voiced[i] = 0;
    }
    return { x16, db, f0, ap, n, active, voiced, maxDb, thr };
  }

  function speechDurationMs(active) {
    let first = -1, last = -1;
    for (let i = 0; i < active.length; i++) if (active[i]) { if (first < 0) first = i; last = i; }
    if (first < 0) return 0;
    let dur = (last - first + 1) * HOP_MS;
    let gap = 0;
    for (let i = first; i <= last; i++) {
      if (!active[i]) gap++;
      else { if (gap * HOP_MS >= 200) dur -= gap * HOP_MS; gap = 0; }
    }
    return dur;
  }

  function planSpeechMs(pl) {
    let d = 0;
    for (const u of pl.units) if (!u.pause) d += u.dur;
    return d;
  }

  // Средние F2/F3 по вокализованным кадрам (для масштаба формант без отдельной записи гласных).
  function medianF23(x11, times) {
    const f2 = [], f3 = [];
    for (const t of times) {
      const F = formantsAt(x11, t);
      if (F) { f2.push(F[1]); f3.push(F[2]); }
    }
    return { f2: DSP.median(f2), f3: DSP.median(f3), n: f2.length };
  }

  /*
   * Анализ длинной фразы.
   */
  function analyzePhrase(x, fs, text, opts) {
    opts = opts || {};
    const A = baseAnalysis(x, fs, opts.noiseDb);
    const vIdx = [];
    for (let i = 0; i < A.n; i++) if (A.voiced[i]) vIdx.push(i);
    if (vIdx.length < 40) {
      return { ok: false, error: 'Не удалось выделить голос: речь слишком тихая или короткая. Говорите ближе к микрофону.' };
    }
    const f0s = vIdx.map((i) => A.f0[i]);
    const f0 = DSP.median(f0s);
    const sts = f0s.map((f) => 12 * Math.log2(f / f0));
    const mean = sts.reduce((s, v) => s + v, 0) / sts.length;
    const std = Math.sqrt(sts.reduce((s, v) => s + (v - mean) * (v - mean), 0) / sts.length);
    // «джиттер» по кадрам (грубая оценка нестабильности тона)
    let jsum = 0, jn = 0;
    for (let k = 1; k < vIdx.length; k++) {
      if (vIdx[k] !== vIdx[k - 1] + 1) continue;
      jsum += Math.abs(A.f0[vIdx[k]] - A.f0[vIdx[k - 1]]) / f0; jn++;
    }
    const frameJitter = jn ? jsum / jn : 0.01;
    const apMed = DSP.median(vIdx.map((i) => A.ap[i]));
    const breath = DSP.clamp((apMed - 0.05) * 0.8, 0.01, 0.15);
    let range = DSP.clamp(std / 2.4, 0.5, 2.0);
    const jitter = DSP.clamp(frameJitter * 0.25, 0.003, 0.02);
    const shimmer = DSP.clamp(0.02 + breath * 0.2, 0.015, 0.06);
    const tiltReal = voicedTiltDb(A.x16);

    const parsed = VS.G2P.parse(text);
    const base = { f0, scale: 1, range: 1, tilt: 0.35, oq: oqFor(0.35, breath), breath, jitter, shimmer, rate: 1 };

    // Темп: сравнение длительности речи с длительностью, которую даёт синтезатор при темпе 1.
    const realMs = speechDurationMs(A.active);
    const synthMs = planSpeechMs(VS.Prosody.plan(parsed, base, { seed: 1 }));
    const rate = realMs > 0 ? DSP.clamp(synthMs / realMs, 0.6, 1.6) : 1;
    base.rate = rate;
    const refPlan = VS.Prosody.plan(parsed, base, { seed: 1 });

    // Масштаб формант: медианы F2/F3 живой речи против синтезированной той же фразы.
    const x11 = DSP.resample(x, fs, FS_L);
    const realF = medianF23(x11, vIdx.map((i) => i * HOP_MS + 20));
    const synth = VS.Synth.render(refPlan, base, { seed: 1 });
    const SA = baseAnalysis(synth, VS.Synth.FS, -90);
    const sIdx = [];
    for (let i = 0; i < SA.n; i++) if (SA.voiced[i]) sIdx.push(i);
    const synF = medianF23(DSP.resample(synth, VS.Synth.FS, FS_L), sIdx.map((i) => i * HOP_MS + 20));
    // Мелодический диапазон: разброс тона живой речи относительно синтеза той же фразы с range = 1.
    if (sIdx.length > 20) {
      const sst = sIdx.map((i) => 12 * Math.log2(SA.f0[i] / f0));
      const sm = sst.reduce((a, v) => a + v, 0) / sst.length;
      const sstd = Math.sqrt(sst.reduce((a, v) => a + (v - sm) * (v - sm), 0) / sst.length);
      if (sstd > 0.3) range = DSP.clamp(std / sstd, 0.4, 2.2);
    }
    base.range = range;
    let scale = 1;
    if (realF.n > 10 && synF.n > 10) scale = Math.sqrt((realF.f2 / synF.f2) * (realF.f3 / synF.f3));
    scale = DSP.clamp(scale, 0.8, 1.45);
    base.scale = scale;

    // Наклон спектра: подбор параметра tilt анализом через синтез (та же фраза, те же кадры).
    const tiltGrid = [0.05, 0.25, 0.45, 0.65, 0.85];
    const tiltVals = tiltGrid.map((tv) => synthTiltDb(refPlan, Object.assign({}, base, { tilt: tv, oq: oqFor(tv, breath) })));
    let tilt;
    if (tiltReal >= tiltVals[0]) tilt = tiltGrid[0];
    else if (tiltReal <= tiltVals[tiltVals.length - 1]) tilt = tiltGrid[tiltGrid.length - 1];
    else {
      for (let k = 0; k < tiltGrid.length - 1; k++) {
        const a = tiltVals[k], b = tiltVals[k + 1];
        if (tiltReal <= a && tiltReal >= b) { tilt = DSP.lerp(tiltGrid[k], tiltGrid[k + 1], (a - tiltReal) / ((a - b) || 1)); break; }
      }
      if (tilt === undefined) tilt = 0.35;
    }

    return {
      ok: true,
      f0: Math.round(f0),
      range,
      scale,
      tilt: DSP.clamp(tilt, 0.02, 0.9),
      breath,
      jitter,
      shimmer,
      rate,
      stats: {
        f0Min: Math.round(DSP.percentile(f0s, 0.05)), f0Max: Math.round(DSP.percentile(f0s, 0.95)),
        stdSt: +std.toFixed(2), tiltDb: +tiltReal.toFixed(1), aperiodicity: +apMed.toFixed(3),
        speechMs: realMs, voicedFrames: vIdx.length,
      },
    };
  }

  function oqFor(tilt, breath) { return DSP.clamp(0.45 + breath * 1.5 + (tilt - 0.3) * 0.3, 0.4, 0.75); }

  // Наклон спектра синтезированной речи — те же кадры и та же мера, что и для записи.
  function synthTiltDb(pl, voice) {
    return voicedTiltDb(DSP.resample(VS.Synth.render(pl, voice, { seed: 1 }), VS.Synth.FS, FS_P));
  }

  /*
   * Анализ протяжных гласных «А — О — У — Э — И — Ы», произнесённых с паузами.
   */
  const VOWEL_ORDER = ['a', 'o', 'u', 'e', 'i', 'y'];
  function analyzeVowels(x, fs, opts) {
    opts = opts || {};
    const A = baseAnalysis(x, fs, opts.noiseDb);
    // сегментация по энергии
    const thr = Math.max(A.thr, A.maxDb - 25);
    let segs = [];
    let cur = null;
    for (let i = 0; i < A.n; i++) {
      if (A.db[i] > thr) { if (!cur) cur = { s: i, e: i }; else cur.e = i; }
      else if (cur && i - cur.e > 8) { segs.push(cur); cur = null; }
    }
    if (cur) segs.push(cur);
    segs = segs.filter((sg) => (sg.e - sg.s + 1) * HOP_MS >= 150);
    if (segs.length > 6) {
      const longest = segs.slice().sort((p, q) => (q.e - q.s) - (p.e - p.s)).slice(0, 6);
      segs = segs.filter((sg) => longest.indexOf(sg) >= 0);
    }
    const x11 = DSP.resample(x, fs, FS_L);
    const formants = {};
    const segments = [];
    segs.slice(0, 6).forEach((sg, k) => {
      const len = sg.e - sg.s + 1;
      const from = sg.s + Math.floor(len * 0.2), to = sg.e - Math.floor(len * 0.2);
      const F1 = [], F2 = [], F3 = [];
      for (let i = from; i <= to; i++) {
        if (!A.voiced[i]) continue;
        const F = formantsAt(x11, i * HOP_MS + 20);
        if (F) { F1.push(F[0]); F2.push(F[1]); F3.push(F[2]); }
      }
      segments.push({ startMs: sg.s * HOP_MS, endMs: (sg.e + 1) * HOP_MS });
      if (F1.length >= 3) formants[VOWEL_ORDER[k]] = [DSP.median(F1), DSP.median(F2), DSP.median(F3)].map(Math.round);
    });
    const found = Object.keys(formants).length;
    // масштаб формант относительно эталона
    const ratios = [];
    Object.keys(formants).forEach((k) => {
      const ref = VS.Synth.REF_VOWELS[k];
      ratios.push(formants[k][1] / ref[1], formants[k][2] / ref[2]);
    });
    const scale = ratios.length ? DSP.clamp(DSP.median(ratios), 0.8, 1.45) : null;
    // отбраковка явных ошибок LPC
    const fixed = [];
    if (scale) {
      Object.keys(formants).forEach((k) => {
        const ref = VS.Synth.REF_VOWELS[k];
        formants[k] = formants[k].map((f, i) => {
          const exp = ref[i] * (i === 0 ? 1 + (scale - 1) * 0.85 : scale);
          const r = f / exp;
          if (r < 0.7 || r > 1.4) { fixed.push(k + ':F' + (i + 1)); return Math.round(exp); }
          return f;
        });
      });
    }
    return { ok: segs.length === 6 && found >= 4, found, segmentsFound: segs.length, formants, scale, fixed, segments };
  }

  // Собрать голос из результатов анализа.
  function buildVoice(name, phrase, vowels) {
    const scale = vowels && vowels.ok && vowels.scale ? vowels.scale : phrase.scale;
    const v = {
      id: 'custom-' + Date.now().toString(36),
      name: name || 'Мой голос',
      desc: 'записанный голос',
      custom: true,
      f0: phrase.f0,
      range: +phrase.range.toFixed(2),
      scale: +scale.toFixed(3),
      tilt: +phrase.tilt.toFixed(2),
      oq: +oqFor(phrase.tilt, phrase.breath).toFixed(2),
      breath: +phrase.breath.toFixed(3),
      jitter: +phrase.jitter.toFixed(4),
      shimmer: +phrase.shimmer.toFixed(3),
      rate: +phrase.rate.toFixed(2),
      stats: phrase.stats,
      created: new Date().toISOString(),
    };
    if (vowels && vowels.ok) v.formants = vowels.formants;
    return v;
  }

  VS.Analyzer = { measureNoise, analyzePhrase, synthTiltDb, oqFor, analyzeVowels, buildVoice, yinTrack, formantsAt, lpc, FS_P, FS_L };

  if (typeof module !== 'undefined' && module.exports) module.exports = VS;
})(typeof globalThis !== 'undefined' ? globalThis : this);
