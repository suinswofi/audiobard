'use strict';
// Booklark was called Narrata up to 1.0.0. On first start, move the model cache, the Python
// environment and recorded samples out of the old data directory so nothing is downloaded twice.
const fs = require('node:fs');
const path = require('node:path');

function migrateUserData(userData, oldName) {
  const legacy = path.join(path.dirname(userData), oldName);
  try {
    if (!fs.existsSync(legacy) || path.resolve(legacy) === path.resolve(userData)) return;
    for (const name of ['models', 'venv', 'samples']) {
      const from = path.join(legacy, name);
      const to = path.join(userData, name);
      if (!fs.existsSync(from)) continue;
      if (fs.existsSync(to)) {
        if (fs.readdirSync(to).length) continue; // already has data: leave both alone
        fs.rmdirSync(to);
      }
      fs.mkdirSync(userData, { recursive: true });
      fs.renameSync(from, to);
    }
    const oldMarker = path.join(userData, 'venv', '.narrata-ok');
    if (fs.existsSync(oldMarker)) fs.renameSync(oldMarker, path.join(userData, 'venv', '.booklark-ok'));
  } catch (err) {
    console.warn(`Could not move data from ${legacy}: ${err.message}`);
  }
}

module.exports = { migrateUserData };
