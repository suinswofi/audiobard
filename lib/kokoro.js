'use strict';
// Kokoro-82M via kokoro-js (ONNX Runtime, CPU). Model files are cached under cacheDir.
const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';

// ONNX Runtime's CPU memory arena doubles in size every time it has to grow. Inside Electron that
// eventually asks Chromium's allocator for a block of a gigabyte or more, and Chromium kills the
// process on the spot (exit code 133) instead of returning null, so the doubling has to stop
// early. Keeping the model weights out of the arena removes what fragments it, giving each
// tensor its own allocation avoids one huge block per input shape, and narrating the longest
// possible input once at load time (WARMUP_TEXT below) lets the arena reach its final size before any
// real text goes through. Turning the arena off altogether also works but makes synthesis
// almost twice as slow.
const SESSION_OPTIONS = {
  enableMemPattern: false,
  extra: { session: { use_device_allocator_for_initializers: '1' } },
};
// Long enough that the tokenizer truncates it to the model's maximum input.
const WARMUP_TEXT = 'This sentence is only here to prepare the voice model before the real book begins. '.repeat(12);

let loading = null;

function loadKokoro({ cacheDir, dtype = 'fp32', onStatus = () => {} }) {
  if (loading) return loading;
  loading = (async () => {
    const { env, StyleTextToSpeech2Model, AutoTokenizer } = require('@huggingface/transformers');
    env.cacheDir = cacheDir;
    const { KokoroTTS } = require('kokoro-js');
    const seen = new Map();
    onStatus('Loading Kokoro voice model...');
    const progress_callback = (p) => {
      if (p.status !== 'progress' || !p.file) return;
      const pct = Math.floor(p.progress || 0);
      if (seen.get(p.file) === pct) return;
      seen.set(p.file, pct);
      onStatus(`Downloading Kokoro model: ${p.file} ${pct}%`);
    };
    const [model, tokenizer] = await Promise.all([
      StyleTextToSpeech2Model.from_pretrained(MODEL_ID, { dtype, device: 'cpu', progress_callback, session_options: SESSION_OPTIONS }),
      AutoTokenizer.from_pretrained(MODEL_ID, { progress_callback }),
    ]);
    const tts = new KokoroTTS(model, tokenizer);
    onStatus('Preparing Kokoro voice model...');
    await tts.generate(WARMUP_TEXT, { voice: 'af_heart', speed: 1 });
    onStatus('Kokoro ready');
    return tts;
  })();
  loading.catch(() => { loading = null; });
  return loading;
}

module.exports = { loadKokoro, MODEL_ID };
