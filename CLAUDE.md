# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Audiobard is an Electron desktop app (plus a CLI) that narrates DRM-free EPUB/MOBI/AZW3 ebooks into
audiobooks locally, using Kokoro-82M (via `kokoro-js`/ONNX in Node) or voice cloning with Chatterbox
Turbo (a Python sidecar). Plain JavaScript, CommonJS, no bundler, no TypeScript, no framework, no
test suite. Only two runtime dependencies (`kokoro-js`, `@huggingface/transformers`, both pinned);
everything else is Node's standard library. Keep it that way: do not add dependencies casually.

## Commands

`node` is not on PATH in the default shell; use `~/.nvm/versions/node/v24.19.0/bin/node` (or add
that directory to PATH).

```sh
npm install
npm start                                   # the Electron app
node cli.js fixtures/alice.epub             # list chapters (no synthesis, quick smoke test of parsing)
node cli.js fixtures/alice.epub --out ./out --chapters 2 --format wav   # short end-to-end conversion
node cli.js book.epub --out ./out --ref sample.wav --verbose            # voice cloning, sidecar log on stderr
node scripts/package.js                     # bundle to dist/Audiobard-<platform>-<arch>/
node scripts/package.js --platform win32 --archive   # cross-build from Linux, produce .zip/.tar.gz
```

There are no tests and no linter. Verify changes by running the CLI against `fixtures/alice.epub`
or `fixtures/alice.mobi` (git-ignored fixtures, present locally). When running conversions, set
`XDG_CONFIG_HOME=<scratch dir>` so the user's real `~/.config/Audiobard` (models, venv, samples)
is not touched; the CLI and app share that data directory.

Releases: bump `version` in `package.json` and `package-lock.json` (two places), one commit whose
subject ends in `; release X.Y.Z`, annotated tag `vX.Y.Z`, build both archives, then
`gh release create` with the Linux tar.gz and Windows zip attached.

## Architecture

Three processes in the app, one in the CLI, all driving the same `lib/pipeline.js`:

- **`main.js`** (Electron main): window, file dialogs, IPC handlers, and the lifecycle of the
  worker. It forks `worker.js` as a `utilityProcess`, talks to it with `{id, op, ...}` messages,
  restarts it on crash (up to 3 consecutive), and forwards unsolicited worker events to the window
  as `worker-event`. Also writes `<userData>/engine.log` (status/log/warning/error lines) and runs
  `lib/migrate.js` to pull data out of the pre-1.3 Booklark/Narrata directories on start.
- **`preload.js`**: sandboxed `contextBridge` exposing `window.audiobard.*`. Every new capability
  the renderer needs must be added here and as an `ipcMain.handle` in `main.js`.
- **`worker.js`**: runs parsing and synthesis off the UI thread. Ops: `parse`, `preview`, `start`,
  `cancel`. Only one preview/conversion at a time (`busy` flag); cancel is a polled flag passed
  into the pipeline as `isCancelled()`.
- **`renderer/`**: one HTML file, one stylesheet, one script (`app.js`, a single `state` object and
  DOM updates via `$()`). No framework.
- **`cli.js`**: same pipeline, computes the same `<userData>` path by hand (no Electron), prints
  pipeline events to the terminal.

### The pipeline (`lib/pipeline.js`)

`convert(job, emit, isCancelled)`: book → per-chapter sentence-aware chunks (`lib/chunk.js`,
`MAX_CHARS` differs per engine: 400 Kokoro, 300 clone) → `synth(text)` → PCM streamed into a
per-chapter writer → optional M4B assembly. Key behaviours to preserve when editing:

- **Streaming encode**: `ChapterEncoder` in `lib/ffmpeg.js` pipes s16le PCM into a long-lived
  ffmpeg process per chapter; WAV (`WavWriter`) is only the no-ffmpeg fallback. M4B is built by
  `concatM4b` from per-chapter `.m4a` files without re-encoding, with chapter markers.
- **Resumability**: chapters are written to `<file>.part` and renamed on completion; an existing
  finished chapter file (size > 44 bytes) is reused and its duration probed. Output layout is
  `<outDir>/<book title>/NN - <chapter>.<ext>`, and `<outDir>/<book title>.m4b`.
- **Fault tolerance**: a chunk that fails is retried once, then replaced by 0.5 s of silence with a
  `warning` event; three consecutive failures abort the job.
- **Events** emitted through `emit`: `status`, `log`, `warning`, `error`, `progress` (with
  percent/eta), `cancelled`, `done`. The renderer and CLI both consume this vocabulary; `main.js`
  logs `status/log/warning/error` to `engine.log`.
- The `job` object carries everything the engines need (`cacheDir`, `venvDir`, `cloneScript`,
  `ffmpeg`, `refAudio`, `voice`, `speed`, `format`, `chapters` as 0-based indices, `keepChapters`).
  `main.js` and `cli.js` each build it; keep them in sync.

### Engines

The engines are mutually exclusive per job: `getSynth` in `lib/pipeline.js` returns one
`synth(text)` function chosen by `job.engine`, and every chunk (and the preview) goes through it.
With `clone` selected Kokoro is never loaded; `lib/kokoro.js` only requires `kokoro-js` and
transformers inside `loadKokoro`, so no ONNX model is downloaded or held in memory. The only
shared step is chunking, which uses a smaller chunk size for cloning.

- **Kokoro** (`lib/kokoro.js`): loads via `kokoro-js` with the HF cache pointed at
  `<userData>/models`; always CPU. Voice ids and quality grades live in `lib/voices.js`. The
  model is built from `StyleTextToSpeech2Model` + `AutoTokenizer` rather than
  `KokoroTTS.from_pretrained` so that ONNX session options can be passed: the CPU memory arena
  must not be allowed to keep doubling, because Electron's allocator kills the utility process
  (exit code 133, no message) instead of failing an oversized allocation. Weights stay out of the
  arena, memory patterns are off, and a maximum-length warm-up at load fixes the arena's size.
  Do not remove these without re-testing a whole chapter inside the app, not just the CLI.
- **Clone** (`lib/clone.js` + `python/audiobard_tts.py`): `install()` creates a venv in
  `<userData>/venv`, picks the PyTorch build from `detectGpu()` (`nvidia-smi` → CUDA, `/dev/kfd` +
  AMD vendor id → ROCm, else CPU; macOS uses the default index) and writes a JSON marker file
  `.audiobard-ok` recording the build. `CloneEngine` spawns the sidecar once per venv and keeps it
  alive across chapters; protocol is JSON lines on stdin/stdout with ops `ref`, `synth`, `quit`,
  and a `ready` event on start. The sidecar dups fd 1 for the protocol and redirects Python's
  stdout to stderr so library output cannot corrupt it. It benchmarks each visible GPU in a
  subprocess at start-up and falls back to CPU on any failure, including failures mid-run.
  The Python file also carries monkey-patches for Chatterbox/NumPy/torchaudio quirks; read the
  docstrings before touching them.

### Book parsing

`lib/book.js` dispatches by extension to `lib/epub.js` (container.xml → OPF → spine; titles from
nav or NCX; ZIP reader in `lib/zip.js` on `node:zlib`) or `lib/mobi.js` (PalmDB, PalmDOC, KF7/KF8,
EXTH; HUFF/CDIC is unsupported and DRM is refused). Both feed HTML through `lib/html.js` into
narration-friendly plain text. Result shape: `{ title, author, language, chapters: [{ title, text }] }`.

## Packaging notes

`scripts/package.js` uses `@electron/packager` with `asar: false` (ONNX Runtime native libraries
are loaded by path) and an `ignore` list that strips other platforms' ONNX/sharp binaries and the
CUDA/TensorRT providers. Cross-building fetches the target platform's `@img/sharp-*` packages with
`npm pack`. If you add a native or platform-specific dependency, update that ignore list.

## Conventions

- Files start with `'use strict';` and a one- or two-line comment saying what the module is for.
  Comments explain *why* (a library quirk, a platform gotcha), not what.
- User-facing strings are plain English sentences, no jargon; error messages tell the user what to
  do next (e.g. "Install ffmpeg, or choose WAV.").
- The README's "How it is built" file table and "Where files go" table are kept accurate; update
  them when adding modules or data locations.
- Licence is PolyForm Noncommercial 1.0.0; voice cloning has a responsible-use section in the
  README that should stay.
