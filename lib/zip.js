'use strict';
// Minimal ZIP reader (stored + deflate) built on node:zlib. Enough for EPUB.
const fs = require('node:fs');
const zlib = require('node:zlib');

function openZip(file) {
  const buf = fs.readFileSync(file);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a ZIP/EPUB file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Corrupt ZIP central directory');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (size === 0xffffffff || localOffset === 0xffffffff) throw new Error('ZIP64 archives are not supported');
    entries.set(name, { method, compSize, size, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }

  function read(name) {
    const e = entries.get(name);
    if (!e) throw new Error(`File not found inside archive: ${name}`);
    const h = e.localOffset;
    if (buf.readUInt32LE(h) !== 0x04034b50) throw new Error(`Corrupt ZIP entry: ${name}`);
    const start = h + 30 + buf.readUInt16LE(h + 26) + buf.readUInt16LE(h + 28);
    const data = buf.subarray(start, start + e.compSize);
    if (e.method === 0) return Buffer.from(data);
    if (e.method === 8) return zlib.inflateRawSync(data);
    throw new Error(`Unsupported ZIP compression method ${e.method} for ${name}`);
  }

  return {
    names: () => [...entries.keys()],
    has: (name) => entries.has(name),
    read,
    readText: (name) => read(name).toString('utf8'),
  };
}

module.exports = { openZip };
