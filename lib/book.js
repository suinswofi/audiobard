'use strict';
const path = require('node:path');
const { parseEpub } = require('./epub');
const { parseMobi } = require('./mobi');

const EPUB = new Set(['.epub']);
const MOBI = new Set(['.mobi', '.azw', '.azw3', '.kf8', '.prc']);

function parseBook(file) {
  const ext = path.extname(file).toLowerCase();
  if (EPUB.has(ext)) return parseEpub(file);
  if (MOBI.has(ext)) return parseMobi(file);
  throw new Error(`Unsupported ebook format "${ext}". Use EPUB, MOBI or AZW3.`);
}

module.exports = { parseBook, EXTENSIONS: [...EPUB, ...MOBI].map((e) => e.slice(1)) };
