/*
 * Формантный синтезатор (каскадно-параллельная схема Клатта), без ИИ.
 *
 *  Голосовой источник (импульс Розенберга, джиттер, шиммер, наклон спектра)
 *   + шум придыхания ──► носовой полюс/нуль ──► F1…F5 (каскад) ──► излучение (дифференцирование)
 *  Шум фрикации ──► параллельные полосовые резонаторы (спектр согласного)
 *
 * Параметры обновляются кадрами по 64 отсчёта (~2.9 мс), амплитуды и F0 — интерполируются поотсчётно.
 */
(function (g) {
  'use strict';
  const VS = g.VoiceSynth = g.VoiceSynth || {};
  const PH = VS.Phonemes;
  const DSP = VS.DSP;

  const FS = 22050;
  const FRAME = 64;

  // Калибровочные коэффициенты громкости ветвей.
  const G_VOICE = 1.0;
  const G_FRIC = 0.075;
  const G_ASP = 0.9;

  // Локусы (формантные «мишени») согласных для переходов, эталонный мужской голос.
  const LOCI = {
    lab: { hard: [250, 850, 2200], soft: [250, 1850, 2600] },
    den: { hard: [250, 1650, 2600], soft: [250, 2000, 2800] },
    post: { hard: [300, 1500, 2250], soft: [300, 1500, 2250] },
    pal: { hard: [280, 2100, 2850], soft: [280, 2100, 2850] },
  };
  // Собственные форманты сонорных.
  const SON = {
    m: { hard: [260, 1100, 2300], soft: [260, 1800, 2600] },
    n: { hard: [260, 1450, 2500], soft: [260, 1900, 2700] },
    l: { hard: [360, 950, 2450], soft: [300, 1850, 2700] },
    r: { hard: [430, 1300, 2300], soft: [380, 1800, 2550] },
    j: { hard: [260, 2200, 3000], soft: [260, 2200, 3000] },
  };
  // Спектры шумов фрикативных: [частота, полоса, усиление дБ].
  const FRIC = {
    f: [[1800, 2200, -14], [7000, 3000, -9]],
    'f\'': [[2300, 2000, -13], [7500, 3000, -9]],
    s: [[5600, 1400, 0], [8200, 2200, -4]],
    's\'': [[5000, 1300, 0], [7500, 2200, -4]],
    S: [[2200, 500, -6], [3200, 800, -2], [5200, 1500, -9]],
    x: [[1300, 500, -7], [2600, 900, -11]],
    'x\'': [[2700, 700, -6], [3700, 900, -9]],
    sch: [[3100, 600, -4], [4600, 1000, 0], [6600, 1600, -6]],
    ch: [[3200, 600, -3], [4600, 1000, -2], [6500, 1600, -9]],
  };
  const BURST = {
    lab: [[900, 900, -6], [2500, 2000, -14]],
    'lab\'': [[1600, 1000, -6], [3200, 2000, -11]],
    den: [[4000, 1500, -2], [6200, 2500, -4]],
    'den\'': [[4600, 1300, 0], [6800, 2000, -3]],
    velFront: [[2600, 600, -2], [3600, 900, -8]],
    velBack: [[1500, 500, -2], [2700, 900, -10]],
  };
  // Уровни (дБ; 60 дБ = единичная амплитуда).
  const AF_LEVEL = { f: 47, s: 56, S: 55, x: 56, sch: 55, ch: 54 };

  const REF_VOWELS = {};
  Object.keys(PH.VOWELS).forEach((k) => { REF_VOWELS[k] = PH.VOWELS[k].F.slice(); });

  function scaleF(F, s) { return [F[0] * (1 + (s - 1) * 0.85), F[1] * s, F[2] * s]; }

  // Таблица гласных конкретного голоса (эталон × масштаб или измеренные форманты).
  function vowelTable(voice) {
    const s = voice.scale || 1;
    const t = {};
    Object.keys(REF_VOWELS).forEach((k) => { t[k] = scaleF(REF_VOWELS[k], s); });
    const m = voice.formants;
    if (m) {
      ['a', 'o', 'u', 'e', 'i', 'y'].forEach((k) => { if (m[k] && m[k].length >= 3) t[k] = m[k].slice(0, 3); });
      const mix = (p, q, k) => [0, 1, 2].map((i) => DSP.lerp(p[i], q[i], k));
      const schwa = [0, 1, 2].map((i) => (t.a[i] + t.o[i] + t.e[i] + t.y[i]) / 4 * 0.5 + scaleF(REF_VOWELS['@'], s)[i] * 0.5);
      t['@'] = schwa;
      t.A = mix(t.a, schwa, 0.3);
      t.I = mix(t.i, t.e, 0.5);
    }
    return t;
  }


  function consInfo(ph) {
    const c = PH.CONS[ph.b];
    return { c, soft: !!ph.soft || !!c.softOnly };
  }

  // Локус согласного с учётом соседней гласной (для заднеязычных — зависит от гласной).
  function locusOf(ph, vowelF, s) {
    const { c, soft } = consInfo(ph);
    if (SON[ph.b]) return scaleF(SON[ph.b][soft ? 'soft' : 'hard'], s);
    if (c.place === 'vel') {
      if (soft) return scaleF([250, 2250, 2900], s);
      const v2 = vowelF ? vowelF[1] : 1300 * s;
      const f2 = v2 > 1600 * s ? 2200 * s : DSP.clamp(v2 + 250 * s, 1000 * s, 2000 * s);
      return [250 * s, f2, Math.max(f2 + 400 * s, 2400 * s)];
    }
    const L = LOCI[c.place] || LOCI.den;
    return scaleF(L[soft ? 'soft' : 'hard'], s);
  }

  function fricSpecKey(ph) {
    const b = ph.b;
    const soft = !!ph.soft;
    if (b === 'f' || b === 'v') return soft ? 'f\'' : 'f';
    if (b === 's' || b === 'z' || b === 'ts') return soft ? 's\'' : 's';
    if (b === 'S' || b === 'Z') return 'S';
    if (b === 'x') return soft ? 'x\'' : 'x';
    if (b === 'sch') return 'sch';
    if (b === 'ch') return 'ch';
    return 's';
  }

  function burstKey(ph, nextVowelF, s) {
    const c = PH.CONS[ph.b];
    if (c.place === 'lab') return ph.soft ? 'lab\'' : 'lab';
    if (c.place === 'vel') return (ph.soft || (nextVowelF && nextVowelF[1] > 1600 * s)) ? 'velFront' : 'velBack';
    return ph.soft ? 'den\'' : 'den';
  }

  // Точки формантной траектории с учётом коартикуляции.
  function buildFormantTrack(units, vt, s) {
    const kp = [];
    const isV = (u) => u && !u.pause && PH.isVowel(u.ph.b);
    const isC = (u) => u && !u.pause && !PH.isVowel(u.ph.b);
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (u.pause) continue;
      const s0 = u.start, D = u.dur, e0 = s0 + D;
      const prev = units[i - 1], next = units[i + 1];
      if (isV(u)) {
        const T = vt[u.ph.b];
        let trIn = 10, trOut = 10;
        if (isC(prev)) trIn = consInfo(prev.ph).soft ? Math.min(0.45 * D, 60) : Math.min(0.35 * D, 45);
        else if (isV(prev)) trIn = Math.min(0.3 * D, 35);
        if (isC(next)) trOut = Math.min(0.3 * D, 40);
        else if (isV(next)) trOut = Math.min(0.3 * D, 35);
        if (trIn + trOut > D * 0.9) { const k = D * 0.9 / (trIn + trOut); trIn *= k; trOut *= k; }
        kp.push({ t: s0 + trIn, F: T });
        kp.push({ t: e0 - trOut, F: T });
      } else {
        const pv = isV(prev) ? vt[prev.ph.b] : null;
        const nv = isV(next) ? vt[next.ph.b] : null;
        if (SON[u.ph.b]) {
          const L = locusOf(u.ph, nv || pv, s);
          if (u.ph.b === 'j') kp.push({ t: s0 + D * 0.5, F: L });
          else { kp.push({ t: s0 + D * 0.3, F: L }); kp.push({ t: e0 - D * 0.3, F: L }); }
        } else {
          const soft = consInfo(u.ph).soft;
          const blend = (L, V, k, k1) => [DSP.lerp(L[0], V[0], k1), DSP.lerp(L[1], V[1], k), DSP.lerp(L[2], V[2], k)];
          const Ll = locusOf(u.ph, pv || nv, s);
          const Lr = locusOf(u.ph, nv || pv, s);
          kp.push({ t: s0 + 0.5, F: pv ? blend(Ll, pv, 0.35, 0.2) : Ll });
          kp.push({ t: e0 - 0.5, F: nv ? blend(Lr, nv, soft ? 0.2 : 0.35, 0.2) : Lr });
        }
      }
    }
    kp.sort((a, b) => a.t - b.t);
    return kp;
  }

  function makeInterp(points, getter) {
    let idx = 0;
    return function (t) {
      if (!points.length) return null;
      if (t <= points[0].t) { idx = 0; return getter(points[0]); }
      while (idx < points.length - 2 && points[idx + 1].t < t) idx++;
      while (idx > 0 && points[idx].t > t) idx--;
      const a = points[idx], b = points[Math.min(idx + 1, points.length - 1)];
      if (t >= b.t) return getter(b);
      const k = (t - a.t) / Math.max(1e-6, b.t - a.t);
      const ga = getter(a), gb = getter(b);
      if (Array.isArray(ga)) return ga.map((v, i) => v + (gb[i] - v) * k);
      return ga + (gb - ga) * k;
    };
  }

  const lin = (db) => (db <= 0 ? 0 : Math.pow(10, (db - 60) / 20));

  // Источниковые параметры внутри фонемы: av, ah, af, спектр шума, носовость.
  function sourceAt(u, tau, prev, next, vt, s) {
    const out = { av: 0, ah: 0, af: 0, spec: null, nasal: 0 };
    if (!u || u.pause) return out;
    const D = u.dur;
    const ph = u.ph;
    const nextIsPause = !next || next.pause;
    const prevIsPause = !prev || prev.pause;
    const edgeIn = prevIsPause ? Math.min(1, tau / 12) : 1;
    const edgeOut = nextIsPause ? Math.min(1, (D - tau) / 35) : 1;
    const env = Math.max(0, edgeIn * edgeOut);
    if (PH.isVowel(ph.b)) {
      out.av = lin(60 + u.ampDb) * env;
      return out;
    }
    const c = PH.CONS[ph.b];
    const nextVowelF = next && !next.pause && PH.isVowel(next.ph.b) ? vt[next.ph.b] : null;
    switch (c.cls) {
      case 'nasal':
        out.av = lin(50) * env;
        out.nasal = ph.b === 'm' ? 1000 * s : (ph.soft ? 1900 * s : 1500 * s);
        break;
      case 'lat':
        out.av = lin(59) * env;
        break;
      case 'glide':
        out.av = lin(57) * env;
        break;
      case 'trill': {
        let m = 1;
        const tap = (center) => { const d = Math.abs(tau - center); return d < 5 ? 0.18 : d < 8 ? 0.6 : 1; };
        if (D < 45) m = tap(D * 0.5); else m = Math.min(tap(D * 0.33), tap(D * 0.72));
        out.av = lin(56) * m * env;
        break;
      }
      case 'fric': {
        const key = fricSpecKey(ph);
        const base = ph.b === 'v' || ph.b === 'f' ? 'f' : ph.b === 'z' || ph.b === 's' ? 's' : ph.b === 'Z' || ph.b === 'S' ? 'S' : ph.b;
        let af = AF_LEVEL[base] || 50;
        if (c.voiced) {
          af -= ph.b === 'v' ? 4 : 7;
          out.av = lin(ph.b === 'v' ? 52 : 47) * env;
        }
        // мягкие нарастание/спад шума
        const ramp = Math.min(1, tau / 15, (D - tau) / 15);
        out.af = lin(af) * Math.max(0.05, ramp);
        out.spec = key;
        break;
      }
      case 'stop': {
        const vel = c.place === 'vel';
        const burst = c.place === 'lab' ? 8 : vel ? 14 : 10;
        const toSon = next && !next.pause && (PH.isVowel(next.ph.b) || SON[next.ph.b]);
        let asp = c.voiced ? 0 : (toSon ? (vel ? 28 : ph.soft ? 26 : 20) : 6);
        if (ph.soft && c.voiced) asp = 8;
        const closure = Math.max(15, D - burst - asp);
        if (tau < closure) {
          if (c.voiced) out.av = lin(41);
        } else if (tau < closure + burst) {
          const lvl = (c.place === 'lab' ? 51 : 55) - (c.voiced ? 5 : 0);
          out.af = lin(lvl);
          out.spec = 'B:' + burstKey(ph, nextVowelF, s);
          if (c.voiced) out.av = lin(46);
        } else {
          if (c.voiced) { out.av = lin(50); if (ph.soft) { out.af = lin(44); out.spec = 's\''; } }
          else {
            out.ah = lin(ph.soft ? 43 : 45);
            if (ph.soft && c.place === 'den') { out.af = lin(47); out.spec = 's\''; }
          }
        }
        break;
      }
      case 'affr': {
        const closure = D * 0.35;
        if (tau >= closure) {
          const key = fricSpecKey(ph);
          const ramp = Math.min(1, (D - tau) / 15);
          out.af = lin(ph.b === 'ch' ? AF_LEVEL.ch : AF_LEVEL.s) * Math.max(0.05, ramp);
          out.spec = key;
        }
        break;
      }
      default:
        break;
    }
    return out;
  }

  function specDef(key) {
    if (!key) return null;
    if (key.indexOf('B:') === 0) return BURST[key.slice(2)];
    return FRIC[key];
  }

  /*
   * Отрисовать план в звук. Возвращает Float32Array (22050 Гц).
   */
  function render(pl, voice, opts) {
    opts = opts || {};
    const s = voice.scale || 1;
    const vt = vowelTable(voice);
    const units = pl.units;
    const n = Math.ceil(pl.total * FS / 1000) + FRAME;
    const out = new Float32Array(n);
    const nFrames = Math.ceil(n / FRAME) + 1;
    const rng = DSP.rng(opts.seed === undefined ? 4242 : opts.seed + 1);
    const pitchShift = opts.pitch || 0;
    const f0Base = voice.f0 || 120;

    const kp = buildFormantTrack(units, vt, s);
    const fTrack = makeInterp(kp, (p) => p.F);
    const stTrack = makeInterp(pl.f0, (p) => p.st);
    const bwScale = Math.sqrt(s);
    const F4 = 3500 * s, F5 = Math.min(4500 * s, FS / 2 - 800);
    const driftPh = rng() * 6.28;

    // --- покадровые параметры ---
    const fr = new Array(nFrames);
    let ui = 0;
    for (let fi = 0; fi < nFrames; fi++) {
      const tms = fi * FRAME / FS * 1000;
      while (ui < units.length - 1 && units[ui].start + units[ui].dur <= tms) ui++;
      const u = units[ui];
      const tau = u ? tms - u.start : 0;
      const src = u && tms < u.start + u.dur ? sourceAt(u, tau, units[ui - 1], units[ui + 1], vt, s) : { av: 0, ah: 0, af: 0, spec: null, nasal: 0 };
      const F = fTrack(tms) || vt['@'];
      let st = stTrack(tms);
      if (st === null) st = 0;
      // микропросодия: после глухого согласного тон на гласной начинается чуть выше
      if (u && !u.pause && PH.isVowel(u.ph.b)) {
        const pv = units[ui - 1];
        if (pv && !pv.pause && PH.VOICELESS.has(pv.ph.b)) st += 0.7 * Math.max(0, 1 - tau / 40);
      }
      const ts = tms / 1000;
      st += 0.25 * Math.sin(2 * Math.PI * ts / 1.9 + driftPh);
      const flutter = 1 + (voice.flutter === undefined ? 0.004 : voice.flutter) *
        (Math.sin(2 * Math.PI * 12.7 * ts) + Math.sin(2 * Math.PI * 7.1 * ts) + Math.sin(2 * Math.PI * 4.7 * ts)) / 3;
      const f0 = f0Base * Math.pow(2, (st + pitchShift) / 12) * flutter;
      const isNasal = src.nasal > 0;
      const isLat = u && !u.pause && (u.ph.b === 'l');
      fr[fi] = {
        av: src.av, ah: src.ah, af: src.af, spec: src.spec, nasal: src.nasal,
        F1: isNasal ? 250 * s : F[0], F2: F[1], F3: F[2],
        B1: (isNasal || isLat ? 100 : 70) * bwScale, B2: 90 * bwScale, B3: 140 * bwScale,
        f0,
      };
    }

    // --- поотсчётная генерация ---
    const R = [new DSP.Resonator(), new DSP.Resonator(), new DSP.Resonator(), new DSP.Resonator(), new DSP.Resonator()];
    R[3].set(F4, 250 * bwScale, FS);
    R[4].set(F5, 300 * bwScale, FS);
    // F6 и «высокополюсная коррекция»: подъём ВЧ, которых каскаду из 5 резонаторов не хватает на 22 кГц
    const R6 = new DSP.Resonator().set(Math.min(5500 * s, FS / 2 - 600), 500 * bwScale, FS);
    const hpA = Math.exp(-2 * Math.PI * 2500 / FS);
    const HF_BOOST = opts.hfBoost === undefined ? 3 : opts.hfBoost;
    let hpX = 0, hpY = 0;
    const NP = new DSP.Resonator();
    const NZ = new DSP.AntiResonator();
    const bank = [new DSP.Resonator(), new DSP.Resonator(), new DSP.Resonator()];
    const bankGain = [0, 0, 0];
    let bankKey = null;
    const fricScale = Math.sqrt(s);

    const oq = DSP.clamp(voice.oq === undefined ? 0.55 : voice.oq, 0.3, 0.85);
    const tiltA = DSP.clamp(voice.tilt === undefined ? 0.35 : voice.tilt, 0, 0.92);
    const breath = voice.breath === undefined ? 0.03 : voice.breath;
    const jitter = voice.jitter === undefined ? 0.006 : voice.jitter;
    const shimmer = voice.shimmer === undefined ? 0.03 : voice.shimmer;
    const whisper = !!voice.whisper;

    let phase = 0, jm = 1, sh = 1;
    let tl = 0, yPrev = 0;
    let nasalOn = null;
    for (let fi = 0; fi < nFrames - 1; fi++) {
      const p = fr[fi], q = fr[fi + 1];
      R[0].set(p.F1, p.B1, FS);
      R[1].set(p.F2, p.B2, FS);
      R[2].set(p.F3, p.B3, FS);
      const nz = p.nasal || 0;
      if (nz !== nasalOn) {
        NP.set(270 * s, 100, FS);
        NZ.set(nz ? nz : 270 * s, nz ? 220 : 100, FS);
        nasalOn = nz;
      }
      if (p.spec && p.spec !== bankKey) {
        const def = specDef(p.spec) || [];
        for (let k = 0; k < 3; k++) {
          if (def[k]) {
            bank[k].setPeak(Math.min(def[k][0] * fricScale, FS / 2 - 600), def[k][1] * fricScale, FS);
            bankGain[k] = DSP.dbToLin(def[k][2]);
          } else bankGain[k] = 0;
        }
        bankKey = p.spec;
      }
      const base = fi * FRAME;
      for (let k = 0; k < FRAME; k++) {
        const idx = base + k;
        if (idx >= n) break;
        const fr01 = k / FRAME;
        const av = p.av + (q.av - p.av) * fr01;
        const ah = p.ah + (q.ah - p.ah) * fr01;
        const af = p.af + (q.af - p.af) * fr01;
        const f0 = p.f0 + (q.f0 - p.f0) * fr01;

        phase += f0 * jm / FS;
        if (phase >= 1) {
          phase -= 1;
          jm = 1 + jitter * rng.gauss();
          sh = 1 + shimmer * rng.gauss();
        }
        // импульс Розенберга (объёмная скорость потока через голосовую щель)
        let gl = 0;
        const tp = oq * 0.7, tn = oq * 0.3;
        if (phase < tp) gl = 0.5 * (1 - Math.cos(Math.PI * phase / tp));
        else if (phase < oq) gl = Math.cos(Math.PI * (phase - tp) / (2 * tn));
        const noise = rng() * 2 - 1;
        const voiced = whisper ? 0 : gl * av * sh;
        tl = (1 - tiltA) * voiced + tiltA * tl;
        const aspAmp = ah + (whisper ? av * 0.9 : breath * av * (0.35 + gl));
        let x = tl + noise * aspAmp * G_ASP;
        x = NZ.step(NP.step(x));
        x = R[0].step(x); x = R[1].step(x); x = R[2].step(x); x = R[3].step(x); x = R[4].step(x); x = R6.step(x);
        let rad = x - yPrev;
        yPrev = x;
        hpY = hpA * (hpY + rad - hpX);
        hpX = rad;
        rad += HF_BOOST * hpY;
        let fsum = 0;
        if (af > 1e-6 || bankGain[0]) {
          const fn = (rng() * 2 - 1) * af;
          for (let b = 0; b < 3; b++) if (bankGain[b]) fsum += bank[b].step(fn) * bankGain[b];
        }
        out[idx] = rad * G_VOICE + fsum * G_FRIC;
      }
    }

    // Нормализация (по 99.9-перцентилю) с мягким ограничением.
    const abs = new Float32Array(out.length);
    for (let i = 0; i < out.length; i++) abs[i] = Math.abs(out[i]);
    let peak = 0;
    if (out.length) {
      const sorted = abs.slice().sort();
      peak = sorted[Math.floor(sorted.length * 0.999)] || 0;
      peak = Math.max(peak, sorted[sorted.length - 1] * 0.6);
    }
    const gain = peak > 0 ? 0.85 / peak * (opts.volume === undefined ? 1 : opts.volume) : 0;
    for (let i = 0; i < out.length; i++) {
      const y = out[i] * gain;
      out[i] = Math.abs(y) < 0.8 ? y : Math.sign(y) * (0.8 + 0.2 * Math.tanh((Math.abs(y) - 0.8) / 0.2));
    }
    return out;
  }

  // Удобная обёртка: текст → звук.
  function speak(text, voice, opts) {
    opts = opts || {};
    const parsed = VS.G2P.parse(text);
    const pl = VS.Prosody.plan(parsed, voice, opts);
    const samples = render(pl, voice, opts);
    return { samples, sampleRate: FS, plan: pl, parsed };
  }

  // F0 (Гц) в момент времени t (мс) по плану — для визуализации.
  function f0At(pl, voice, t, opts) {
    const tr = makeInterp(pl.f0, (p) => p.st);
    const st = tr(t);
    return (voice.f0 || 120) * Math.pow(2, ((st || 0) + ((opts && opts.pitch) || 0)) / 12);
  }

  VS.Synth = { FS, render, speak, vowelTable, f0At, REF_VOWELS };
  VS.speak = speak;

  if (typeof module !== 'undefined' && module.exports) module.exports = VS;
})(typeof globalThis !== 'undefined' ? globalThis : this);
