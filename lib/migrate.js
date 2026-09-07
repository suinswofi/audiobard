'use strict';
// The app has changed its name twice (Narrata up to 1.0.0, Booklark up to 1.2.1), and with it the
// data directory. On first start, move the model cache, the Python environment and recorded
// samples out of the old directories so nothing is downloaded twice. Newest first: an older
// directory only fills in what a newer one did not have. The one exception is a Python
// environment whose setup never finished: a finished one from an older directory replaces it.
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIRS = ['models', 'venv', 'samples'];
const OLD_MARKERS = ['.narrata-ok', '.booklark-ok']; // oldest first, so the newest wins
const MARKER = '.audiobard-ok';
// Setup writes the marker last, so a venv without one is unfinished and the app treats it as
// not installed. Before 1.3 a Linux user who set up cloning through the CLI could have such an
// unfinished venv in the app's directory next to the finished one in the CLI's.
const hasMarker = (venv) => [MARKER, ...OLD_MARKERS].some((m) => fs.existsSync(path.join(venv, m)));

function moveFrom(legacy, userData) {
  for (const name of DATA_DIRS) {
    const from = path.join(legacy, name);
    const to = path.join(userData, name);
    if (!fs.existsSync(from)) continue;
    if (fs.existsSync(to)) {
      if (!fs.readdirSync(to).length) fs.rmdirSync(to);
      else if (name === 'venv' && !hasMarker(to) && hasMarker(from)) fs.rmSync(to, { recursive: true, force: true });
      else continue; // already has data: leave both alone
    }
    fs.mkdirSync(userData, { recursive: true });
    fs.renameSync(from, to);
  }
}

function migrateUserData(userData, legacyDirs) {
  const seen = new Set([path.resolve(userData)]);
  for (const legacy of legacyDirs) {
    const key = path.resolve(legacy);
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      if (fs.existsSync(legacy)) moveFrom(legacy, userData);
    } catch (err) {
      console.warn(`Could not move data from ${legacy}: ${err.message}`);
    }
  }
  try {
    const venv = path.join(userData, 'venv');
    if (fs.existsSync(path.join(venv, MARKER))) return;
    for (const old of OLD_MARKERS) {
      const oldMarker = path.join(venv, old);
      if (fs.existsSync(oldMarker)) fs.renameSync(oldMarker, path.join(venv, MARKER));
    }
  } catch (err) {
    console.warn(`Could not rename the voice cloning marker: ${err.message}`);
  }
}

module.exports = { migrateUserData };
