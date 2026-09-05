'use strict';
// Voice cloning via a Python sidecar running Chatterbox Turbo (MIT). The app creates a
// private virtualenv on first use; nothing Python-related is bundled with Narrata itself.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawn, spawnSync } = require('node:child_process');

const isWin = process.platform === 'win32';
const venvPython = (venvDir) => path.join(venvDir, isWin ? 'Scripts/python.exe' : 'bin/python');
const markerFile = (venvDir) => path.join(venvDir, '.narrata-ok');

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
const isInstalled = (venvDir) => fs.existsSync(markerFile(venvDir)) && fs.existsSync(venvPython(venvDir));

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
  const torch = ['-m', 'pip', 'install', 'torch==2.6.0', 'torchaudio==2.6.0'];
  if (process.platform !== 'darwin' && !hasNvidiaGpu()) torch.push('--index-url', 'https://download.pytorch.org/whl/cpu');
  await run(vpy, torch, onLine);
  await run(vpy, ['-m', 'pip', 'install', 'chatterbox-tts'], onLine);
  fs.writeFileSync(markerFile(venvDir), new Date().toISOString());
  onLine('Voice cloning is ready.');
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
          this.onStatus(`Voice cloning ready (${msg.device.toUpperCase()})`);
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

module.exports = { findSystemPython, isInstalled, install, CloneEngine, venvPython };
