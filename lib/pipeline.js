'use strict';
// The conversion job: book -> chunks -> speech -> per-chapter files (-> single M4B).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chunkText } = require('./chunk');
const { WavWriter, silence, readWav, floatToPcm16 } = require('./wav');
const { loadKokoro } = require('./kokoro');
const { CloneEngine, isInstalled } = require('./clone');
const { ChapterEncoder, concatM4b, probeSeconds } = require('./ffmpeg');

const PREVIEW_TEXT = 'Once upon a time, in a land far, far away, there lived a storyteller who could turn any book into a voice. This is how yours will sound.';
const MAX_CHARS = { kokoro: 400, clone: 300 };
const CHARS_PER_SECOND = 16; // rough narration speed, used for estimates

// Output formats. Everything except WAV streams through ffmpeg; M4B is assembled from
// per-chapter AAC files without a second encode.
const FORMATS = {
  m4b: { ext: '.m4a', codec: 'm4a', needsFfmpeg: true },
  mp3: { ext: '.mp3', codec: 'mp3', needsFfmpeg: true },
  ogg: { ext: '.ogg', codec: 'ogg', needsFfmpeg: true },
  wav: { ext: '.wav', codec: null, needsFfmpeg: false },
};

const safeName = (s) => (s || 'Untitled').replace(/[<>:"/\\|?*]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Untitled';
const pad = (n, w) => String(n).padStart(w, '0');

let cloneEngine = null;
let tmpCounter = 0;

async function getSynth(job, emit) {
  const onStatus = (message) => emit({ type: 'status', message });
  if (job.engine === 'kokoro') {
    const tts = await loadKokoro({ cacheDir: job.cacheDir, onStatus });
    return async (text) => {
      const a = await tts.generate(text, { voice: job.voice || 'af_heart', speed: job.speed || 1 });
      return { pcm: floatToPcm16(a.audio), rate: a.sampling_rate };
    };
  }
  if (!isInstalled(job.venvDir)) throw new Error('Voice cloning is not set up yet. Use "Set up voice cloning" first.');
  if (!job.refAudio || !fs.existsSync(job.refAudio)) throw new Error('Choose or record a voice sample first.');
  if (!cloneEngine || cloneEngine.venvDir !== job.venvDir) {
    if (cloneEngine) cloneEngine.stop();
    cloneEngine = new CloneEngine({ venvDir: job.venvDir, script: job.cloneScript, onStatus, onLog: (l) => emit({ type: 'log', message: l }) });
  }
  cloneEngine.onStatus = onStatus;
  await cloneEngine.setReference(job.refAudio);
  return async (text) => {
    const tmp = path.join(os.tmpdir(), `booklark-${process.pid}-${tmpCounter++}.wav`);
    try {
      await cloneEngine.synth(text, tmp);
      return readWav(tmp);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  };
}

async function preview(job, emit) {
  const synth = await getSynth(job, emit);
  return synth(PREVIEW_TEXT);
}

function resolveFormat(job) {
  const name = job.format || (job.ffmpeg ? 'm4b' : 'wav');
  const format = FORMATS[name];
  if (!format) throw new Error(`Unknown output format "${name}". Use m4b, mp3, ogg or wav.`);
  if (format.needsFfmpeg && !job.ffmpeg) throw new Error('ffmpeg is needed for MP3, OGG and M4B output. Install ffmpeg, or choose WAV.');
  return { name, ...format };
}

async function convert(job, emit, isCancelled) {
  const { book } = job;
  const format = resolveFormat(job);
  const maxChars = MAX_CHARS[job.engine] || 400;
  const selected = book.chapters.filter((_, i) => !job.chapters || job.chapters.includes(i));
  if (!selected.length) throw new Error('No chapters selected.');
  const plan = selected.map((c) => ({ ...c, chunks: chunkText(c.text, maxChars) }));
  const totalChars = plan.reduce((n, c) => n + c.chunks.reduce((m, k) => m + k.text.length, 0), 0);

  const synth = await getSynth(job, emit);
  const bookDir = path.join(job.outDir, safeName(book.title));
  fs.mkdirSync(bookDir, { recursive: true });
  const width = String(plan.length).length;
  const parts = [];
  let doneChars = 0;
  let synthChars = 0;
  let synthStart = null;

  const progress = (i, j, extra = {}) => emit({
    type: 'progress',
    chapterIndex: i,
    chapterCount: plan.length,
    chapterTitle: plan[i].title,
    chunkIndex: j,
    chunkCount: plan[i].chunks.length,
    percent: totalChars ? (doneChars / totalChars) * 100 : 100,
    etaSeconds: synthChars > 200 ? (totalChars - doneChars) / (synthChars / ((Date.now() - synthStart) / 1000)) : null,
    ...extra,
  });

  // A chunk the engine cannot voice is retried once, then skipped with a warning, so one odd
  // line never kills a multi-hour job. Repeated failures mean the engine itself is broken.
  let consecutiveFailures = 0;
  let lastRate = 24000;
  const synthSafe = async (text) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const out = await synth(text);
        consecutiveFailures = 0;
        lastRate = out.rate;
        return out;
      } catch (err) {
        emit({ type: 'log', message: `Chunk failed (attempt ${attempt + 1}): ${err.message}` });
        if (attempt === 0) continue;
        if (++consecutiveFailures >= 3) throw new Error(`The voice engine keeps failing: ${err.message}`);
        emit({ type: 'warning', message: `Skipped a passage the voice engine could not read: "${text.slice(0, 60)}${text.length > 60 ? '…' : ''}"` });
        return { pcm: silence(0.5, lastRate), rate: lastRate };
      }
    }
  };

  const openWriter = (file, rate) => (format.codec
    ? new ChapterEncoder({ ffmpeg: job.ffmpeg, format: format.codec, file, rate })
    : new WavWriter(file, rate));
  const existingSeconds = (file) => {
    if (format.codec) return probeSeconds(file);
    const w = readWav(file);
    return w.pcm.length / 2 / w.rate;
  };

  for (let i = 0; i < plan.length; i++) {
    const ch = plan[i];
    const file = path.join(bookDir, `${pad(i + 1, width)} - ${safeName(ch.title)}${format.ext}`);
    const chapterChars = ch.chunks.reduce((n, k) => n + k.text.length, 0);
    if (fs.existsSync(file) && fs.statSync(file).size > 44) {
      parts.push({ file, title: ch.title, seconds: existingSeconds(file) });
      doneChars += chapterChars;
      progress(i, ch.chunks.length, { resumed: true });
      continue;
    }
    const tmp = `${file}.part`;
    let writer = null;
    let seconds;
    try {
      for (let j = 0; j < ch.chunks.length; j++) {
        if (isCancelled()) {
          if (writer) writer.abort();
          fs.rmSync(tmp, { force: true });
          emit({ type: 'cancelled' });
          return null;
        }
        progress(i, j);
        const chunk = ch.chunks[j];
        if (synthStart === null) synthStart = Date.now();
        const { pcm, rate } = await synthSafe(chunk.text);
        if (!writer) writer = openWriter(tmp, rate);
        await writer.write(pcm);
        await writer.write(silence(chunk.paraEnd ? 0.6 : 0.25, rate));
        doneChars += chunk.text.length;
        synthChars += chunk.text.length;
      }
      if (!writer) continue;
      await writer.write(silence(1.5, writer.rate));
      seconds = await writer.close();
    } catch (err) {
      if (writer) writer.abort();
      fs.rmSync(tmp, { force: true });
      throw err;
    }
    fs.renameSync(tmp, file);
    parts.push({ file, title: ch.title, seconds });
    progress(i, ch.chunks.length);
  }

  const result = { format: format.name, dir: bookDir, files: parts.map((p) => p.file), seconds: parts.reduce((n, p) => n + p.seconds, 0) };
  if (format.name === 'm4b' && parts.length) {
    emit({ type: 'status', message: 'Assembling the audiobook...' });
    const out = path.join(job.outDir, `${safeName(book.title)}.m4b`);
    await concatM4b({ ffmpeg: job.ffmpeg, parts, out, title: book.title, author: book.author, onLine: (l) => emit({ type: 'log', message: l }) });
    result.m4b = out;
    if (!job.keepChapters) {
      for (const p of parts) fs.rmSync(p.file, { force: true });
      if (fs.readdirSync(bookDir).length === 0) fs.rmdirSync(bookDir);
      result.files = [];
      result.dir = job.outDir;
    }
  }
  emit({ type: 'done', ...result });
  return result;
}

function estimateSeconds(book, chapters) {
  const chars = book.chapters.filter((_, i) => !chapters || chapters.includes(i)).reduce((n, c) => n + c.text.length, 0);
  return chars / CHARS_PER_SECOND;
}

function shutdown() { if (cloneEngine) cloneEngine.stop(); }

module.exports = { convert, preview, estimateSeconds, shutdown, PREVIEW_TEXT, FORMATS };
