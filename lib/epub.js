'use strict';
// EPUB 2/3 reader: container.xml → OPF → spine, with chapter titles from the nav/NCX.
const path = require('node:path');
const { openZip } = require('./zip');
const { htmlToText, firstHeading, decodeEntities } = require('./html');

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));
  return m ? decodeEntities(m[1] ?? m[2]) : undefined;
}
function tags(xml, name) {
  return xml.match(new RegExp(`<${name}\\b[^>]*>`, 'gi')) || [];
}
function block(xml, name) {
  return xml.match(new RegExp(`<(?:[a-z0-9]+:)?${name}\\b[^>]*>[\\s\\S]*?</(?:[a-z0-9]+:)?${name}\\s*>`, 'i'))?.[0] || '';
}
function textOf(xml, name) {
  const m = xml.match(new RegExp(`<(?:[a-z0-9]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[a-z0-9]+:)?${name}\\s*>`, 'i'));
  return m ? decodeEntities(m[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim() : undefined;
}
function resolveHref(baseDir, href) {
  let clean = href.split('#')[0];
  try { clean = decodeURIComponent(clean); } catch { /* not percent-encoded after all */ }
  return path.posix.normalize(path.posix.join(baseDir, clean));
}

function parseEpub(file) {
  const zip = openZip(file);
  const container = zip.readText('META-INF/container.xml');
  const rootfile = tags(container, 'rootfile').map((t) => attr(t, 'full-path')).find(Boolean);
  if (!rootfile) throw new Error('EPUB is missing its rootfile entry');
  const opfDir = path.posix.dirname(rootfile);
  const opf = zip.readText(rootfile);

  const meta = block(opf, 'metadata');
  const title = textOf(meta, 'title') || path.basename(file, path.extname(file));
  const author = textOf(meta, 'creator') || '';
  const language = textOf(meta, 'language') || '';

  const manifest = new Map();
  for (const t of tags(block(opf, 'manifest'), 'item')) {
    const id = attr(t, 'id');
    if (id) manifest.set(id, { href: attr(t, 'href') || '', mediaType: attr(t, 'media-type') || '', properties: attr(t, 'properties') || '' });
  }
  const spineXml = block(opf, 'spine');
  const spineTag = tags(spineXml, 'spine')[0] || '';
  const spine = tags(spineXml, 'itemref')
    .filter((t) => (attr(t, 'linear') || 'yes').toLowerCase() !== 'no')
    .map((t) => attr(t, 'idref'))
    .filter((id) => manifest.has(id));

  // Map content file → title, from the EPUB3 nav document or the EPUB2 NCX.
  const tocTitles = new Map();
  const navItem = [...manifest.values()].find((m) => /\bnav\b/.test(m.properties));
  if (navItem) {
    const navPath = resolveHref(opfDir, navItem.href);
    const nav = zip.readText(navPath);
    const navDir = path.posix.dirname(navPath);
    const toc = nav.match(/<nav\b[^>]*epub:type\s*=\s*["'][^"']*\btoc\b[^"']*["'][\s\S]*?<\/nav\s*>/i)?.[0] || nav;
    for (const a of toc.match(/<a\b[^>]*>[\s\S]*?<\/a\s*>/gi) || []) {
      const href = attr(a, 'href');
      const label = htmlToText(a).replace(/\s+/g, ' ');
      if (href && label) {
        const key = resolveHref(navDir, href);
        if (!tocTitles.has(key)) tocTitles.set(key, label);
      }
    }
  } else {
    const ncxItem = manifest.get(attr(spineTag, 'toc')) || [...manifest.values()].find((m) => m.mediaType === 'application/x-dtbncx+xml');
    if (ncxItem) {
      const ncxPath = resolveHref(opfDir, ncxItem.href);
      const ncx = zip.readText(ncxPath);
      const ncxDir = path.posix.dirname(ncxPath);
      for (const np of ncx.match(/<navPoint\b[\s\S]*?<content\b[^>]*>/gi) || []) {
        const label = textOf(np, 'text');
        const src = attr(tags(np, 'content')[0] || '', 'src');
        if (label && src) {
          const key = resolveHref(ncxDir, src);
          if (!tocTitles.has(key)) tocTitles.set(key, label);
        }
      }
    }
  }

  const chapters = [];
  for (const id of spine) {
    const p = resolveHref(opfDir, manifest.get(id).href);
    if (!zip.has(p)) continue;
    const html = zip.readText(p);
    const text = htmlToText(html);
    if (text.replace(/[^\p{L}\p{N}]/gu, '').length < 20) continue;
    const heading = tocTitles.get(p) || firstHeading(html) || `Section ${chapters.length + 1}`;
    chapters.push({ title: heading, text });
  }
  return { title, author, language, chapters };
}

module.exports = { parseEpub };
