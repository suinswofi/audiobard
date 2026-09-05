'use strict';
// Split chapter text into TTS-sized chunks along sentence boundaries.

function normalize(text) {
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[\u2018\u2019\u201a\u2032]/g, "'")
    .replace(/[\u201c\u201d\u201e\u2033]/g, '"')
    .replace(/\u2026/g, '...')
    .replace(/\s*[\u2013\u2014]\s*/g, ' - ')
    .replace(/[*_#~^|]+/g, ' ')
    .replace(/[ \t]+/g, ' ');
}

function packSentences(sentences, maxChars) {
  const out = [];
  let cur = '';
  for (const s of sentences) {
    if (!s) continue;
    if (cur && cur.length + 1 + s.length > maxChars) { out.push(cur); cur = s; }
    else cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) out.push(cur);
  return out;
}

function hardSplit(sentence, maxChars) {
  const clauses = sentence.split(/(?<=[,;:])\s+/);
  const pieces = [];
  for (const c of clauses) {
    if (c.length <= maxChars) { pieces.push(c); continue; }
    pieces.push(...packSentences(c.split(' '), maxChars));
  }
  return packSentences(pieces, maxChars);
}

function chunkText(text, maxChars = 400) {
  const chunks = [];
  for (const para of normalize(text).split(/\n\s*\n/)) {
    const p = para.replace(/\s*\n\s*/g, ' ').trim();
    if (!/[\p{L}\p{N}]/u.test(p)) continue;
    const sentences = [];
    for (const s of p.split(/(?<=[.!?]["')\]]*)\s+/)) {
      const t = s.trim();
      if (!t) continue;
      if (t.length > maxChars) sentences.push(...hardSplit(t, maxChars));
      else sentences.push(t);
    }
    const packed = packSentences(sentences, maxChars).map((t) => ({ text: t, paraEnd: false }));
    if (packed.length) packed[packed.length - 1].paraEnd = true;
    chunks.push(...packed);
  }
  return chunks;
}

module.exports = { chunkText, normalize };
