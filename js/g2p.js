/*
 * Преобразование русского текста в фонемы (без ИИ — по правилам орфоэпии):
 *  - числа прописью, латиница → кириллица;
 *  - ударение: разметка пользователя («+» перед гласной, знак ударения
 *    U+0301 или заглавная гласная: замОк), буква «ё», словарь, суффиксные правила;
 *  - аканье/иканье (редукция безударных), мягкость, йотация;
 *  - оглушение на конце слова и ассимиляция по звонкости;
 *  - разбиение на предложения и интонационные синтагмы.
 */
(function (g) {
  'use strict';
  const VS = g.VoiceSynth = g.VoiceSynth || {};
  const PH = VS.Phonemes;

  const VOWEL_LETTERS = 'аеёиоуыэюя';
  const isVowelLetter = (c) => VOWEL_LETTERS.indexOf(c) >= 0;
  const CONS_MAP = {
    б: 'b', в: 'v', г: 'g', д: 'd', ж: 'Z', з: 'z', й: 'j', к: 'k', л: 'l', м: 'm', н: 'n',
    п: 'p', р: 'r', с: 's', т: 't', ф: 'f', х: 'x', ц: 'ts', ч: 'ch', ш: 'S', щ: 'sch',
  };
  const VOWEL_MAP = { а: 'a', о: 'o', у: 'u', э: 'e', ы: 'y', и: 'i', е: 'e', ё: 'o', ю: 'u', я: 'a' };

  // Безударные служебные слова (клитики).
  const CLITICS = new Set(('в во на не ни и а но с со к ко по за из изо от ото до у о об обо ' +
    'же ж ли ль бы б под подо над надо при про без безо для через перед передо то ка либо').split(' '));

  // Вопросительные слова (ИК-2).
  const WH = new Set(('кто что где когда куда откуда почему зачем как какой какая какое какие какого ' +
    'каком какую каких сколько чей чья чьё чьи отчего насколько который которая которое которые').split(' '));
  // Слова восклицания (ИК-5).
  const EXCL = new Set('какой какая какое какие как сколько столько такой такая такое такие так'.split(' '));

  // Словарь ударений: «+» перед ударной гласной.
  const DICT_SRC = `
мен+я теб+я себ+я ег+о ем+у е+ё н+ам н+ас в+ас в+ам он+а он+о он+и им+и нег+о нем+у ни+ми ком+у чег+о чем+у ког+о
тог+о том+у всег+о всем+у себ+е теб+е мо+я мо+и мо+ё мо+его мо+ему тво+я тво+и тво+его сво+я сво+и сво+его сво+ей
куд+а когд+а тогд+а всегд+а никогд+а иногд+а сюд+а туд+а зач+ем почем+у потом+у сейч+ас тепер+ь пот+ом оп+ять уж+е
хорош+о пож+алуйста здр+авствуйте здр+авствуй прив+ет пок+а челов+ек рук+а голов+а вод+а земл+я стран+а
д+елать сд+елать д+умать д+умаю в+идеть сл+ушать раб+отать раб+отаю раб+отает хоч+у нельз+я был+а ид+у
любл+ю в+ечером вчер+а кин+о дел+а ост+анемся ост+аться молок+о как+ой как+ая как+ое как+ие как+ого так+ой так+ая
так+ое так+ие больш+ой больш+ая больш+ое больш+ие друг+ой друг+ая друг+ое друг+ие молод+ой дорог+ой дорог+а
од+ин одн+а одн+о одн+и дв+а дв+е тр+и чет+ыре в+осемь од+иннадцать двен+адцать трин+адцать чет+ырнадцать
пятн+адцать шестн+адцать семн+адцать восемн+адцать девятн+адцать дв+адцать тр+идцать с+орок пятьдес+ят шестьдес+ят
с+емьдесят в+осемьдесят девян+осто дв+ести тр+иста чет+ыреста пятьс+от шестьс+от семьс+от восемьс+от девятьс+от
т+ысяча т+ысячи т+ысяч милли+он милли+она милли+онов милли+ард милли+арда милли+ардов тр+иллион тр+иллиона
тр+иллионов н+оль втор+ой целых запят+ая проц+ент проц+ента проц+ентов мин+ус
поч+ти совс+ем давн+о м+едленно говор+ю говор+ит говор+ят говор+ишь сказ+ал скаж+и пон+ятно москв+а яз+ык
по+этому напр+имер прим+ер люб+овь рек+а окн+о кон+ец д+евушка д+евочка ж+енщина +улица жив+у зов+ут
нр+авится нр+авятся пож+аловать замеч+ательно хор+ошего хор+ошему в+ещи гол+осом г+олосом голос+а голос+ов
высот+а звуч+ит +около двер+ей вокр+уг ег+о ид+ём пойд+ём ид+ут мог+у м+ожешь смог+у
огор+од толч+ок дом+ой отв+ет вопр+ос вопр+осы отв+еты зд+есь сейч+ас пок+а спас+ибо
сл+ышите сл+ышишь сл+ышит сл+ышу сл+ышим сл+ышат нах+одитесь нах+одится нах+ожусь в+идите в+идишь в+идит в+ижу
говор+ите д+елаете д+елаешь д+умаете д+умаешь зн+аете зн+аешь пом+огите д+оброе утр+ом ид+ёте пойд+ёте
`;
  const DICT = new Map();
  DICT_SRC.split(/\s+/).filter(Boolean).forEach((w) => {
    const pos = w.indexOf('+');
    const clean = w.replace('+', '');
    if (pos < 0) return;
    let vi = 0;
    for (let i = 0; i < pos; i++) if (isVowelLetter(clean[i])) vi++;
    if (!DICT.has(clean)) DICT.set(clean, vi);
  });

  // Суффиксные правила: [регулярка, смещение ударной буквы в совпадении | -1 = гласная перед совпадением].
  const RULES = [
    [/ени(е|я|й|ю|и|ем|ями|ях|ям)$/, 0],
    [/ани(е|я|й|ю|и|ем|ями|ях|ям)$/, 0],
    [/ци(я|и|ю|ей|ям|ями|ях)$/, -1],
    [/(ость|остью|ости|остей|остям|остями|остях)$/, -1],
    [/иров(ать|ал|ала|али|ано|ан|ание)$/, 0],
    [/иру(ю|ет|ют|ешь|ем|ете)$/, 0],
    [/(тель|теля|телю|телем|тели|телей|телям|телями|телях)$/, -1],
    [/(ник|ника|нику|ником|ники|ников|ница|ницы)$/, -1],
    [/(ать|ять|еть|ить|уть|ыть)(ся)?$/, 0],
    [/(ова|ева)(ть|л|ла|ли|ло)(ся)?$/, 2],
    [/(ый|ий|ая|ое|ые|ого|ому|ым|ых|ыми|ую|ее|ие|его|ему|им|их|ими|яя|юю)$/, -1],
  ];

  function vowelIndexAt(word, charPos) {
    let vi = 0;
    for (let i = 0; i < charPos; i++) if (isVowelLetter(word[i])) vi++;
    return vi;
  }
  function countVowels(word) {
    let n = 0;
    for (const c of word) if (isVowelLetter(c)) n++;
    return n;
  }

  function findStress(word) {
    const n = countVowels(word);
    if (n === 0) return -1;
    const yo = word.indexOf('ё');
    if (yo >= 0) return vowelIndexAt(word, yo);
    if (n === 1) return 0;
    if (DICT.has(word)) return DICT.get(word);
    for (const [re, off] of RULES) {
      const m = re.exec(word);
      if (!m) continue;
      if (off >= 0) {
        const pos = m.index + off;
        if (isVowelLetter(word[pos])) return vowelIndexAt(word, pos);
      } else {
        const vi = vowelIndexAt(word, m.index) - 1;
        if (vi >= 0) return vi;
      }
    }
    return n === 2 ? 0 : n - 2;
  }

  // Орфоэпические замены (не меняют число гласных, поэтому индекс ударения сохраняется).
  const SPECIAL = {
    что: 'што', чтобы: 'штобы', ничто: 'ништо', конечно: 'конешно', скучно: 'скушно', нарочно: 'нарошно',
    сегодня: 'севодня', сегодняшний: 'севодняшний', солнце: 'сонце', чувство: 'чуство', чувствую: 'чуствую',
    лестница: 'лесница', праздник: 'празник', счастье: 'щастье', счастливый: 'щасливый', счастливо: 'щасливо',
    сердце: 'серце', здравствуйте: 'здраствуйте', здравствуй: 'здраствуй', булочная: 'булошная',
    яичница: 'яишница', пожалуйста: 'пожалуста',
  };
  const GO_EXCEPT = new Set(['много', 'немного', 'строго', 'дорого', 'недорого', 'убого', 'отлого', 'полого', 'итого', 'ого', 'благо']);

  function orthoFix(w) {
    if (SPECIAL[w]) return SPECIAL[w];
    if (/[ое]го$/.test(w) && w.length > 3 && !GO_EXCEPT.has(w)) w = w.slice(0, -2) + 'во';
    else if (w === 'его') w = 'ево';
    w = w.replace(/ться$/, 'ца').replace(/тся$/, 'ца');
    w = w.replace(/[сзж]ч/g, 'щ').replace(/г(к|ч)/g, 'х$1');
    w = w.replace(/стн/g, 'сн').replace(/здн/g, 'зн').replace(/стл/g, 'сл').replace(/вств/g, 'ств');
    w = w.replace(/лнц/g, 'нц').replace(/[нр][тд]ск/g, (m) => m[0] + 'ск').replace(/[тд]ск/g, 'цк');
    w = w.replace(/рдц/g, 'рц').replace(/рдч/g, 'рч');
    return w;
  }

  // Слово → последовательность фонем.
  function wordToPhones(word, stressIdx, clitic) {
    const out = [];
    const nV = countVowels(word);
    let vi = -1;
    for (let i = 0; i < word.length; i++) {
      const c = word[i];
      const prev = i > 0 ? word[i - 1] : '';
      const next = i + 1 < word.length ? word[i + 1] : '';
      if (isVowelLetter(c)) {
        vi++;
        const stressed = !clitic && vi === stressIdx;
        const iot = ('еёюя'.indexOf(c) >= 0 && (i === 0 || isVowelLetter(prev) || prev === 'ь' || prev === 'ъ')) ||
          (c === 'и' && prev === 'ь');
        if (iot) out.push({ b: 'j', soft: true });
        let base = VOWEL_MAP[c];
        const afterHard = prev === 'ж' || prev === 'ш' || prev === 'ц';
        if (c === 'и' && afterHard) base = 'y';
        const last = out.length ? out[out.length - 1] : null;
        const softCtx = !!last && !!last.soft && !PH.isVowel(last.b);
        let p = base;
        if (!stressed) {
          p = reduce(base, {
            softCtx,
            afterHard,
            pretonic: clitic || vi === stressIdx - 1,
            initial: out.length === 0 || (out.length === 1 && iot),
            final: i === word.length - 1,
          });
        }
        out.push({ b: p, v: true, stressed });
      } else if (CONS_MAP[c]) {
        const b = CONS_MAP[c];
        const def = PH.CONS[b];
        let j = i;
        let long = false;
        if (next === c && c !== 'й') { long = true; j = i + 1; }
        const after = j + 1 < word.length ? word[j + 1] : '';
        let soft;
        if (def.softOnly) soft = true;
        else if (def.hardOnly) soft = false;
        else soft = !!after && 'ьеёиюя'.indexOf(after) >= 0;
        out.push({ b, soft, long });
        i = j;
      }
      // ь и ъ сами по себе не звучат
    }
    return out;
  }

  function reduce(base, ctx) {
    if (base === 'u' || base === 'i' || base === 'y') return base;
    if (ctx.softCtx) return ctx.final ? '@' : 'I';
    if (ctx.afterHard) return base === 'e' ? 'y' : (ctx.pretonic ? 'A' : '@');
    if (base === 'e') return 'I';
    if (ctx.pretonic || ctx.initial) return 'A';
    return '@';
  }

  // Ассимиляция по звонкости/глухости и оглушение на конце слова (справа налево).
  function assimilate(phones) {
    for (let i = phones.length - 1; i >= 0; i--) {
      const p = phones[i];
      if (!PH.isObstruent(p.b)) continue;
      const nx = phones[i + 1];
      const wordFinal = !nx || nx.w !== p.w;
      if (nx && PH.isObstruent(nx.b) && !p.procl) {
        if (PH.VOICED_TRIGGERS.has(nx.b)) { if (PH.VOICE_PAIR[p.b] && PH.VOICELESS.has(p.b)) p.b = PH.VOICE_PAIR[p.b]; continue; }
        if (PH.VOICELESS.has(nx.b)) { if (!PH.VOICELESS.has(p.b) && PH.VOICE_PAIR[p.b]) p.b = PH.VOICE_PAIR[p.b]; continue; }
      } else if (nx && PH.isObstruent(nx.b) && p.procl) {
        if (PH.VOICELESS.has(nx.b) && !PH.VOICELESS.has(p.b) && PH.VOICE_PAIR[p.b]) p.b = PH.VOICE_PAIR[p.b];
        else if (PH.VOICED_TRIGGERS.has(nx.b) && PH.VOICELESS.has(p.b) && PH.VOICE_PAIR[p.b]) p.b = PH.VOICE_PAIR[p.b];
        continue;
      }
      if (wordFinal && !p.procl && !PH.VOICELESS.has(p.b) && PH.VOICE_PAIR[p.b]) p.b = PH.VOICE_PAIR[p.b];
    }
    return phones;
  }

  // ---------- Числа прописью ----------
  const ONES = ['ноль', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
  const ONES_F = ['ноль', 'одна', 'две', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
  const TEENS = ['десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать',
    'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать'];
  const TENS = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто'];
  const HUNDREDS = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот'];

  function plural(n, one, few, many) {
    const n100 = n % 100, n10 = n % 10;
    if (n100 >= 11 && n100 <= 19) return many;
    if (n10 === 1) return one;
    if (n10 >= 2 && n10 <= 4) return few;
    return many;
  }
  function triple(n, fem) {
    const w = [];
    const h = Math.floor(n / 100), t = Math.floor((n % 100) / 10), o = n % 10;
    if (h) w.push(HUNDREDS[h]);
    if (t === 1) w.push(TEENS[o]);
    else {
      if (t) w.push(TENS[t]);
      if (o) w.push((fem ? ONES_F : ONES)[o]);
    }
    return w;
  }
  function numberToWords(str) {
    str = str.replace(/^0+(?=\d)/, '');
    if (str.length > 15) return str.split('').map((d) => ONES[+d]).join(' ');
    let n = Number(str);
    if (n === 0) return 'ноль';
    const scales = [
      [1e12, ['триллион', 'триллиона', 'триллионов'], false],
      [1e9, ['миллиард', 'миллиарда', 'миллиардов'], false],
      [1e6, ['миллион', 'миллиона', 'миллионов'], false],
      [1e3, ['тысяча', 'тысячи', 'тысяч'], true],
    ];
    const words = [];
    for (const [val, forms, fem] of scales) {
      const k = Math.floor(n / val);
      if (k) {
        words.push(...triple(k, fem), plural(k, forms[0], forms[1], forms[2]));
        n -= k * val;
      }
    }
    if (n) words.push(...triple(n, false));
    return words.join(' ');
  }

  // ---------- Латиница → кириллица (грубая транслитерация) ----------
  const LAT2 = { sh: 'ш', ch: 'ч', zh: 'ж', th: 'т', ph: 'ф', kh: 'х', ts: 'ц', oo: 'у', ee: 'и', ya: 'я', yu: 'ю', yo: 'ё', ck: 'к' };
  const LAT1 = { a: 'а', b: 'б', c: 'к', d: 'д', e: 'е', f: 'ф', g: 'г', h: 'х', i: 'и', j: 'дж', k: 'к', l: 'л', m: 'м',
    n: 'н', o: 'о', p: 'п', q: 'к', r: 'р', s: 'с', t: 'т', u: 'у', v: 'в', w: 'в', x: 'кс', y: 'и', z: 'з' };
  function translit(word) {
    let out = '';
    for (let i = 0; i < word.length; i++) {
      const two = word.substr(i, 2).toLowerCase();
      if (LAT2[two]) { out += LAT2[two]; i++; continue; }
      const c = word[i];
      const low = c.toLowerCase();
      if (LAT1[low]) out += (c !== low ? LAT1[low].toUpperCase() : LAT1[low]);
      else out += c;
    }
    return out;
  }

  // ---------- Нормализация текста ----------
  function normalize(text) {
    let t = String(text || '');
    t = t.replace(/\r/g, '');
    t = t.replace(/([аеёиоуыэюяАЕЁИОУЫЭЮЯ])́/g, '+$1');
    t = t.replace(/(\d+)\s*%/g, (m, d) => numberToWords(d) + ' ' + plural(+d.slice(-2) % 100, 'процент', 'процента', 'процентов'));
    t = t.replace(/(\d+)[.,](\d+)/g, (m, a, b) => numberToWords(a) + ' запятая ' + numberToWords(b));
    t = t.replace(/\d+/g, (m) => ' ' + numberToWords(m) + ' ');
    t = t.replace(/[A-Za-z]+/g, translit);
    t = t.replace(/\s[-–—]+\s/g, ' — ').replace(/^[-–—]+\s/gm, '');
    t = t.replace(/\.\.\./g, '…');
    return t;
  }

  // Извлечь ударение, размеченное пользователем.
  function readMarkedWord(raw) {
    let marked = null;
    let w = raw;
    const plus = w.indexOf('+');
    if (plus >= 0) {
      const clean = w.replace(/\+/g, '');
      marked = vowelIndexAt(clean, plus);
      w = clean;
    } else {
      // «замОк»: единственная заглавная гласная не в начале слова
      const ups = [];
      for (let i = 0; i < w.length; i++) if (isVowelLetter(w[i].toLowerCase()) && w[i] !== w[i].toLowerCase()) ups.push(i);
      const lowerRest = w.slice(1) !== w.slice(1).toUpperCase();
      if (ups.length === 1 && ups[0] > 0 && lowerRest) marked = vowelIndexAt(w.toLowerCase(), ups[0]);
    }
    w = w.toLowerCase();
    if (marked !== null && marked >= countVowels(w)) marked = null;
    return { word: w, marked };
  }

  function makeWord(raw, hyphenTail) {
    const { word, marked } = readMarkedWord(raw);
    const nV = countVowels(word);
    const clitic = marked === null && (CLITICS.has(word) || (hyphenTail && (word === 'то' || word === 'ка' || word === 'либо'))) && nV <= 2;
    const stressIdx = clitic ? -1 : (marked !== null ? marked : findStress(word));
    const spoken = orthoFix(word);
    const phones = wordToPhones(spoken, stressIdx, clitic);
    return { text: word, stressIdx, clitic, wh: WH.has(word), excl: EXCL.has(word), nV, phones, procl: nV === 0 };
  }

  const PAUSE_PUNCT = { ',': ',', ';': ';', ':': ':', '—': '—', '(': ',', ')': ',', '«': '', '»': '', '"': '' };

  // Текст → предложения → синтагмы → слова → фонемы.
  function parse(text) {
    const norm = normalize(text);
    const re = /[A-Za-zА-Яа-яЁё+]+(?:-[A-Za-zА-Яа-яЁё+]+)*|[.!?…]+|[,;:—()«»"]|\n+/g;
    const sentences = [];
    let phrase = { words: [], end: null };
    let sentence = { phrases: [], type: 'statement' };
    const closePhrase = (end) => {
      if (phrase.words.length) { phrase.end = end; sentence.phrases.push(phrase); }
      phrase = { words: [], end: null };
    };
    const closeSentence = (type, end) => {
      closePhrase(end);
      if (sentence.phrases.length) { sentence.type = type; sentence.end = end; sentences.push(sentence); }
      sentence = { phrases: [], type: 'statement' };
    };
    let m;
    while ((m = re.exec(norm))) {
      const tok = m[0];
      if (/^[.!?…]+$/.test(tok)) {
        const type = tok.indexOf('?') >= 0 ? 'question' : tok.indexOf('!') >= 0 ? 'exclamation' : tok.indexOf('…') >= 0 ? 'ellipsis' : 'statement';
        closeSentence(type, tok);
      } else if (/^\n+$/.test(tok)) {
        if (phrase.words.length || sentence.phrases.length) closeSentence('statement', '\n');
      } else if (PAUSE_PUNCT[tok] !== undefined) {
        if (PAUSE_PUNCT[tok]) closePhrase(PAUSE_PUNCT[tok]);
      } else {
        const parts = tok.split('-');
        parts.forEach((p, k) => { if (/[A-Za-zА-Яа-яЁё]/.test(p)) phrase.words.push(makeWord(p, k > 0)); });
      }
    }
    closeSentence('statement', '');

    // Фонологическая обработка на уровне синтагмы.
    for (const s of sentences) {
      for (const ph of s.phrases) {
        const flat = [];
        ph.words.forEach((w, wi) => w.phones.forEach((p) => { p.w = wi; p.procl = w.procl; flat.push(p); }));
        assimilate(flat);
      }
    }
    return sentences;
  }

  function transcribe(sentences) {
    return sentences.map((s) => s.phrases.map((ph) => ph.words.map((w) => w.phones.map(PH.ipa).join('')).join(' ')).join(' | ')).join(' ‖ ');
  }

  function stressMarked(sentences) {
    return sentences.map((s) => s.phrases.map((ph) => ph.words.map((w) => {
      if (w.stressIdx < 0) return w.text;
      let vi = -1, out = '';
      for (const c of w.text) {
        if (isVowelLetter(c)) { vi++; if (vi === w.stressIdx && w.nV > 1) { out += c.toUpperCase(); continue; } }
        out += c;
      }
      return out;
    }).join(' ')).join(', ') + (s.end && s.end !== '\n' ? s.end : '.')).join(' ');
  }

  VS.G2P = { parse, normalize, numberToWords, findStress, transcribe, stressMarked, countVowels, WH };

  if (typeof module !== 'undefined' && module.exports) module.exports = VS;
})(typeof globalThis !== 'undefined' ? globalThis : this);
