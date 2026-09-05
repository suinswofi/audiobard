'use strict';
// HTML/XHTML → plain text, tuned for narration rather than layout fidelity.

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', shy: '',
  ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  hellip: '…', copy: '©', reg: '®', trade: '™', laquo: '«', raquo: '»',
  bull: '•', middot: '·', deg: '°', frac12: '½', frac14: '¼', frac34: '¾',
  ensp: ' ', emsp: ' ', thinsp: ' ', times: '×', pound: '£', euro: '€', sect: '§',
  eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë', aacute: 'á', agrave: 'à',
  acirc: 'â', auml: 'ä', atilde: 'ã', aring: 'å', aelig: 'æ', ccedil: 'ç',
  iacute: 'í', igrave: 'ì', icirc: 'î', iuml: 'ï', ntilde: 'ñ', oacute: 'ó',
  ograve: 'ò', ocirc: 'ô', ouml: 'ö', otilde: 'õ', oslash: 'ø', oelig: 'œ',
  uacute: 'ú', ugrave: 'ù', ucirc: 'û', uuml: 'ü', szlig: 'ß', yacute: 'ý',
};

function decodeEntities(s) {
  return s.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, e) => {
    if (e[0] === '#') {
      const code = /^#[xX]/.test(e) ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return e in NAMED ? NAMED[e] : m;
  });
}

const BLOCK = 'p|div|h[1-6]|li|ul|ol|br|hr|tr|td|th|table|blockquote|section|article|aside|header|footer|nav|figure|figcaption|pre|dt|dd|dl|address|center|body|html|mbp:pagebreak';
const BLOCK_RE = new RegExp(`</?(?:${BLOCK})\\b[^>]*>`, 'gi');

function htmlToText(html) {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head|svg|math|title)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(BLOCK_RE, '\n')
    .replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  s = s.replace(/\u00a0/g, ' ').replace(/[ \t\r\f\v]+/g, ' ');
  s = s.split('\n').map((l) => l.trim()).join('\n').replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

function firstHeading(html) {
  const m = html.match(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]\s*>/i);
  if (!m) return '';
  return htmlToText(m[1]).replace(/\s+/g, ' ').trim();
}

module.exports = { htmlToText, firstHeading, decodeEntities };
