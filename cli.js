#!/usr/bin/env node
'use strict';
// Command-line front end to the same pipeline the desktop app uses.
//   node cli.js book.epub                      list chapters
//   node cli.js book.epub --out ./out          narrate with Kokoro (af_heart)
//   node cli.js book.epub --out ./out --voice bm_george --speed 1.1 --chapters 2-5,8
//   node cli.js book.epub --out ./out --ref sample.wav   clone the voice in sample.wav
//   node cli.js book.epub --out ./out --format ogg       m4b (default with ffmpeg), mp3, ogg or wav
const os = require('node:os');
const path = require('node:path');
const { parseBook } = require('./lib/book');
const { findFfmpeg } = require('./lib/ffmpeg');
const pipeline = require('./lib/pipeline');
const { migrateUserData } = require('./lib/migrate');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const file = args.find((a) => !a.startsWith('--') && !args.includes(`--${args[args.indexOf(a) - 1]?.slice(2)}`) );
if (!file) { console.error('usage: node cli.js <book> [--out dir] [--format m4b|mp3|ogg|wav] [--voice id] [--speed n] [--ref sample.wav] [--chapters 1,3-5] [--keep-chapters]'); process.exit(1); }

const book = parseBook(file);
const outDir = opt('out');
const chapters = opt('chapters') ? opt('chapters').split(',').flatMap((r) => {
  const [a, b] = r.split('-').map(Number);
  return b ? Array.from({ length: b - a + 1 }, (_, i) => a - 1 + i) : [a - 1];
}) : null;

if (!outDir) {
  console.log(`${book.title}${book.author ? ` — ${book.author}` : ''}`);
  book.chapters.forEach((c, i) => console.log(`${String(i + 1).padStart(3)}  ${c.title}  (${c.text.length} chars)`));
  console.log(`\nabout ${(pipeline.estimateSeconds(book) / 60).toFixed(0)} min of audio`);
  process.exit(0);
}

const home = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
const userData = path.join(home, 'booklark');
migrateUserData(userData, 'narrata');
const job = {
  book, outDir, chapters,
  engine: opt('ref') ? 'clone' : 'kokoro',
  voice: opt('voice', 'af_heart'), speed: Number(opt('speed', 1)), refAudio: opt('ref'),
  format: opt('format'), keepChapters: args.includes('--keep-chapters'),
  cacheDir: path.join(userData, 'models'), venvDir: path.join(userData, 'venv'),
  cloneScript: path.join(__dirname, 'python', 'booklark_tts.py'), ffmpeg: findFfmpeg(),
};

let cancelled = false;
process.on('SIGINT', () => { cancelled = true; console.log('\ncancelling…'); });
pipeline.convert(job, (ev) => {
  if (ev.type === 'status') console.log(ev.message);
  else if (ev.type === 'warning') console.log(`\nwarning: ${ev.message}`);
  else if (ev.type === 'log' && args.includes('--verbose')) console.error(ev.message);
  else if (ev.type === 'progress') process.stdout.write(`\r${ev.percent.toFixed(1).padStart(5)}%  ch ${ev.chapterIndex + 1}/${ev.chapterCount}  part ${Math.min(ev.chunkIndex + 1, ev.chunkCount)}/${ev.chunkCount}${ev.etaSeconds ? `  ~${(ev.etaSeconds / 60).toFixed(0)} min left` : ''}   `);
  else if (ev.type === 'done') console.log(`\ndone: ${ev.m4b || ev.dir} (${(ev.seconds / 60).toFixed(1)} min)`);
  else if (ev.type === 'cancelled') console.log('\ncancelled');
}, () => cancelled).then(() => { pipeline.shutdown(); process.exit(0); }, (e) => { console.error(`\nerror: ${e.message}`); pipeline.shutdown(); process.exit(1); });
