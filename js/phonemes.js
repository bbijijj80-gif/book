/*
 * Фонемный инвентарь русского языка для формантного синтеза.
 * Значения формант — для «эталонного» мужского голоса; голоса масштабируют их.
 */
(function (g) {
  'use strict';
  const VS = g.VoiceSynth = g.VoiceSynth || {};

  // Гласные: F1, F2, F3 (Гц) и базовая длительность ударного варианта (мс).
  const VOWELS = {
    a: { F: [730, 1250, 2500], dur: 125, ipa: 'a' },
    o: { F: [530, 880, 2450], dur: 125, ipa: 'o' },
    u: { F: [340, 720, 2350], dur: 110, ipa: 'u' },
    e: { F: [520, 1820, 2550], dur: 120, ipa: 'e' },
    i: { F: [290, 2250, 3000], dur: 105, ipa: 'i' },
    y: { F: [330, 1500, 2400], dur: 110, ipa: 'ɨ' },
    // редуцированные
    A: { F: [620, 1200, 2500], dur: 80, ipa: 'ʌ', reduced: true },
    '@': { F: [480, 1350, 2450], dur: 55, ipa: 'ə', reduced: true },
    I: { F: [370, 1950, 2650], dur: 60, ipa: 'ɪ', reduced: true },
  };

  // Согласные. cls: stop / fric / affr / nasal / lat / trill / glide.
  const CONS = {
    p: { cls: 'stop', voiced: false, place: 'lab', dur: 80, ipa: 'p' },
    b: { cls: 'stop', voiced: true, place: 'lab', dur: 65, ipa: 'b' },
    t: { cls: 'stop', voiced: false, place: 'den', dur: 80, ipa: 't' },
    d: { cls: 'stop', voiced: true, place: 'den', dur: 65, ipa: 'd' },
    k: { cls: 'stop', voiced: false, place: 'vel', dur: 85, ipa: 'k' },
    g: { cls: 'stop', voiced: true, place: 'vel', dur: 65, ipa: 'g' },
    f: { cls: 'fric', voiced: false, place: 'lab', dur: 90, ipa: 'f' },
    v: { cls: 'fric', voiced: true, place: 'lab', dur: 60, ipa: 'v' },
    s: { cls: 'fric', voiced: false, place: 'den', dur: 100, ipa: 's' },
    z: { cls: 'fric', voiced: true, place: 'den', dur: 75, ipa: 'z' },
    S: { cls: 'fric', voiced: false, place: 'post', dur: 105, ipa: 'ʂ', hardOnly: true },
    Z: { cls: 'fric', voiced: true, place: 'post', dur: 80, ipa: 'ʐ', hardOnly: true },
    x: { cls: 'fric', voiced: false, place: 'vel', dur: 85, ipa: 'x' },
    ts: { cls: 'affr', voiced: false, place: 'den', dur: 110, ipa: 'ts', hardOnly: true },
    ch: { cls: 'affr', voiced: false, place: 'pal', dur: 115, ipa: 'tɕ', softOnly: true },
    sch: { cls: 'fric', voiced: false, place: 'pal', dur: 145, ipa: 'ɕː', softOnly: true },
    m: { cls: 'nasal', voiced: true, place: 'lab', dur: 65, ipa: 'm' },
    n: { cls: 'nasal', voiced: true, place: 'den', dur: 60, ipa: 'n' },
    l: { cls: 'lat', voiced: true, place: 'den', dur: 60, ipa: 'l' },
    r: { cls: 'trill', voiced: true, place: 'den', dur: 65, ipa: 'r' },
    j: { cls: 'glide', voiced: true, place: 'pal', dur: 55, ipa: 'j', softOnly: true },
  };

  const VOICE_PAIR = { p: 'b', t: 'd', k: 'g', f: 'v', s: 'z', S: 'Z', b: 'p', d: 't', g: 'k', v: 'f', z: 's', Z: 'S' };
  const VOICED_TRIGGERS = new Set(['b', 'd', 'g', 'z', 'Z']);
  const VOICELESS = new Set(['p', 't', 'k', 'f', 's', 'S', 'x', 'ts', 'ch', 'sch']);

  function isVowel(b) { return Object.prototype.hasOwnProperty.call(VOWELS, b); }
  function isObstruent(b) {
    const c = CONS[b];
    return !!c && (c.cls === 'stop' || c.cls === 'fric' || c.cls === 'affr');
  }
  function ipa(ph) {
    if (isVowel(ph.b)) return VOWELS[ph.b].ipa + (ph.stressed ? '́' : '');
    const c = CONS[ph.b];
    if (!c) return '?';
    let s = c.ipa;
    if (ph.soft && !c.softOnly && !c.hardOnly) s += 'ʲ';
    if (ph.long) s += 'ː';
    return s;
  }

  VS.Phonemes = { VOWELS, CONS, VOICE_PAIR, VOICED_TRIGGERS, VOICELESS, isVowel, isObstruent, ipa };

  if (typeof module !== 'undefined' && module.exports) module.exports = VS;
})(typeof globalThis !== 'undefined' ? globalThis : this);
