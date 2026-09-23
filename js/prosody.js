/*
 * Просодия: длительности, громкость и мелодика (ЧОТ) по правилам.
 *
 * Мелодика строится по интонационным конструкциям (ИК) русского языка (Е. А. Брызгалова):
 *  ИК-1  — завершённое повествование: понижение тона на ударном слоге центра;
 *  ИК-2  — вопрос с вопросительным словом, побуждение: усиленное ударение и спад;
 *  ИК-3  — общий вопрос («Вы придёте?»): резкий подъём на центре, спад на заударных;
 *  ИК-4  — сопоставительный вопрос с «а» («А ты?»): восходящее движение к концу;
 *  ИК-5  — восклицание с «какой/как»: подъём на первом ударении, спад на последнем;
 *  ИКн   — незавершённость (синтагма перед запятой): подъём и удержание.
 * Плюс деклинация (плавное понижение тона по фразе) и акценты на знаменательных словах.
 */
(function (g) {
  'use strict';
  const VS = g.VoiceSynth = g.VoiceSynth || {};
  const PH = VS.Phonemes;
  const DSP = VS.DSP;

  const PAUSES = { ',': 190, ';': 280, ':': 260, '—': 260, '.': 480, '!': 480, '?': 480, '…': 650, '\n': 600, '': 300 };

  function phoneDur(p, ctx) {
    let d;
    if (PH.isVowel(p.b)) {
      const v = PH.VOWELS[p.b];
      d = v.dur;
      if (!p.stressed && !v.reduced) d *= 0.6;
    } else {
      const c = PH.CONS[p.b];
      d = c.dur;
      if (p.soft && !c.softOnly) d += 5;
      if (p.long) d *= 1.6;
      if (ctx.wordInitial) d *= 1.1;
      if (ctx.beforeStressed) d *= 1.08;
    }
    return d;
  }

  function classifyPhrase(sentence, phrase, isLast) {
    const words = phrase.words;
    const stressedWords = [];
    words.forEach((w, i) => { if (w.stressIdx >= 0) stressedWords.push(i); });
    const lastStressed = stressedWords.length ? stressedWords[stressedWords.length - 1] : words.length - 1;
    const firstStressed = stressedWords.length ? stressedWords[0] : 0;
    const whIdx = words.findIndex((w) => w.wh);
    const liIdx = words.findIndex((w) => w.text === 'ли' || w.text === 'ль');
    const type = sentence.type;

    if (type === 'question') {
      if (whIdx >= 0) return { ik: 'IK2', nucleus: whIdx };
      if (liIdx > 0) return { ik: 'IK3', nucleus: liIdx - 1 };
      if (!isLast) return { ik: 'IKc', nucleus: lastStressed };
      if (words[0] && words[0].text === 'а' && words.length <= 4) return { ik: 'IK4', nucleus: lastStressed };
      return { ik: 'IK3', nucleus: lastStressed };
    }
    if (!isLast) return { ik: 'IKc', nucleus: lastStressed };
    if (type === 'exclamation') {
      const ex = words.findIndex((w) => w.excl);
      if (ex >= 0 && stressedWords.length > 1) return { ik: 'IK5', nucleus: lastStressed, first: Math.max(ex, firstStressed) };
      return { ik: 'IK2E', nucleus: lastStressed };
    }
    if (type === 'ellipsis') return { ik: 'IK1s', nucleus: lastStressed };
    return { ik: 'IK1', nucleus: lastStressed };
  }

  /*
   * Построить план произнесения.
   * Возвращает { units: [{ph|pause, start, dur, ampDb, word?}], f0: [{t, st}], total }.
   * Тон — в полутонах относительно базовой частоты голоса.
   */
  function plan(sentences, voice, opts) {
    opts = opts || {};
    const rate = (voice.rate || 1) * (opts.speed || 1);
    const A = (opts.expressiveness === undefined ? 1 : opts.expressiveness) * (voice.range || 1);
    const rng = DSP.rng(opts.seed === undefined ? 777 : opts.seed);
    const units = [];
    const f0 = [];
    let t = 0;
    const pushPause = (ms) => { units.push({ pause: true, start: t, dur: ms }); t += ms; };
    pushPause(opts.leadMs === undefined ? 120 : opts.leadMs);

    sentences.forEach((sentence, si) => {
      const nPh = sentence.phrases.length;
      sentence.phrases.forEach((phrase, pi) => {
        const isLast = pi === nPh - 1;
        const cls = classifyPhrase(sentence, phrase, isLast);
        // Плоский список фонем с контекстом.
        const flat = [];
        phrase.words.forEach((w, wi) => {
          w.phones.forEach((p, k) => {
            flat.push({ p, wi, word: w, wordInitial: k === 0 && !w.procl });
          });
        });
        if (!flat.length) return;
        for (let i = 0; i < flat.length - 1; i++) {
          if (flat[i + 1].p.stressed && !PH.isVowel(flat[i].p.b)) flat[i].beforeStressed = true;
        }
        // Гласные фразы
        const vIdx = [];
        flat.forEach((f, i) => { if (PH.isVowel(f.p.b)) vIdx.push(i); });
        const lastV = vIdx.length ? vIdx[vIdx.length - 1] : -1;
        // Ядро (ударная гласная центрального слова)
        let nucleusV = -1;
        for (const i of vIdx) if (flat[i].wi === cls.nucleus && flat[i].p.stressed) nucleusV = i;
        if (nucleusV < 0) for (const i of vIdx) if (flat[i].wi === cls.nucleus) nucleusV = i;
        if (nucleusV < 0) nucleusV = lastV;
        let lastStressedV = -1;
        for (const i of vIdx) if (flat[i].p.stressed) lastStressedV = i;

        // Длительности
        flat.forEach((f, i) => {
          let d = phoneDur(f.p, f);
          if (i >= (lastV >= 0 ? lastV : flat.length)) d *= isLast ? 1.4 : 1.25; // предпаузальное удлинение
          if (i === lastStressedV) d *= isLast ? 1.2 : 1.1;
          if (i === nucleusV) {
            if (cls.ik === 'IK3' || cls.ik === 'IK4') d *= 1.25;
            if (cls.ik === 'IK2' || cls.ik === 'IK2E' || cls.ik === 'IK5') d *= 1.15;
          }
          if (sentence.type === 'exclamation') d *= 0.95;
          d *= 1 + (rng() - 0.5) * 0.08;
          f.dur = d / rate;
        });

        // Громкость (дБ относительно нормы)
        const phraseStart = t;
        flat.forEach((f, i) => {
          let a = 0;
          if (PH.isVowel(f.p.b)) {
            if (f.p.stressed) a += 1.5;
            if (PH.VOWELS[f.p.b].reduced) a -= 2.5;
            if (i === nucleusV) a += (cls.ik === 'IK2' || cls.ik === 'IK2E') ? 3 : 1.5;
          }
          if (sentence.type === 'exclamation') a += 1.5;
          f.ampDb = a;
          f.start = t;
          t += f.dur;
          units.push({
            ph: f.p, start: f.start, dur: f.dur, ampDb: f.ampDb,
            word: f.wordInitial || (f.word.procl && f === flat.find((q) => q.wi === f.wi)) ? f.word.text : null,
          });
        });
        const phraseEnd = t;

        // ---- Мелодика ----
        const base0 = 1.2 - Math.min(pi, 3) * 0.6;
        const base = (time) => base0 - 0.9 * (time - phraseStart) / 1000;
        const nuc = flat[nucleusV];
        const pre = vIdx.filter((i) => i < nucleusV);
        const post = vIdx.filter((i) => i > nucleusV);
        const add = (time, st) => f0.push({ t: time, st: DSP.clamp(st, -9, 13) });
        const ik = cls.ik;
        const flatPre = ik === 'IK3' || ik === 'IK4';
        let firstAccent = true;
        let ik5first = -1;
        if (ik === 'IK5') {
          for (const i of pre) if (flat[i].wi >= cls.first && flat[i].p.stressed) { ik5first = i; break; }
        }
        add(phraseStart, base(phraseStart) + (flatPre ? 0.8 : 0.3) * A);
        for (const i of pre) {
          const f = flat[i];
          const mid = f.start + f.dur * 0.5;
          const b = base(mid) + (flatPre ? 0.8 * A : 0);
          if (ik === 'IK5' && ik5first >= 0 && i >= ik5first) {
            add(mid, b + (i === ik5first ? 5 : 4.5) * A);
            continue;
          }
          if (f.p.stressed && !f.word.clitic) {
            const acc = (flatPre ? 0.5 : (firstAccent ? 2.5 : 1.5)) * A;
            firstAccent = false;
            add(f.start, b + acc * 0.4);
            add(mid, b + acc);
            add(f.start + f.dur, b + acc * 0.6);
          } else {
            add(mid, b - 0.3 * A);
          }
        }
        if (nuc) {
          const s = nuc.start, d = nuc.dur, e = s + d;
          const b = base(s) + (flatPre ? 0.8 * A : 0);
          const E = phraseEnd;
          const postPts = (fromSt, toSt) => {
            post.forEach((i, k) => {
              const f = flat[i];
              const k1 = post.length === 1 ? 1 : k / (post.length - 1);
              add(f.start + f.dur * 0.5, DSP.lerp(fromSt, toSt, k1));
            });
          };
          switch (ik) {
            case 'IK1':
              add(s, b + 1.5 * A); add(s + d * 0.35, b + 1.2 * A); add(e, b - 2.5 * A);
              if (post.length) postPts(b - 3.2 * A, b - 4 * A);
              add(E, b - 4.5 * A);
              break;
            case 'IK1s': // многоточие — неполный спад
              add(s, b + 1.5 * A); add(e, b - 1 * A);
              if (post.length) postPts(b - 1.5 * A, b - 2 * A);
              add(E, b - 2.2 * A);
              break;
            case 'IK2':
              add(s, b + 2.5 * A); add(s + d * 0.4, b + 3.5 * A); add(e, b + 0.5 * A);
              if (post.length) postPts(b - 0.8 * A, b - 4 * A);
              add(E, b - 4.5 * A);
              break;
            case 'IK2E':
              add(s, b + 2 * A); add(s + d * 0.45, b + 5 * A); add(e, b - 0.5 * A);
              if (post.length) postPts(b - 2.5 * A, b - 5 * A);
              add(E, b - 5.5 * A);
              break;
            case 'IK3':
              if (post.length) {
                add(s, b + 0.3 * A); add(s + d * 0.65, b + 7 * A); add(e, b + 6.5 * A);
                postPts(b + 1.8 * A, b + 0.5 * A);
                add(E, b + 0.2 * A);
              } else {
                add(s, b + 0.3 * A); add(s + d * 0.6, b + 7.5 * A); add(e, b + 4.5 * A);
                add(E, b + 4 * A);
              }
              break;
            case 'IK4':
              if (post.length) {
                add(s, b - 1.5 * A); add(e, b + 0.5 * A);
                postPts(b + 2.5 * A, b + 5.5 * A);
                add(E, b + 6 * A);
              } else {
                add(s, b - 2 * A); add(s + d * 0.3, b - 1.5 * A); add(e, b + 6 * A);
                add(E, b + 6 * A);
              }
              break;
            case 'IK5':
              add(s, b + 4.5 * A); add(s + d * 0.3, b + 5 * A); add(e, b - 2 * A);
              if (post.length) postPts(b - 3 * A, b - 4.5 * A);
              add(E, b - 5 * A);
              break;
            default: // IKc — незавершённость
              add(s, b + 0.2 * A); add(s + d * 0.7, b + 3.5 * A); add(e, b + 4 * A);
              if (post.length) postPts(b + 3 * A, b + 3 * A);
              add(E, b + 3 * A);
          }
        }
        // Пауза после синтагмы
        let pause = PAUSES[phrase.end] !== undefined ? PAUSES[phrase.end] : 250;
        if (isLast && si === sentences.length - 1) pause = opts.tailMs === undefined ? 250 : opts.tailMs;
        pushPause(pause / Math.sqrt(rate));
        // Во время паузы тон «возвращается» к среднему уровню
        add(t - 1, 0);
      });
    });
    f0.sort((a, b) => a.t - b.t);
    return { units, f0, total: t, sentences };
  }

  VS.Prosody = { plan, classifyPhrase };

  if (typeof module !== 'undefined' && module.exports) module.exports = VS;
})(typeof globalThis !== 'undefined' ? globalThis : this);
