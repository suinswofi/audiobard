'use strict';
// Voice cloning via a Python sidecar running Chatterbox Turbo (MIT). The app creates a
// private virtualenv on first use; nothing Python-related is bundled with Booklark itself.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawn, spawnSync } = require('node:child_process');

const isWin = process.platform === 'win32';
const venvPython = (venvDir) => path.join(venvDir, isWin ? 'Scripts/python.exe' : 'bin/python');
const markerFile = (venvDir) => path.join(venvDir, '.booklark-ok');

function findSystemPython() {
  for (const cmd of isWin ? ['py', 'python', 'python3'] : ['python3', 'python']) {
    const r = spawnSync(cmd, ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { encoding: 'utf8' });
    if (r.status !== 0) continue;
    const [maj, min] = r.stdout.trim().split('.').map(Number);
    if (maj > 3 || (maj === 3 && min >= 10)) return { cmd, version: r.stdout.trim() };
  }
  return null;
}

const hasNvidiaGpu = () => spawnSync('nvidia-smi', ['-L'], { encoding: 'utf8' }).status === 0;

// AMD on Linux. The ROCm PyTorch wheel bundles the whole ROCm userspace, so the system only
// needs the amdgpu kernel driver (open source, in every mainline kernel) and its compute node.
function hasAmdGpu() {
  if (process.platform !== 'linux' || !fs.existsSync('/dev/kfd')) return false;
  const vendor = (card) => { try { return fs.readFileSync(`/sys/class/drm/${card}/device/vendor`, 'utf8').trim(); } catch { return ''; } };
  try { return fs.readdirSync('/sys/class/drm').some((card) => vendor(card) === '0x1002'); } catch { return false; }
}

// The GPU stack this machine could use: 'cuda', 'rocm' or null. Only decides which PyTorch build
// to install; the sidecar still tests the GPU at start-up and falls back to the CPU on its own.
function detectGpu() {
  if (hasNvidiaGpu()) return 'cuda';
  if (hasAmdGpu()) return 'rocm';
  return null;
}
const GPU_NAMES = { cuda: 'an NVIDIA GPU', rocm: 'an AMD GPU' };
const BUILD_NAMES = { cuda: 'CUDA', rocm: 'ROCm', cpu: 'CPU' };

// Extra pip index for the wanted torch build, or null for the default index (macOS wheels come
// in one build with Metal included). cu126 has both pinned torch versions for Linux and Windows.
function torchIndex(build, torchVersion) {
  if (process.platform === 'darwin') return null;
  if (build === 'cuda') return 'cu126';
  if (build === 'rocm') return torchVersion.startsWith('2.6.') ? 'rocm6.2.4' : 'rocm6.4';
  return 'cpu';
}

const isInstalled = (venvDir) => fs.existsSync(markerFile(venvDir)) && fs.existsSync(venvPython(venvDir));

// Which build the venv holds: 'cuda', 'rocm' or 'cpu'; null when not installed. Markers written
// before 1.2 hold only a date, from a time when the build followed the NVIDIA check alone.
function installedBuild(venvDir) {
  if (!isInstalled(venvDir)) return null;
  try { return JSON.parse(fs.readFileSync(markerFile(venvDir), 'utf8')).build || 'cpu'; } catch { return hasNvidiaGpu() ? 'cuda' : 'cpu'; }
}

function run(cmd, args, onLine) {
  return new Promise((resolve, reject) => {
    onLine(`$ ${cmd} ${args.join(' ')}`);
    const child = spawn(cmd, args, { env: { ...process.env, PYTHONUNBUFFERED: '1', PIP_DISABLE_PIP_VERSION_CHECK: '1' } });
    let tail = '';
    const feed = (d) => {
      const s = d.toString();
      tail = (tail + s).slice(-2000);
      s.split(/\r?\n/).filter(Boolean).forEach(onLine);
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}\n${tail}`))));
  });
}

async function install(venvDir, { onLine = () => {} } = {}) {
  const py = findSystemPython();
  if (!py) throw new Error('Python 3.10 or newer was not found. Install Python, then try again.');
  onLine(`Using ${py.cmd} (Python ${py.version})`);
  if (!fs.existsSync(venvPython(venvDir))) {
    try {
      await run(py.cmd, ['-m', 'venv', venvDir], onLine);
    } catch (e) {
      fs.rmSync(venvDir, { recursive: true, force: true });
      throw new Error(`Could not create a Python virtual environment. On Debian, Ubuntu or Mint run:\n  sudo apt install python3-venv\n\n${e.message}`);
    }
  }
  const vpy = venvPython(venvDir);
  await run(vpy, ['-m', 'pip', 'install', '--upgrade', 'pip'], onLine);
  // chatterbox-tts wants torch 2.6 up to Python 3.13 and 2.9 or newer from 3.14, where 2.6 has no wheels.
  const minor = Number(spawnSync(vpy, ['-c', 'import sys; print(sys.version_info[1])'], { encoding: 'utf8' }).stdout) || Number(py.version.split('.')[1]);
  const torchVersion = minor >= 14 ? '2.9.1' : '2.6.0';
  const build = detectGpu() || 'cpu';
  onLine(build === 'cpu' ? 'No supported GPU detected; installing the CPU build of PyTorch.' : `Detected ${GPU_NAMES[build]}; installing the ${BUILD_NAMES[build]} build of PyTorch.`);
  // pip treats 2.6.0+cpu as satisfying torch==2.6.0, so a build change needs the old one gone first.
  const previous = installedBuild(venvDir);
  if (previous && previous !== build) await run(vpy, ['-m', 'pip', 'uninstall', '-y', 'torch', 'torchaudio'], onLine);
  const torch = ['-m', 'pip', 'install', `torch==${torchVersion}`, `torchaudio==${torchVersion}`];
  const index = torchIndex(build, torchVersion);
  if (index) torch.push('--index-url', `https://download.pytorch.org/whl/${index}`);
  await run(vpy, torch, onLine);
  await run(vpy, ['-m', 'pip', 'install', 'chatterbox-tts'], onLine);
  fs.writeFileSync(markerFile(venvDir), JSON.stringify({ installed: new Date().toISOString(), build }));
  onLine('Voice cloning is ready.');
  return build;
}

class CloneEngine {
  constructor({ venvDir, script, onStatus = () => {}, onLog = () => {} }) {
    Object.assign(this, { venvDir, script, onStatus, onLog, pending: new Map(), nextId: 1, ready: null, child: null });
  }

  start() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const child = spawn(venvPython(this.venvDir), [this.script], {
        env: { ...process.env, PYTHONUNBUFFERED: '1', HF_HUB_DISABLE_PROGRESS_BARS: '1' },
      });
      this.child = child;
      let settled = false;
      readline.createInterface({ input: child.stdout }).on('line', (line) => {
        let msg;
        try { msg = JSON.parse(line); } catch { return this.onLog(line); }
        if (msg.event === 'status') return this.onStatus(msg.message);
        if (msg.event === 'ready') {
          settled = true;
          this.onStatus(`Voice cloning ready (${msg.label || msg.device.toUpperCase()})`);
          return resolve(msg);
        }
        if (msg.event === 'fatal') { settled = true; return reject(new Error(msg.error)); }
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        msg.ok ? p.resolve(msg) : p.reject(new Error(msg.error));
      });
      readline.createInterface({ input: child.stderr }).on('line', (line) => this.onLog(line));
      child.on('error', (e) => { this.ready = null; reject(e); });
      child.on('close', (code) => {
        this.ready = null;
        this.child = null;
        const err = new Error(`Voice cloning engine exited (code ${code})`);
        if (!settled) reject(err);
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
      });
    });
    return this.ready;
  }

  request(payload) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify({ id, ...payload }) + '\n');
    });
  }

  async setReference(wavPath) { await this.start(); return this.request({ op: 'ref', path: wavPath }); }
  async synth(text, out) { await this.start(); return this.request({ op: 'synth', text, out }); }
  stop() {
    if (this.child) { this.child.kill(); this.child = null; this.ready = null; }
  }
}

module.exports = { findSystemPython, isInstalled, installedBuild, detectGpu, install, CloneEngine, venvPython };
