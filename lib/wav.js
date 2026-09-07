'use strict';
// 16-bit PCM WAV helpers, written with node:fs only.
const fs = require('node:fs');

function floatToPcm16(f32) {
  const out = Buffer.alloc(f32.length * 2);
  for (let i = 0; i < f32.length; i++) {
    const v = Math.max(-1, Math.min(1, f32[i]));
    out.writeInt16LE(Math.round(v < 0 ? v * 0x8000 : v * 0x7fff), i * 2);
  }
  return out;
}

function header(dataBytes, rate, channels = 1, bits = 16) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + dataBytes, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE((rate * channels * bits) / 8, 28);
  h.writeUInt16LE((channels * bits) / 8, 32); h.writeUInt16LE(bits, 34);
  h.write('data', 36); h.writeUInt32LE(dataBytes, 40);
  return h;
}

function silence(seconds, rate) {
  return Buffer.alloc(Math.round(seconds * rate) * 2);
}

function writeWav(file, pcm, rate) {
  fs.writeFileSync(file, Buffer.concat([header(pcm.length, rate), pcm]));
}

// Reads mono/stereo 16-bit PCM or 32-bit float WAV into 16-bit mono PCM.
function readWav(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') throw new Error(`Not a WAV file: ${file}`);
  let p = 12, fmt = null, data = null;
  while (p + 8 <= buf.length) {
    const id = buf.toString('latin1', p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    const body = buf.subarray(p + 8, Math.min(buf.length, p + 8 + size));
    if (id === 'fmt ') fmt = { format: body.readUInt16LE(0), channels: body.readUInt16LE(2), rate: body.readUInt32LE(4), bits: body.readUInt16LE(14) };
    else if (id === 'data') data = body;
    p += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error(`Malformed WAV file: ${file}`);
  const { format, channels, rate, bits } = fmt;
  let pcm;
  if (format === 1 && bits === 16 && channels === 1) pcm = Buffer.from(data);
  else {
    const frames = Math.floor(data.length / (channels * (bits / 8)));
    pcm = Buffer.alloc(frames * 2);
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (let c = 0; c < channels; c++) {
        const off = (i * channels + c) * (bits / 8);
        if (format === 3 && bits === 32) sum += data.readFloatLE(off);
        else if (format === 1 && bits === 16) sum += data.readInt16LE(off) / 0x8000;
        else if (format === 1 && bits === 24) sum += ((data[off] | (data[off + 1] << 8) | (data[off + 2] << 16)) << 8 >> 8) / 0x800000;
        else if (format === 1 && bits === 8) sum += (data[off] - 128) / 128;
        else throw new Error(`Unsupported WAV format ${format}/${bits}-bit in ${file}`);
      }
      const v = Math.max(-1, Math.min(1, sum / channels));
      pcm.writeInt16LE(Math.round(v < 0 ? v * 0x8000 : v * 0x7fff), i * 2);
    }
  }
  return { rate, pcm };
}

// Seconds of audio in a WAV file, from the header alone (the writer above produces the canonical 44-byte one).
function wavSeconds(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const h = Buffer.alloc(44);
    fs.readSync(fd, h, 0, 44, 0);
    const rate = h.readUInt32LE(24), block = h.readUInt16LE(32) || 2;
    const dataBytes = Math.min(h.readUInt32LE(40), fs.fstatSync(fd).size - 44);
    return rate ? dataBytes / block / rate : 0;
  } finally { fs.closeSync(fd); }
}

// Streams PCM to disk and patches the header on close, so long chapters never sit in memory.
class WavWriter {
  constructor(file, rate) {
    this.file = file;
    this.rate = rate;
    this.bytes = 0;
    this.fd = fs.openSync(file, 'w');
    fs.writeSync(this.fd, header(0, rate));
  }
  write(pcm) {
    fs.writeSync(this.fd, pcm);
    this.bytes += pcm.length;
  }
  close() {
    fs.writeSync(this.fd, header(this.bytes, this.rate), 0, 44, 0);
    fs.closeSync(this.fd);
    return this.bytes / 2 / this.rate; // seconds
  }
  abort() {
    fs.closeSync(this.fd);
  }
}

module.exports = { floatToPcm16, silence, writeWav, readWav, wavSeconds, WavWriter };
