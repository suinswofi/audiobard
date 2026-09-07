'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, utilityProcess } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { EXTENSIONS } = require('./lib/book');
const { findFfmpeg } = require('./lib/ffmpeg');
const { findSystemPython, isInstalled, installedBuild, detectGpu, install } = require('./lib/clone');
const { floatToPcm16, writeWav } = require('./lib/wav');
const { VOICES } = require('./lib/voices');
const { migrateUserData } = require('./lib/migrate');

const userData = app.getPath('userData');
migrateUserData(userData, ['Booklark', 'Narrata'].map((name) => path.join(path.dirname(userData), name)));
const dirs = {
  models: path.join(userData, 'models'),
  venv: path.join(userData, 'venv'),
  samples: path.join(userData, 'samples'),
};
const cloneScript = path.join(__dirname, 'python', 'audiobard_tts.py');

// Engine status and log lines, fresh for each run of the app. The window shows only the latest
// status, so this is where to look when the voice engine did something unexpected.
const engineLog = path.join(userData, 'engine.log');
try { fs.mkdirSync(userData, { recursive: true }); fs.writeFileSync(engineLog, `Audiobard ${app.getVersion()} started ${new Date().toISOString()}\n`); } catch { /* logging is best effort */ }
function logLine(line) {
  try { fs.appendFileSync(engineLog, `${new Date().toISOString().slice(11, 19)} ${line}\n`); } catch { /* best effort */ }
}

let win = null;
let worker = null;
let nextId = 1;
const pending = new Map();
// A worker that dies is started again, but one that cannot even get going (a broken native
// module, say) must not be respawned forever. Any message from the worker resets the count.
let workerCrashes = 0;
const MAX_WORKER_CRASHES = 3;

function startWorker() {
  worker = utilityProcess.fork(path.join(__dirname, 'worker.js'), [], { serviceName: 'audiobard-worker', stdio: 'inherit' });
  worker.on('message', (msg) => {
    workerCrashes = 0;
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result);
    } else {
      if (['status', 'log', 'warning', 'error'].includes(msg.type)) logLine(`[${msg.type}] ${msg.message}`);
      if (win && !win.isDestroyed()) win.webContents.send('worker-event', msg);
    }
  });
  worker.on('exit', (code) => {
    for (const p of pending.values()) p.reject(new Error('The conversion engine stopped unexpectedly.'));
    pending.clear();
    if (win && !win.isDestroyed()) win.webContents.send('worker-event', { type: 'error', message: `The conversion engine stopped unexpectedly (code ${code}).` });
    worker = null;
    if (app.isQuitting) return;
    if (++workerCrashes < MAX_WORKER_CRASHES) startWorker();
    else logLine(`[error] The conversion engine stopped ${workerCrashes} times in a row; not starting it again.`);
  });
}

function call(op, payload = {}) {
  return new Promise((resolve, reject) => {
    if (!worker) return reject(new Error('The conversion engine is not running. Restart the app.'));
    const id = nextId++;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, op, ...payload });
  });
}

function defaultOutDir() {
  for (const key of ['music', 'documents', 'home']) {
    try { return path.join(app.getPath(key), 'Audiobooks'); } catch { /* try next */ }
  }
  return path.join(app.getPath('home'), 'Audiobooks');
}

function createWindow() {
  win = new BrowserWindow({
    width: 760,
    height: 860,
    minWidth: 600,
    minHeight: 600,
    title: 'Audiobard',
    autoHideMenuBar: true,
    backgroundColor: '#f6f4ef',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

ipcMain.handle('env', () => ({
  voices: VOICES,
  ffmpeg: !!findFfmpeg(),
  python: findSystemPython(),
  cloneReady: isInstalled(dirs.venv),
  cloneBuild: installedBuild(dirs.venv),
  cloneGpu: detectGpu(),
  defaultOutDir: defaultOutDir(),
  platform: process.platform,
}));

ipcMain.handle('pick-book', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Ebooks', extensions: EXTENSIONS }] });
  if (r.canceled || !r.filePaths.length) return null;
  const file = r.filePaths[0];
  return { file, book: await call('parse', { file }) };
});

ipcMain.handle('pick-audio', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Audio', extensions: ['wav', 'mp3', 'flac', 'ogg', 'm4a', 'aac'] }] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('pick-outdir', async (_e, current) => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: current });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('save-recording', (_e, samples, rate) => {
  fs.mkdirSync(dirs.samples, { recursive: true });
  const file = path.join(dirs.samples, `voice-sample-${Date.now()}.wav`);
  writeWav(file, floatToPcm16(new Float32Array(samples)), rate);
  return file;
});

let installing = null;
ipcMain.handle('install-clone', async () => {
  if (!installing) {
    installing = install(dirs.venv, { onLine: (line) => { logLine(`[setup] ${line}`); if (win && !win.isDestroyed()) win.webContents.send('install-log', line); } })
      .finally(() => { installing = null; });
  }
  return installing;
});

const jobEnv = () => ({ cacheDir: dirs.models, venvDir: dirs.venv, cloneScript, ffmpeg: findFfmpeg() });

ipcMain.handle('preview', (_e, opts) => call('preview', { ...opts, ...jobEnv() }));
ipcMain.handle('start', (_e, job) => {
  fs.mkdirSync(job.outDir, { recursive: true });
  return call('start', { ...job, ...jobEnv() });
});
ipcMain.handle('cancel', () => { if (worker) worker.postMessage({ op: 'cancel' }); });
ipcMain.handle('open-path', (_e, p) => shell.openPath(p));
ipcMain.handle('show-in-folder', (_e, p) => shell.showItemInFolder(p));

app.whenReady().then(() => {
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  startWorker();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('before-quit', () => { app.isQuitting = true; if (worker) worker.kill(); });
app.on('window-all-closed', () => app.quit());
