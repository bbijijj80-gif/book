/* Самопроверка без браузера: node tests/run.js */
'use strict';
const path = require('path');
['dsp', 'phonemes', 'g2p', 'prosody', 'synth', 'voices', 'analyzer'].forEach((f) => require(path.join(__dirname, '..', 'js', f + '.js')));
const VS = globalThis.VoiceSynth;
const { DSP } = VS;

let failed = 0, passed = 0;
function check(name, cond, info) {
  if (cond) { passed++; console.log('  ✓ ' + name + (info ? '  (' + info + ')' : '')); }
  else { failed++; console.log('  ✗ ' + name + (info ? '  (' + info + ')' : '')); }
}

// «Запись»: синтез → 48 кГц + лёгкий шум, как с микрофона
function record(text, voice, opts) {
  const r = VS.speak(text, voice, opts || {});
  const x = DSP.resample(r.samples, r.sampleRate, 48000);
  const rng = DSP.rng(9);
  for (let i = 0; i < x.length; i++) x[i] = x[i] * 0.5 + (rng() - 0.5) * 0.002;
  return x;
}

console.log('Текст → фонемы');
const p = VS.G2P.parse('Привет! Вы сегодня пойдёте в кино? Где ты был вчера? Мне 25 лет.');
check('4 предложения', p.length === 4);
check('типы предложений', p.map((s) => s.type).join() === 'exclamation,question,question,statement');
const tr = VS.G2P.transcribe(p);
check('оглушение и аканье', /prʲivʲe\u0301t/.test(tr) && /sʲɪvo\u0301dnʲə/.test(tr), tr);
check('числа прописью', /двадцать пять/.test(VS.G2P.normalize('25')));
check('разметка ударения «+»', VS.G2P.parse('зам+ок')[0].phrases[0].words[0].stressIdx === 1);
check('разметка ударения заглавной', VS.G2P.parse('зАмок')[0].phrases[0].words[0].stressIdx === 0);

console.log('Интонация');
const v0 = VS.Voices.PRESETS[0];
function lastNucleusShape(text) {
  const r = VS.speak(text, v0, {});
  const x16 = DSP.resample(r.samples, r.sampleRate, 16000);
  const { f0, ap } = VS.Analyzer.yinTrack(x16);
  const vals = [];
  const all = [];
  for (let i = 0; i < f0.length; i++) if (ap[i] < 0.12) all.push(f0[i]);
  const m0 = DSP.median(all);
  for (const f of all) if (f > m0 * 0.6 && f < m0 * 1.8) vals.push(f);
  return { vals, max: DSP.percentile(vals, 0.9), med: DSP.median(vals), lastQ: DSP.median(vals.slice(-Math.floor(vals.length / 4))) };
}
const q = lastNucleusShape('Вы пойдёте домой?');
const s = lastNucleusShape('Вы пойдёте домой.');
check('общий вопрос (ИК-3): подъём тона на центре', q.max > s.max * 1.15, 'макс вопрос ' + q.max.toFixed(0) + ' Гц, утв. ' + s.max.toFixed(0) + ' Гц');
check('повествование (ИК-1): спад к концу', s.lastQ < s.med, 'конец ' + s.lastQ.toFixed(0) + ' < медиана ' + s.med.toFixed(0));

console.log('Синтез: все голоса');
VS.Voices.PRESETS.forEach((v) => {
  const r = VS.speak('Съешь же ещё этих мягких французских булок, да выпей чаю!', v, {});
  let bad = 0; for (const x of r.samples) if (!isFinite(x)) bad++;
  const x16 = DSP.resample(r.samples, r.sampleRate, 16000);
  const { f0, ap } = VS.Analyzer.yinTrack(x16);
  const vf = []; for (let i = 0; i < f0.length; i++) if (ap[i] < 0.2) vf.push(f0[i]);
  const med = DSP.median(vf);
  check(v.name + ': звук корректный, тон ≈ ' + v.f0 + ' Гц', bad === 0 && Math.abs(12 * Math.log2(med / v.f0)) < 3,
    'медиана ' + med.toFixed(0) + ' Гц, ' + (r.samples.length / r.sampleRate).toFixed(2) + ' с');
});

console.log('Клонирование голоса (замкнутый цикл: синтез → анализ)');
const phrase = 'Съешь же ещё этих мягких французских булок, да выпей чаю. Широкая электрификация южных губерний даст мощный толчок подъёму сельского хозяйства.';
const noise = VS.Analyzer.measureNoise(new Float32Array(48000 * 2).map(() => (Math.random() - 0.5) * 0.002), 48000);
check('проверка тишины', noise.verdict === 'quiet', noise.medianDb.toFixed(1) + ' дБ');
const loud = VS.Analyzer.measureNoise(new Float32Array(48000 * 2).map(() => (Math.random() - 0.5) * 0.2), 48000);
check('обнаружение шума', loud.verdict === 'noisy', loud.medianDb.toFixed(1) + ' дБ');

const target = Object.assign({}, VS.Voices.PRESETS[1], { rate: 1.2 }); // «Мария», говорит быстрее
const t0 = Date.now();
const ph = VS.Analyzer.analyzePhrase(record(phrase, target), 48000, phrase, { noiseDb: -60 });
check('анализ фразы выполнен', ph.ok, (Date.now() - t0) + ' мс');
check('высота тона', Math.abs(ph.f0 - target.f0) / target.f0 < 0.08, ph.f0 + ' vs ' + target.f0);
check('масштаб формант по фразе', Math.abs(ph.scale - target.scale) < 0.08, ph.scale.toFixed(3) + ' vs ' + target.scale);
check('темп речи', Math.abs(ph.rate - target.rate) < 0.2, ph.rate.toFixed(2) + ' vs ' + target.rate);
// тембр сравниваем по результату: спектр голоса-копии должен совпасть со спектром оригинала
const tpl = VS.Prosody.plan(VS.G2P.parse(phrase), target, { seed: 1 });
const copy = Object.assign({}, target, { tilt: ph.tilt, oq: VS.Analyzer.oqFor(ph.tilt, ph.breath), breath: ph.breath });
const dTarget = VS.Analyzer.synthTiltDb(tpl, target), dCopy = VS.Analyzer.synthTiltDb(tpl, copy);
check('наклон спектра (тембр)', Math.abs(dTarget - dCopy) < 1.5, 'tilt ' + ph.tilt.toFixed(2) + ', breath ' + ph.breath.toFixed(3) + '; оригинал ' + dTarget.toFixed(1) + ' дБ, копия ' + dCopy.toFixed(1) + ' дБ');

const vw = VS.Analyzer.analyzeVowels(record('+А. +О. +У. +Э. +И. +Ы.', target, { speed: 0.35 }), 48000, { noiseDb: -60 });
check('найдено 6 гласных', vw.segmentsFound === 6 && vw.ok, 'сегментов ' + vw.segmentsFound + ', с формантами ' + vw.found);
check('масштаб формант по гласным', vw.scale && Math.abs(vw.scale - target.scale) < 0.08, (vw.scale || 0).toFixed(3) + ' vs ' + target.scale);
const refT = VS.Synth.vowelTable(target);
const errs = Object.keys(vw.formants).map((k) => Math.abs(vw.formants[k][1] / refT[k][1] - 1));
check('F2 гласных', errs.length && Math.max(...errs) < 0.12, 'макс. ошибка ' + (Math.max(...errs) * 100).toFixed(1) + '%');

const voice = VS.Analyzer.buildVoice('Тест', ph, vw);
const val = VS.Voices.validate(JSON.parse(JSON.stringify(voice)));
check('голос сохраняется и проходит проверку', val && val.formants && Object.keys(val.formants).length >= 4);
const out = VS.speak('Привет! Это мой новый голос. Нравится?', val, {});
check('синтез новым голосом', out.samples.length > 10000 && out.samples.every(isFinite));

console.log('\n' + passed + ' пройдено, ' + failed + ' с ошибкой');
process.exit(failed ? 1 : 0);
