'use strict';
// Kokoro-82M via kokoro-js (ONNX Runtime, CPU). Model files are cached under cacheDir.
const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
let loading = null;

function loadKokoro({ cacheDir, dtype = 'fp32', onStatus = () => {} }) {
  if (loading) return loading;
  loading = (async () => {
    const { env } = require('@huggingface/transformers');
    env.cacheDir = cacheDir;
    const { KokoroTTS } = require('kokoro-js');
    const seen = new Map();
    onStatus('Loading Kokoro voice model...');
    const tts = await KokoroTTS.from_pretrained(MODEL_ID, {
      dtype,
      device: 'cpu',
      progress_callback: (p) => {
        if (p.status !== 'progress' || !p.file) return;
        const pct = Math.floor(p.progress || 0);
        if (seen.get(p.file) === pct) return;
        seen.set(p.file, pct);
        onStatus(`Downloading Kokoro model: ${p.file} ${pct}%`);
      },
    });
    onStatus('Kokoro ready');
    return tts;
  })();
  loading.catch(() => { loading = null; });
  return loading;
}

module.exports = { loadKokoro, MODEL_ID };
