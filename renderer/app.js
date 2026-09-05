'use strict';
const $ = (s) => document.querySelector(s);
const state = {
  file: null, book: null, selected: new Set(),
  engine: 'kokoro', voice: 'af_heart', speed: 1, ref: null,
  outDir: '', format: 'm4b', keepChapters: false, env: null, running: false, previewing: false,
};

const FORMATS = {
  m4b: { label: 'M4B audiobook: one file with chapters', hint: 'Chapters are encoded to AAC as they are narrated and joined into a single .m4b. Nothing uncompressed is written.' },
  mp3: { label: 'MP3: one file per chapter', hint: 'About 30 MB per hour. Plays anywhere.' },
  ogg: { label: 'OGG (Opus): one file per chapter, smallest', hint: 'About 18 MB per hour. Best quality per megabyte for speech.' },
  wav: { label: 'WAV: one file per chapter', hint: 'Uncompressed, about 170 MB per hour. Install ffmpeg to get MP3, OGG or M4B instead.' },
};

function fillFormats() {
  const sel = $('#format');
  for (const id of ['m4b', 'mp3', 'ogg', 'wav']) {
    const o = document.createElement('option');
    o.value = id;
    o.textContent = FORMATS[id].label;
    if (id !== 'wav' && !state.env.ffmpeg) { o.disabled = true; o.textContent += ' (needs ffmpeg)'; }
    sel.appendChild(o);
  }
  state.format = state.env.ffmpeg ? 'm4b' : 'wav';
  sel.value = state.format;
  updateFormatUI();
}

function updateFormatUI() {
  $('#formatHint').textContent = state.env.ffmpeg
    ? FORMATS[state.format].hint
    : 'ffmpeg was not found on this computer. Install it and restart Narrata to enable M4B, MP3 and OGG output.';
  $('#keepChaptersLabel').hidden = state.format !== 'm4b';
}

const fmtDuration = (s) => {
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
};

function fillVoices() {
  const sel = $('#voice');
  const groups = new Map();
  for (const v of state.env.voices) {
    const key = `${v.accent} · ${v.gender}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(v);
  }
  for (const [label, voices] of groups) {
    const og = document.createElement('optgroup');
    og.label = label;
    for (const v of voices) {
      const o = document.createElement('option');
      o.value = v.id;
      o.textContent = `${v.name}  (quality ${v.grade})`;
      og.appendChild(o);
    }
    sel.appendChild(og);
  }
  sel.value = state.voice;
}

function renderBook() {
  const { book } = state;
  $('#bookInfo').hidden = !book;
  if (!book) return;
  $('#bookTitle').textContent = book.title;
  $('#bookMeta').textContent = [book.author, `${book.chapters.length} sections`].filter(Boolean).join(' · ');
  const list = $('#chapters');
  list.innerHTML = '';
  book.chapters.forEach((c, i) => {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = state.selected.has(i);
    cb.onchange = () => { cb.checked ? state.selected.add(i) : state.selected.delete(i); updateSummary(); };
    const name = document.createElement('span');
    name.textContent = c.title;
    const len = document.createElement('span');
    len.className = 'len';
    len.textContent = fmtDuration(c.chars / 16);
    label.append(cb, name, len);
    list.appendChild(label);
  });
  updateSummary();
}

function updateSummary() {
  const chars = state.book.chapters.reduce((n, c, i) => n + (state.selected.has(i) ? c.chars : 0), 0);
  $('#chapterSummary').textContent = `${state.selected.size} of ${state.book.chapters.length} selected · about ${fmtDuration(chars / 16)} of audio`;
}

function refreshCloneUI() {
  const { env } = state;
  const ready = env.cloneReady;
  $('#cloneSetup').hidden = ready;
  $('#cloneSample').hidden = !ready;
  $('#cloneSetupText').textContent = env.python
    ? `One-time setup: creates a private Python environment and downloads Chatterbox Turbo (about 2 GB). Found Python ${env.python.version}.`
    : 'Voice cloning needs Python 3.10 or newer installed on this computer. Install Python, then restart Narrata.';
  $('#installClone').disabled = !env.python;
}

function setRunning(running) {
  state.running = running;
  for (const id of ['#pickBook', '#preview', '#start', '#installClone', '#pickRef', '#record', '#pickOutDir']) $(id).disabled = running;
  $('#cancel').hidden = !running;
  $('#progress').hidden = !running;
}

function showError(msg) {
  const box = $('#errorBox');
  box.hidden = !msg;
  box.textContent = msg || '';
}

function handleEvent(ev) {
  switch (ev.type) {
    case 'status': $('#status').textContent = ev.message; if (state.previewing) $('#previewStatus').textContent = ev.message; break;
    case 'log': console.log('[engine]', ev.message); break;
    case 'warning': $('#status').textContent = ev.message; console.warn(ev.message); break;
    case 'progress': {
      $('#barFill').style.width = `${ev.percent.toFixed(1)}%`;
      const eta = ev.etaSeconds ? ` · about ${fmtDuration(ev.etaSeconds)} left` : '';
      $('#progressText').textContent = `Chapter ${ev.chapterIndex + 1} of ${ev.chapterCount}: ${ev.chapterTitle} · ${ev.percent.toFixed(0)}%${eta}`;
      $('#status').textContent = ev.resumed ? 'Skipping a chapter that already exists' : `Narrating part ${Math.min(ev.chunkIndex + 1, ev.chunkCount)} of ${ev.chunkCount}`;
      break;
    }
    case 'done': {
      setRunning(false);
      $('#status').textContent = '';
      $('#result').hidden = false;
      const target = ev.m4b || ev.dir;
      $('#resultText').textContent = `${fmtDuration(ev.seconds)} of audio → ${target}`;
      $('#openResult').onclick = () => (ev.m4b ? narrata.showInFolder(ev.m4b) : narrata.openPath(ev.dir));
      break;
    }
    case 'cancelled': setRunning(false); $('#status').textContent = 'Cancelled. Finished chapters were kept and will be reused next time.'; break;
    case 'error': setRunning(false); $('#status').textContent = ''; showError(ev.message); break;
  }
}

// ---- recording a voice sample (Web Audio, written out as WAV by the main process)
let rec = null;
async function startRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false } });
  const ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const mute = ctx.createGain();
  mute.gain.value = 0;
  const chunks = [];
  proc.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  src.connect(proc); proc.connect(mute); mute.connect(ctx.destination);
  rec = { stream, ctx, proc, chunks, started: Date.now() };
  rec.timer = setInterval(() => { $('#recTime').textContent = `Recording… ${((Date.now() - rec.started) / 1000).toFixed(0)} s`; }, 250);
  $('#record').hidden = true;
  $('#stopRecord').hidden = false;
}
async function stopRecording() {
  const { stream, ctx, proc, chunks, timer } = rec;
  clearInterval(timer);
  proc.disconnect();
  stream.getTracks().forEach((t) => t.stop());
  const rate = ctx.sampleRate;
  await ctx.close();
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const merged = new Float32Array(total);
  let o = 0;
  for (const c of chunks) { merged.set(c, o); o += c.length; }
  rec = null;
  $('#record').hidden = false;
  $('#stopRecord').hidden = true;
  $('#recTime').textContent = '';
  state.ref = await narrata.saveRecording(merged.buffer, rate);
  $('#refInfo').textContent = `Recorded ${(total / rate).toFixed(1)} s → ${state.ref}`;
}

function voiceOptions() {
  return { engine: state.engine, voice: state.voice, speed: state.speed, refAudio: state.ref };
}

function checkVoiceReady() {
  if (state.engine === 'clone' && !state.env.cloneReady) return 'Set up voice cloning first.';
  if (state.engine === 'clone' && !state.ref) return 'Choose or record a voice sample first.';
  return null;
}

async function init() {
  state.env = await narrata.env();
  state.outDir = state.env.defaultOutDir;
  $('#outDir').textContent = state.outDir;
  fillVoices();
  fillFormats();
  refreshCloneUI();
  narrata.onEvent(handleEvent);
  narrata.onInstallLog((line) => {
    const log = $('#installLog');
    log.hidden = false;
    log.textContent += line + '\n';
    log.scrollTop = log.scrollHeight;
  });

  $('#pickBook').onclick = async () => {
    showError(null);
    try {
      const res = await narrata.pickBook();
      if (!res) return;
      state.file = res.file;
      state.book = res.book;
      state.selected = new Set(res.book.chapters.map((_, i) => i));
      $('#result').hidden = true;
      renderBook();
    } catch (e) { showError(e.message); }
  };
  $('#selectAll').onclick = (e) => { e.preventDefault(); state.selected = new Set(state.book.chapters.map((_, i) => i)); renderBook(); };
  $('#selectNone').onclick = (e) => { e.preventDefault(); state.selected.clear(); renderBook(); };

  document.querySelectorAll('input[name=engine]').forEach((r) => {
    r.onchange = () => {
      state.engine = r.value;
      $('#kokoroBox').hidden = state.engine !== 'kokoro';
      $('#cloneBox').hidden = state.engine !== 'clone';
    };
  });
  $('#voice').onchange = (e) => { state.voice = e.target.value; };
  $('#speed').oninput = (e) => { state.speed = Number(e.target.value); $('#speedValue').textContent = `${state.speed.toFixed(2)}×`; };

  $('#installClone').onclick = async () => {
    showError(null);
    $('#installClone').disabled = true;
    $('#installStatus').textContent = 'Installing… this takes a few minutes.';
    try {
      await narrata.installClone();
      state.env.cloneReady = true;
      refreshCloneUI();
    } catch (e) {
      showError(e.message);
      $('#installStatus').textContent = 'Setup failed.';
    } finally { $('#installClone').disabled = false; }
  };
  $('#pickRef').onclick = async () => {
    const f = await narrata.pickAudio();
    if (f) { state.ref = f; $('#refInfo').textContent = f; }
  };
  $('#record').onclick = () => startRecording().catch((e) => showError(`Could not start recording: ${e.message}`));
  $('#stopRecord').onclick = () => stopRecording().catch((e) => showError(e.message));

  $('#preview').onclick = async () => {
    showError(null);
    const problem = checkVoiceReady();
    if (problem) return showError(problem);
    state.previewing = true;
    $('#preview').disabled = true;
    $('#previewStatus').textContent = 'Generating preview…';
    try {
      const { pcm, rate } = await narrata.preview(voiceOptions());
      const bytes = Uint8Array.from(atob(pcm), (c) => c.charCodeAt(0));
      const header = new DataView(new ArrayBuffer(44));
      const str = (o, s) => [...s].forEach((ch, i) => header.setUint8(o + i, ch.charCodeAt(0)));
      str(0, 'RIFF'); header.setUint32(4, 36 + bytes.length, true); str(8, 'WAVE'); str(12, 'fmt ');
      header.setUint32(16, 16, true); header.setUint16(20, 1, true); header.setUint16(22, 1, true);
      header.setUint32(24, rate, true); header.setUint32(28, rate * 2, true); header.setUint16(32, 2, true); header.setUint16(34, 16, true);
      str(36, 'data'); header.setUint32(40, bytes.length, true);
      const blob = new Blob([header, bytes], { type: 'audio/wav' });
      const audio = new Audio(URL.createObjectURL(blob));
      audio.onended = () => URL.revokeObjectURL(audio.src);
      await audio.play();
      $('#previewStatus').textContent = '';
    } catch (e) {
      showError(e.message);
      $('#previewStatus').textContent = '';
    } finally {
      state.previewing = false;
      $('#preview').disabled = state.running;
    }
  };

  $('#pickOutDir').onclick = async () => {
    const d = await narrata.pickOutDir(state.outDir);
    if (d) { state.outDir = d; $('#outDir').textContent = d; }
  };
  $('#format').onchange = (e) => { state.format = e.target.value; updateFormatUI(); };
  $('#keepChapters').onchange = (e) => { state.keepChapters = e.target.checked; };

  $('#start').onclick = async () => {
    showError(null);
    if (!state.book) return showError('Choose an ebook first.');
    if (!state.selected.size) return showError('Select at least one chapter.');
    const problem = checkVoiceReady();
    if (problem) return showError(problem);
    $('#result').hidden = true;
    $('#barFill').style.width = '0%';
    $('#progressText').textContent = 'Starting…';
    setRunning(true);
    try {
      await narrata.start({ file: state.file, chapters: [...state.selected].sort((a, b) => a - b), outDir: state.outDir, format: state.format, keepChapters: state.keepChapters, ...voiceOptions() });
    } catch (e) {
      setRunning(false);
      showError(e.message);
    }
  };
  $('#cancel').onclick = () => { narrata.cancel(); $('#status').textContent = 'Cancelling after the current part…'; };
}

init().catch((e) => showError(e.message));
