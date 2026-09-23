/* Интерфейс синтезатора: синтез текста, мастер создания голоса, управление голосами. */
(function () {
  'use strict';
  const VS = window.VoiceSynth;
  const { DSP, Voices, Analyzer } = VS;
  const $ = (id) => document.getElementById(id);
  const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const STANDALONE = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;

  const PHRASE = 'Съешь же ещё этих мягких французских булок, да выпей чаю. ' +
    'Широкая электрификация южных губерний даст мощный толчок подъёму сельского хозяйства. ' +
    'Вы слышите, как меняется мой голос? Какая чудесная погода!';

  const EXAMPLES = [
    ['Повествование', 'Сегодня мы поедем за город.'],
    ['Общий вопрос', 'Вы сегодня пойдёте в кино?'],
    ['Вопрос со словом', 'Где ты был вчера вечером?'],
    ['А ты?', 'Я иду домой. А ты?'],
    ['Восклицание', 'Какая чудесная погода!'],
    ['Незавершённость', 'Если завтра будет дождь, мы останемся дома.'],
    ['Числа', 'В 2024 году было 366 дней.'],
  ];

  function store(key, val) {
    try {
      if (val === undefined) return localStorage.getItem(key);
      localStorage.setItem(key, val);
    } catch (e) { /* хранилище недоступно */ }
    return null;
  }

  // ---------------- Воспроизведение ----------------
  let actx = null;
  let current = null; // { src, startedAt, plan }
  // iOS: звук играет, даже если включён беззвучный режим (Safari 16.4+).
  function audioSession(type) {
    try { if (navigator.audioSession) navigator.audioSession.type = type; } catch (e) { /* не поддерживается */ }
  }
  // Контекст создаётся и «разблокируется» синхронно внутри обработчика нажатия —
  // иначе iOS Safari не даст ему играть.
  function ctx() {
    if (!actx) {
      audioSession('playback');
      actx = new (window.AudioContext || window.webkitAudioContext)();
      const b = actx.createBuffer(1, 1, 22050);
      const s = actx.createBufferSource();
      s.buffer = b;
      s.connect(actx.destination);
      s.start(0);
    }
    if (actx.state !== 'running') actx.resume();
    return actx;
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && actx && actx.state !== 'running') actx.resume();
  });
  function stop() {
    if (current && current.src) { try { current.src.stop(); } catch (e) { /* уже остановлен */ } }
    current = null;
  }
  function play(samples, fs, onEnd) {
    stop();
    const c = ctx();
    const buf = c.createBuffer(1, samples.length, fs);
    buf.getChannelData(0).set(samples);
    const src = c.createBufferSource();
    src.buffer = buf;
    src.connect(c.destination);
    const me = { src, startedAt: c.currentTime };
    src.onended = () => { if (current === me) current = null; if (onEnd) onEnd(); };
    current = me;
    src.start();
    return me;
  }

  // ---------------- Вкладки ----------------
  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + b.dataset.tab));
    if (b.dataset.tab === 'voices') renderCustomList();
    if (b.dataset.tab === 'synth') drawLast();
  }));

  // ---------------- Синтез ----------------
  let selectedId = store('voiceSynth.selected') || Voices.PRESETS[0].id;
  let last = null;

  const ex = $('examples');
  EXAMPLES.forEach(([name, text]) => {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = name;
    b.title = text;
    b.addEventListener('click', () => { $('text').value = text; speak(); });
    ex.appendChild(b);
  });

  function renderVoiceList() {
    const list = $('voiceList');
    list.innerHTML = '';
    const all = Voices.all();
    if (!all.find((v) => v.id === selectedId)) selectedId = Voices.PRESETS[0].id;
    all.forEach((v) => {
      const b = document.createElement('button');
      b.className = 'voice' + (v.id === selectedId ? ' sel' : '');
      const title = document.createElement('b');
      title.textContent = v.name;
      if (v.custom) { const t = document.createElement('i'); t.className = 'tag'; t.textContent = 'свой'; title.appendChild(t); }
      const d = document.createElement('span');
      d.textContent = (v.desc || '') + ' · ' + Math.round(v.f0) + ' Гц';
      b.append(title, d);
      b.addEventListener('click', () => {
        selectedId = v.id;
        store('voiceSynth.selected', v.id);
        renderVoiceList();
        speak();
      });
      list.appendChild(b);
    });
  }

  function bindRange(id, fmt) {
    const el = $(id), out = $(id + 'Out');
    const upd = () => { out.textContent = fmt(+el.value); };
    el.addEventListener('input', upd);
    upd();
  }
  bindRange('speed', (v) => v.toFixed(2));
  bindRange('pitch', (v) => (v > 0 ? '+' : '') + v);
  bindRange('expr', (v) => v.toFixed(2));
  bindRange('volume', (v) => v.toFixed(2));

  function opts() {
    return { speed: +$('speed').value, pitch: +$('pitch').value, expressiveness: +$('expr').value, volume: +$('volume').value };
  }

  function synthesize() {
    const text = $('text').value.trim();
    if (!text) return null;
    const voice = Voices.get(selectedId);
    const o = opts();
    const r = VS.speak(text, voice, o);
    last = { ...r, voice, opts: o };
    $('stressView').textContent = 'Ударения: ' + VS.G2P.stressMarked(r.parsed);
    $('trView').textContent = '[' + VS.G2P.transcribe(r.parsed) + ']';
    return last;
  }

  function speak() {
    ctx();
    const btn = $('btnSpeak');
    btn.disabled = true;
    setTimeout(() => {
      try {
        const r = synthesize();
        if (!r) return;
        drawPitch(r);
        const h = play(r.samples, r.sampleRate);
        animateCursor(r, h);
      } catch (e) {
        console.error(e);
        alert('Ошибка синтеза: ' + e.message);
      } finally {
        btn.disabled = false;
      }
    }, 10);
  }

  $('btnSpeak').addEventListener('click', speak);
  $('btnStop').addEventListener('click', stop);
  $('text').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) speak(); });
  $('btnWav').addEventListener('click', () => {
    const r = synthesize();
    if (!r) return;
    drawPitch(r);
    saveFile(new Blob([DSP.encodeWav(r.samples, r.sampleRate)], { type: 'audio/wav' }), 'rech-' + r.voice.id + '.wav');
  });
  $('showTr').addEventListener('change', (e) => $('trView').classList.toggle('hidden', !e.target.checked));

  // На iPhone файл удобнее всего сохранить через «Поделиться» → «Сохранить в Файлы».
  function saveFile(blob, name) {
    try {
      const file = new File([blob], name, { type: blob.type });
      if (IS_IOS && navigator.canShare && navigator.canShare({ files: [file] })) {
        navigator.share({ files: [file], title: name }).catch(() => { /* пользователь закрыл меню */ });
        return;
      }
    } catch (e) { /* File/share недоступны — обычная загрузка */ }
    download(blob, name);
  }

  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  // ---------------- График мелодики ----------------
  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

  function drawPitch(r, cursorMs) {
    const cv = $('pitchCanvas');
    const dpr = window.devicePixelRatio || 1;
    const W = cv.clientWidth || 600, H = 200;
    if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const pl = r.plan, voice = r.voice, o = r.opts;
    const total = pl.total;
    const base = voice.f0 * Math.pow(2, (o.pitch || 0) / 12);
    const lo = base * Math.pow(2, -10 / 12), hi = base * Math.pow(2, 15 / 12);
    const X = (t) => 8 + (W - 16) * t / total;
    const Y = (f) => H - 22 - (H - 40) * Math.log(f / lo) / Math.log(hi / lo);
    // сетка по октавам/квинтам
    g.strokeStyle = cssVar('--grid'); g.fillStyle = cssVar('--muted'); g.lineWidth = 1; g.font = '11px system-ui';
    [-7, 0, 7, 12].forEach((st) => {
      const f = base * Math.pow(2, st / 12);
      const y = Math.round(Y(f)) + 0.5;
      g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
      g.fillText(Math.round(f) + ' Гц', 4, y - 3);
    });
    // кривая ЧОТ на звонких участках
    g.strokeStyle = cssVar('--curve'); g.lineWidth = 2.5; g.lineCap = 'round';
    for (const u of pl.units) {
      if (u.pause) continue;
      const c = VS.Phonemes.CONS[u.ph.b];
      const voiced = !c || c.voiced;
      if (!voiced) continue;
      g.beginPath();
      for (let t = u.start; t <= u.start + u.dur; t += 5) {
        const f = VS.Synth.f0At(pl, voice, t, o);
        if (t === u.start) g.moveTo(X(t), Y(f)); else g.lineTo(X(t), Y(f));
      }
      g.stroke();
      if (u.ph.stressed) {
        const tm = u.start + u.dur / 2;
        g.fillStyle = cssVar('--curve');
        g.beginPath(); g.arc(X(tm), Y(VS.Synth.f0At(pl, voice, tm, o)), 3.5, 0, 6.3); g.fill();
      }
    }
    // подписи слов
    g.fillStyle = cssVar('--text'); g.font = '12px system-ui';
    let lastX = -100;
    for (const u of pl.units) {
      if (!u.word) continue;
      const x = X(u.start);
      if (x - lastX < 30) continue;
      g.fillText(u.word, x, H - 6);
      lastX = x + g.measureText(u.word).width;
    }
    if (cursorMs !== undefined) {
      g.strokeStyle = cssVar('--rec'); g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(X(cursorMs), 0); g.lineTo(X(cursorMs), H - 18); g.stroke();
    }
  }
  function drawLast() { if (last) drawPitch(last); }
  window.addEventListener('resize', drawLast);

  function animateCursor(r, h) {
    const step = () => {
      if (current !== h) { drawPitch(r); return; }
      const t = (actx.currentTime - h.startedAt) * 1000;
      drawPitch(r, Math.min(t, r.plan.total));
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // ---------------- Запись с микрофона ----------------
  class Recorder {
    // Всё до первого await выполняется прямо в обработчике нажатия — это важно для iOS.
    async start(onLevel) {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error(location.protocol === 'https:' || location.hostname === 'localhost'
          ? 'Браузер не даёт доступ к микрофону. Можно загрузить аудиофайл.'
          : 'Микрофон работает только на странице, открытой по https:// (например, через GitHub Pages). Можно загрузить аудиофайл.');
      }
      audioSession('play-and-record');
      this.ac = ctx();
      this.chunks = [];
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
        });
      } catch (e) {
        audioSession('playback');
        if (e && e.name === 'NotAllowedError') throw new Error('доступ запрещён. На iPhone: Настройки → Safari → Микрофон → «Разрешить».');
        throw e;
      }
      if (this.ac.state !== 'running') await this.ac.resume();
      this.fs = this.ac.sampleRate;
      const src = this.ac.createMediaStreamSource(this.stream);
      const proc = this.ac.createScriptProcessor(4096, 1, 1);
      const mute = this.ac.createGain();
      mute.gain.value = 0;
      proc.onaudioprocess = (e) => {
        const d = e.inputBuffer.getChannelData(0);
        this.chunks.push(new Float32Array(d));
        if (onLevel) onLevel(DSP.rms(d));
      };
      src.connect(proc);
      proc.connect(mute);
      mute.connect(this.ac.destination);
      this.nodes = [src, proc, mute];
    }
    async stop() {
      if (this.nodes) this.nodes.forEach((nd) => { try { nd.disconnect(); } catch (e) { /* уже отключён */ } });
      if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
      audioSession('playback');
      const n = this.chunks.reduce((s, c) => s + c.length, 0);
      const out = new Float32Array(n);
      let o = 0;
      for (const c of this.chunks) { out.set(c, o); o += c.length; }
      return { samples: out, fs: this.fs };
    }
  }

  function setMeter(id, rms) {
    const db = DSP.linToDb(rms);
    const pct = DSP.clamp((db + 70) / 60 * 100, 0, 100);
    const el = $(id);
    el.style.width = pct + '%';
    el.style.background = db > -3 ? cssVar('--bad') : db > -12 ? cssVar('--warn') : cssVar('--ok');
  }

  async function decodeFile(file) {
    const buf = await file.arrayBuffer();
    const ab = await new Promise((resolve, reject) => {
      const p = ctx().decodeAudioData(buf, resolve, (e) => reject(e || new Error('формат не поддерживается')));
      if (p && p.catch) p.catch(reject);
    });
    const n = ab.length;
    const mono = new Float32Array(n);
    for (let ch = 0; ch < ab.numberOfChannels; ch++) {
      const d = ab.getChannelData(ch);
      for (let i = 0; i < n; i++) mono[i] += d[i] / ab.numberOfChannels;
    }
    return { samples: mono, fs: ab.sampleRate };
  }

  function msg(id, html, cls) { $(id).innerHTML = cls ? '<span class="' + cls + '">' + html + '</span>' : html; }
  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c])); }

  // ---------------- Мастер «свой голос» ----------------
  const wiz = { noiseDb: undefined, phrase: null, phraseAudio: null, vowels: null, voice: null };
  $('phraseText').textContent = PHRASE;

  function goStep(n) {
    for (let i = 1; i <= 4; i++) $('step' + i).classList.toggle('hidden', i !== n);
    document.querySelectorAll('#steps li').forEach((li) => {
      const k = +li.dataset.step;
      li.classList.toggle('current', k === n);
      li.classList.toggle('done', k < n);
    });
  }

  function recordButton(btnId, meterId, maxSec, onDone) {
    const btn = $(btnId);
    let rec = null, timer = null, t0 = 0, tick = null;
    const label = btn.textContent;
    const finish = async () => {
      if (!rec) return;
      clearTimeout(timer); clearInterval(tick);
      const r = rec;
      rec = null;
      btn.classList.remove('on');
      btn.textContent = label;
      setMeter(meterId, 0);
      const res = await r.stop();
      onDone(res);
    };
    btn.addEventListener('click', async () => {
      if (rec) { finish(); return; }
      rec = new Recorder();
      try {
        await rec.start((l) => setMeter(meterId, l));
      } catch (e) {
        rec = null;
        onDone(null, e);
        return;
      }
      t0 = Date.now();
      btn.classList.add('on');
      btn.textContent = '■ Остановить (0 с)';
      tick = setInterval(() => { btn.textContent = '■ Остановить (' + Math.floor((Date.now() - t0) / 1000) + ' с)'; }, 250);
      timer = setTimeout(finish, maxSec * 1000);
    });
  }

  // Шаг 1: тишина
  $('btnNoise').addEventListener('click', async () => {
    const btn = $('btnNoise');
    btn.disabled = true;
    msg('noiseResult', 'Слушаю тишину… 3 секунды, пожалуйста, не говорите.');
    const rec = new Recorder();
    try {
      await rec.start((l) => setMeter('meter1', l));
    } catch (e) {
      btn.disabled = false;
      msg('noiseResult', 'Нет доступа к микрофону: ' + esc(e.message) + '<br>Можно пропустить проверку и загрузить готовые аудиофайлы.', 'bad');
      return;
    }
    await new Promise((res) => setTimeout(res, 3200));
    const { samples, fs } = await rec.stop();
    setMeter('meter1', 0);
    btn.disabled = false;
    const n = Analyzer.measureNoise(samples, fs);
    wiz.noiseDb = n.medianDb;
    const lvl = 'Уровень шума: ' + n.medianDb.toFixed(0) + ' дБ (пики ' + n.maxDb.toFixed(0) + ' дБ). ';
    if (n.verdict === 'quiet') {
      msg('noiseResult', lvl + 'Отлично, тихо! Переходим к записи.', 'ok');
      setTimeout(() => goStep(2), 900);
    } else if (n.verdict === 'ok') {
      msg('noiseResult', lvl + 'Приемлемо, но есть фоновый шум. Можно продолжать.', 'warn');
      setTimeout(() => goStep(2), 1500);
    } else {
      $('noiseResult').innerHTML = '<span class="bad">' + lvl + 'Слишком шумно — анализ голоса может получиться неточным. ' +
        'Найдите место потише и проверьте ещё раз.</span> <button class="btn ghost" id="btnNoiseAnyway">Всё равно продолжить</button>';
      $('btnNoiseAnyway').addEventListener('click', () => goStep(2));
    }
  });
  $('btnSkipNoise').addEventListener('click', () => { wiz.noiseDb = undefined; goStep(2); });

  // Шаг 2: фраза
  function handlePhrase(res, err) {
    if (err) { msg('rec2Info', 'Нет доступа к микрофону: ' + esc(err.message), 'bad'); return; }
    const dur = res.samples.length / res.fs;
    if (dur < 3) { msg('rec2Info', 'Запись слишком короткая (' + dur.toFixed(1) + ' с). Прочитайте фразу целиком.', 'bad'); return; }
    msg('rec2Info', 'Анализирую запись (' + dur.toFixed(1) + ' с)…');
    setTimeout(() => {
      try {
        const r = Analyzer.analyzePhrase(res.samples, res.fs, PHRASE, { noiseDb: wiz.noiseDb });
        if (!r.ok) { msg('rec2Info', r.error, 'bad'); return; }
        wiz.phrase = r;
        wiz.phraseAudio = res;
        msg('rec2Info', 'Готово: средняя высота ' + r.f0 + ' Гц, темп ×' + r.rate.toFixed(2) + '.', 'ok');
        setTimeout(() => goStep(3), 700);
      } catch (e) {
        console.error(e);
        msg('rec2Info', 'Ошибка анализа: ' + esc(e.message), 'bad');
      }
    }, 30);
  }
  recordButton('btnRec2', 'meter2', 40, handlePhrase);
  $('file2').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try { handlePhrase(await decodeFile(f)); } catch (er) { msg('rec2Info', 'Не удалось прочитать файл: ' + esc(er.message), 'bad'); }
    e.target.value = '';
  });

  // Шаг 3: гласные
  function handleVowels(res, err) {
    if (err) { msg('rec3Info', 'Нет доступа к микрофону: ' + esc(err.message), 'bad'); return; }
    msg('rec3Info', 'Измеряю форманты…');
    setTimeout(() => {
      try {
        const r = Analyzer.analyzeVowels(res.samples, res.fs, { noiseDb: wiz.noiseDb });
        if (!r.ok) {
          msg('rec3Info', 'Нашлось ' + r.segmentsFound + ' гласных из 6. Произнесите каждую протяжно, с чёткими паузами, и попробуйте ещё раз — или пропустите шаг.', 'warn');
          return;
        }
        wiz.vowels = r;
        finishWizard();
      } catch (e) {
        console.error(e);
        msg('rec3Info', 'Ошибка анализа: ' + esc(e.message), 'bad');
      }
    }, 30);
  }
  recordButton('btnRec3', 'meter3', 25, handleVowels);
  $('file3').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try { handleVowels(await decodeFile(f)); } catch (er) { msg('rec3Info', 'Не удалось прочитать файл: ' + esc(er.message), 'bad'); }
    e.target.value = '';
  });
  $('btnSkipVowels').addEventListener('click', () => { wiz.vowels = null; finishWizard(); });

  // Шаг 4: отчёт и сохранение
  const VOWEL_RU = { a: 'А', o: 'О', u: 'У', e: 'Э', i: 'И', y: 'Ы' };
  function finishWizard() {
    const name = $('voiceName').value.trim() || 'Мой голос';
    wiz.voice = Analyzer.buildVoice(name, wiz.phrase, wiz.vowels);
    const v = wiz.voice;
    const tract = (17.5 / v.scale).toFixed(1);
    const bright = v.tilt < 0.25 ? 'яркий, звонкий' : v.tilt < 0.55 ? 'сбалансированный' : 'мягкий, приглушённый';
    const cells = [
      [v.f0 + ' Гц', 'средняя высота (' + v.stats.f0Min + '–' + v.stats.f0Max + ' Гц)'],
      ['×' + v.range.toFixed(2), 'мелодический диапазон'],
      ['≈ ' + tract + ' см', 'длина речевого тракта (масштаб формант ×' + v.scale.toFixed(2) + ')'],
      [bright, 'тембр (наклон спектра ' + v.stats.tiltDb + ' дБ)'],
      [(v.breath * 100).toFixed(1) + ' %', 'придыхание'],
      ['×' + v.rate.toFixed(2), 'темп речи'],
    ];
    let html = '<div class="report">' + cells.map((c) => '<div><b>' + esc(c[0]) + '</b><span>' + esc(c[1]) + '</span></div>').join('') + '</div>';
    if (v.formants) {
      html += '<p class="small">Форманты гласных (F1 / F2 / F3, Гц): ' + Object.keys(v.formants).map((k) =>
        VOWEL_RU[k] + ' ' + v.formants[k].join('/')).join(' · ') + '</p>';
    } else {
      html += '<p class="small">Форманты оценены по фразе (шаг с гласными пропущен).</p>';
    }
    $('voiceReport').innerHTML = html;
    $('saveInfo').innerHTML = '';
    goStep(4);
  }

  $('btnTest').addEventListener('click', () => {
    if (!wiz.voice) return;
    wiz.voice.name = $('voiceName').value.trim() || 'Мой голос';
    const r = VS.speak($('testText').value, wiz.voice, {});
    play(r.samples, r.sampleRate);
  });
  $('btnPlayOrig').addEventListener('click', () => {
    if (wiz.phraseAudio) play(wiz.phraseAudio.samples, wiz.phraseAudio.fs);
  });
  $('btnSave').addEventListener('click', () => {
    if (!wiz.voice) return;
    wiz.voice.name = $('voiceName').value.trim() || 'Мой голос';
    const v = Voices.validate(wiz.voice);
    if (Voices.saveCustom(v)) {
      selectedId = v.id;
      store('voiceSynth.selected', v.id);
      renderVoiceList();
      msg('saveInfo', 'Голос «' + esc(v.name) + '» сохранён и выбран на вкладке «Синтез речи».', 'ok');
    } else {
      msg('saveInfo', 'Не удалось сохранить в браузере (хранилище недоступно). Используйте экспорт на вкладке «Мои голоса».', 'bad');
    }
  });
  $('btnRestart').addEventListener('click', () => {
    Object.assign(wiz, { noiseDb: undefined, phrase: null, phraseAudio: null, vowels: null, voice: null });
    ['noiseResult', 'rec2Info', 'rec3Info', 'saveInfo'].forEach((id) => { $(id).innerHTML = ''; });
    goStep(1);
  });

  // ---------------- Мои голоса ----------------
  function renderCustomList() {
    const box = $('customList');
    const arr = Voices.listCustom();
    box.innerHTML = '';
    if (!arr.length) {
      box.innerHTML = '<p class="hint">Пока нет своих голосов. Создайте голос на вкладке «Создать свой голос».</p>';
      return;
    }
    arr.forEach((v) => {
      const row = document.createElement('div');
      row.className = 'vrow';
      const info = document.createElement('div');
      info.innerHTML = '<b>' + esc(v.name) + '</b><div class="meta">' + Math.round(v.f0) + ' Гц · масштаб ×' + (+v.scale).toFixed(2) +
        ' · темп ×' + (+v.rate).toFixed(2) + (v.created ? ' · ' + esc(new Date(v.created).toLocaleDateString('ru-RU')) : '') + '</div>';
      const acts = document.createElement('div');
      acts.className = 'actions';
      const mk = (t, fn, cls) => { const b = document.createElement('button'); b.className = 'btn ' + (cls || ''); b.textContent = t; b.addEventListener('click', fn); acts.appendChild(b); };
      mk('▶', () => { const r = VS.speak('Привет! Это голос ' + v.name + '. Как он вам?', v, {}); play(r.samples, r.sampleRate); });
      mk('Выбрать', () => { selectedId = v.id; store('voiceSynth.selected', v.id); renderVoiceList(); document.querySelector('.tab[data-tab=synth]').click(); });
      mk('Экспорт', () => saveFile(new Blob([JSON.stringify(v, null, 2)], { type: 'application/json' }), 'golos-' + v.name.replace(/[^\wа-яё-]+/gi, '_') + '.json'), 'ghost');
      mk('Удалить', () => { if (confirm('Удалить голос «' + v.name + '»?')) { Voices.removeCustom(v.id); renderCustomList(); renderVoiceList(); } }, 'ghost');
      row.append(info, acts);
      box.appendChild(row);
    });
  }
  $('importFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const v = Voices.validate(JSON.parse(await f.text()));
      if (!v) throw new Error('неверный формат');
      if (Voices.all().some((x) => x.id === v.id && !x.custom)) v.id = 'custom-' + Date.now().toString(36);
      Voices.saveCustom(v);
      renderCustomList();
      renderVoiceList();
      msg('importInfo', 'Голос «' + esc(v.name) + '» импортирован.', 'ok');
    } catch (er) {
      msg('importInfo', 'Не удалось импортировать: ' + esc(er.message), 'bad');
    }
    e.target.value = '';
  });

  // Подсказка «установить на iPhone» и офлайн-режим
  if (IS_IOS && !STANDALONE) $('iosInstall').classList.remove('hidden');
  $('iosInstallClose').addEventListener('click', () => { $('iosInstall').classList.add('hidden'); store('voiceSynth.iosHint', '0'); });
  if (store('voiceSynth.iosHint') === '0') $('iosInstall').classList.add('hidden');
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Офлайн-режим недоступен:', e));
  }

  renderVoiceList();
  // Первичный расчёт графика без воспроизведения (автовоспроизведение браузеры запрещают)
  setTimeout(() => { try { const r = synthesize(); if (r) drawPitch(r); } catch (e) { console.error(e); } }, 50);
})();
