'use strict';
// Compressed output through ffmpeg. PCM is streamed straight into the encoder as it is
// synthesized, so no uncompressed audio is ever written to disk.
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const { spawn, spawnSync } = require('node:child_process');

function findFfmpeg() {
  const r = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  return r.status === 0 ? 'ffmpeg' : null;
}

// Container is given explicitly because chapters are written to "<name>.part" first.
const CODECS = {
  mp3: ['-f', 'mp3', '-c:a', 'libmp3lame', '-b:a', '64k'],
  ogg: ['-f', 'ogg', '-c:a', 'libopus', '-b:a', '40k'],
  m4a: ['-f', 'ipod', '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart'],
};

class ChapterEncoder {
  constructor({ ffmpeg, format, file, rate }) {
    const codec = CODECS[format];
    if (!codec) throw new Error(`Unknown audio format "${format}"`);
    this.file = file;
    this.rate = rate;
    this.bytes = 0;
    this.err = '';
    this.child = spawn(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error',
      '-f', 's16le', '-ar', String(rate), '-ac', '1', '-i', 'pipe:0', ...codec, file],
    { stdio: ['pipe', 'ignore', 'pipe'] });
    this.child.stderr.on('data', (d) => { this.err += d; });
    this.child.stdin.on('error', () => { /* reported through the exit code in close() */ });
    this.exit = new Promise((resolve) => this.child.on('close', resolve));
  }

  async write(pcm) {
    this.bytes += pcm.length;
    if (this.child.exitCode !== null) return;
    if (!this.child.stdin.write(pcm)) await Promise.race([once(this.child.stdin, 'drain').catch(() => {}), this.exit]);
  }

  async close() {
    this.child.stdin.end();
    const code = await this.exit;
    if (code !== 0) throw new Error(`ffmpeg failed while encoding ${path.basename(this.file)}: ${this.err.trim().slice(-400)}`);
    return this.bytes / 2 / this.rate; // seconds
  }

  abort() {
    this.child.kill();
  }
}

function probeSeconds(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  const s = parseFloat(r.stdout);
  return r.status === 0 && Number.isFinite(s) ? s : 0;
}

const esc = (s) => String(s).replace(/([=;#\\\n])/g, '\\$1');

// Joins per-chapter AAC files into one .m4b without re-encoding, adding chapter markers.
function concatM4b({ ffmpeg, parts, out, title, author, onLine = () => {} }) {
  const dir = path.dirname(out);
  const listFile = path.join(dir, '.narrata-concat.txt');
  const metaFile = path.join(dir, '.narrata-meta.txt');
  fs.writeFileSync(listFile, parts.map((p) => `file '${p.file.replace(/'/g, "'\\''")}'`).join('\n'));
  let meta = `;FFMETADATA1\ntitle=${esc(title)}\nalbum=${esc(title)}\nartist=${esc(author)}\nalbum_artist=${esc(author)}\ngenre=Audiobook\n`;
  let t = 0;
  for (const p of parts) {
    const end = t + Math.round(p.seconds * 1000);
    meta += `[CHAPTER]\nTIMEBASE=1/1000\nSTART=${t}\nEND=${end}\ntitle=${esc(p.title)}\n`;
    t = end;
  }
  fs.writeFileSync(metaFile, meta);
  const args = ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'concat', '-safe', '0', '-i', listFile, '-i', metaFile,
    '-map', '0:a', '-map_metadata', '1', '-map_chapters', '1',
    '-c', 'copy', '-movflags', '+faststart', out];
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args);
    let err = '';
    child.stderr.on('data', (d) => { const s = d.toString(); err += s; onLine(s.trim()); });
    child.on('error', reject);
    child.on('close', (code) => {
      fs.rmSync(listFile, { force: true });
      fs.rmSync(metaFile, { force: true });
      code === 0 ? resolve(out) : reject(new Error(`ffmpeg failed (${code}): ${err.slice(-500)}`));
    });
  });
}

module.exports = { findFfmpeg, ChapterEncoder, probeSeconds, concatM4b };
