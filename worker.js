'use strict';
// Runs in an Electron utility process so model inference never blocks the window.
const { parseBook } = require('./lib/book');
const pipeline = require('./lib/pipeline');

const port = process.parentPort;
const send = (msg) => port.postMessage(msg);
let cancelled = false;
let busy = false;

const summarize = (book) => ({
  title: book.title,
  author: book.author,
  language: book.language,
  chapters: book.chapters.map((c) => ({ title: c.title, chars: c.text.length })),
  estimateSeconds: pipeline.estimateSeconds(book),
});

port.on('message', async (e) => {
  const msg = e.data;
  const reply = (data) => send({ id: msg.id, ...data });
  try {
    switch (msg.op) {
      case 'parse':
        return reply({ result: summarize(parseBook(msg.file)) });
      case 'preview': {
        if (busy) throw new Error('A conversion is already running.');
        busy = true;
        try {
          const { pcm, rate } = await pipeline.preview(msg, (ev) => send(ev));
          return reply({ result: { rate, pcm: pcm.toString('base64') } });
        } finally { busy = false; }
      }
      case 'start': {
        if (busy) throw new Error('A conversion is already running.');
        busy = true;
        cancelled = false;
        reply({ result: 'started' });
        try {
          await pipeline.convert({ ...msg, book: parseBook(msg.file) }, (ev) => send(ev), () => cancelled);
        } catch (err) {
          send({ type: 'error', message: err.message });
        } finally { busy = false; }
        return;
      }
      case 'cancel':
        cancelled = true;
        return;
      default:
        throw new Error(`Unknown worker op ${msg.op}`);
    }
  } catch (err) {
    reply({ error: err.message });
  }
});

process.on('exit', () => pipeline.shutdown());
