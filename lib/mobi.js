'use strict';
// MOBI / AZW / KF8 reader: PalmDB records + PalmDOC decompression, then plain-text extraction.
const fs = require('node:fs');
const path = require('node:path');
const { htmlToText, firstHeading } = require('./html');

function palmdocDecompress(data) {
  const out = [];
  let i = 0;
  while (i < data.length) {
    let c = data[i++];
    if (c === 0 || (c >= 0x09 && c <= 0x7f)) {
      out.push(c);
    } else if (c <= 0x08) {
      for (let j = 0; j < c && i < data.length; j++) out.push(data[i++]);
    } else if (c <= 0xbf) {
      c = (c << 8) | data[i++];
      const dist = (c >> 3) & 0x7ff;
      const len = (c & 7) + 3;
      const start = out.length - dist;
      for (let j = 0; j < len; j++) out.push(out[start + j] ?? 0);
    } else {
      out.push(0x20, c ^ 0x80);
    }
  }
  return Buffer.from(out);
}

function trailingEntrySize(rec, size) {
  let bitpos = 0, result = 0;
  while (size > 0) {
    const v = rec[size - 1];
    result |= (v & 0x7f) << bitpos;
    bitpos += 7;
    size -= 1;
    if (v & 0x80 || bitpos >= 28 || size === 0) return result;
  }
  return result;
}

function trailingSize(rec, flags) {
  let num = 0;
  let f = flags >> 1;
  while (f) {
    if (f & 1) num += trailingEntrySize(rec, rec.length - num);
    f >>= 1;
  }
  if (flags & 1 && rec.length - num - 1 >= 0) num += (rec[rec.length - num - 1] & 3) + 1;
  return Math.min(num, rec.length);
}

function parseMobi(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 78 || buf.toString('latin1', 60, 68) !== 'BOOKMOBI') throw new Error('Not a MOBI/AZW file');
  const numRecords = buf.readUInt16BE(76);
  const offsets = [];
  for (let i = 0; i < numRecords; i++) offsets.push(buf.readUInt32BE(78 + i * 8));
  const record = (i) => buf.subarray(offsets[i], i + 1 < numRecords ? offsets[i + 1] : buf.length);

  const r0 = record(0);
  const compression = r0.readUInt16BE(0);
  const textRecordCount = r0.readUInt16BE(8);
  const encryption = r0.readUInt16BE(12);
  if (encryption !== 0) throw new Error('This book is DRM-protected and cannot be read');
  if (r0.toString('latin1', 16, 20) !== 'MOBI') throw new Error('Missing MOBI header');
  const headerLength = r0.readUInt32BE(20);
  const textEncoding = r0.readUInt32BE(28);
  const fileVersion = r0.readUInt32BE(36);
  const fullNameOffset = r0.readUInt32BE(84);
  const fullNameLength = r0.readUInt32BE(88);
  const exthFlags = r0.readUInt32BE(128);
  const extraFlags = headerLength >= 0xe4 && fileVersion >= 5 ? r0.readUInt16BE(0xf2) : 0;
  const decoder = new TextDecoder(textEncoding === 65001 ? 'utf-8' : 'windows-1252');

  let title = fullNameLength ? decoder.decode(r0.subarray(fullNameOffset, fullNameOffset + fullNameLength)).trim() : '';
  if (!title) title = path.basename(file, path.extname(file));
  let author = '';
  if (exthFlags & 0x40) {
    let p = 16 + headerLength;
    if (r0.toString('latin1', p, p + 4) === 'EXTH') {
      const count = r0.readUInt32BE(p + 8);
      p += 12;
      for (let i = 0; i < count && p + 8 <= r0.length; i++) {
        const type = r0.readUInt32BE(p);
        const len = r0.readUInt32BE(p + 4);
        if (len < 8) break;
        if (type === 100 && !author) author = decoder.decode(r0.subarray(p + 8, p + len)).trim();
        p += len;
      }
    }
  }

  if (compression === 17480) throw new Error('HUFF/CDIC-compressed MOBI files are not supported. Convert the book to EPUB first (Calibre can do this).');
  if (compression !== 1 && compression !== 2) throw new Error(`Unknown MOBI compression type ${compression}`);

  const parts = [];
  for (let i = 1; i <= textRecordCount && i < numRecords; i++) {
    let rec = record(i);
    rec = rec.subarray(0, rec.length - trailingSize(rec, extraFlags));
    parts.push(compression === 2 ? palmdocDecompress(rec) : Buffer.from(rec));
  }
  const html = decoder.decode(Buffer.concat(parts));

  // KF7 marks chapters with <mbp:pagebreak>; KF8 streams one <html> document per file.
  let sections = html.split(/<mbp:pagebreak[^>]*>|(?=<\?xml)|(?=<html\b)/i);
  if (sections.length <= 1) sections = html.split(/(?=<h[12]\b)/i);

  const chapters = [];
  for (const sec of sections) {
    const text = htmlToText(sec);
    if (text.replace(/[^\p{L}\p{N}]/gu, '').length < 20) continue;
    chapters.push({ title: firstHeading(sec) || `Section ${chapters.length + 1}`, text });
  }
  return { title, author, language: '', chapters };
}

module.exports = { parseMobi };
