'use strict';
// Optional: if ffmpeg is on PATH we can produce a single .m4b with chapter markers.
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

function findFfmpeg() {
  const r = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  return r.status === 0 ? 'ffmpeg' : null;
}

const esc = (s) => String(s).replace(/([=;#\\\n])/g, '\\$1');

function makeM4b({ ffmpeg, parts, out, title, author, onLine = () => {} }) {
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
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-stats',
    '-f', 'concat', '-safe', '0', '-i', listFile, '-i', metaFile,
    '-map', '0:a', '-map_metadata', '1', '-map_chapters', '1',
    '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', out];
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

module.exports = { findFfmpeg, makeM4b };
