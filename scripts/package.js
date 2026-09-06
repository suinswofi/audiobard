'use strict';
// Bundles Narrata into dist/. Prunes the parts of node_modules that only exist for other
// platforms or for GPUs, which is most of their size.
//
//   node scripts/package.js                         current platform
//   node scripts/package.js --platform win32        cross-build (Windows from Linux works)
//   node scripts/package.js --archive               also produce a .tar.gz (linux) or .zip (win32/darwin)
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { packager } = require('@electron/packager');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const plat = opt('platform', process.platform);
const arch = opt('arch', 'x64');
const root = path.join(__dirname, '..');
const out = path.join(root, 'dist');

// sharp (pulled in by transformers.js) ships one native package per platform and npm only
// installs the host's; asking npm to install another platform's replaces the host's. So the
// target's packages are fetched with `npm pack` and unpacked straight into node_modules.
function ensureSharpFor(platform, cpu) {
  const sharpPkg = require(path.join(root, 'node_modules/sharp/package.json'));
  const wanted = [
    [`@img/sharp-${platform}-${cpu}`, sharpPkg.version],
    [`@img/sharp-libvips-${platform}-${cpu}`, sharpPkg.optionalDependencies[`@img/sharp-libvips-${platform}-${cpu}`]],
  ].filter(([, version]) => version);
  for (const [pkg, version] of wanted) {
    const dest = path.join(root, 'node_modules', pkg);
    if (fs.existsSync(dest)) continue;
    console.log(`Fetching ${pkg}@${version} for the ${platform} build...`);
    const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'narrata-pack-'));
    const r = spawnSync('npm', ['pack', `${pkg}@${version}`, '--pack-destination', tmp, '--silent'], { cwd: root, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`Could not fetch ${pkg}: ${r.stderr}`);
    const tarball = fs.readdirSync(tmp).find((f) => f.endsWith('.tgz'));
    fs.mkdirSync(dest, { recursive: true });
    const x = spawnSync('tar', ['-xzf', path.join(tmp, tarball), '--strip-components=1', '-C', dest]);
    fs.rmSync(tmp, { recursive: true, force: true });
    if (x.status !== 0) throw new Error(`Could not unpack ${pkg}`);
  }
}

function archive(dir) {
  const base = path.basename(dir);
  const cwd = path.dirname(dir);
  let file, r;
  if (plat === 'linux') {
    file = `${dir}.tar.gz`;
    r = spawnSync('tar', ['-czf', file, base], { cwd, stdio: 'inherit' });
  } else {
    file = `${dir}.zip`;
    r = spawnSync('zip', ['-qr', file, base], { cwd, stdio: 'inherit' });
  }
  if (r.status !== 0) throw new Error(`Archiving ${base} failed`);
  return file;
}

(async () => {
  ensureSharpFor(plat, arch);
  const [dir] = await packager({
    dir: root,
    out,
    name: 'Narrata',
    executableName: 'narrata',
    platform: plat,
    arch,
    overwrite: true,
    asar: false, // native ONNX Runtime libraries are loaded from disk by path
    prune: true,
    ignore: [
      /^\/(fixtures|out|dist|scripts|\.git|\.gitignore|README\.md)(\/|$)/,
      /^\/node_modules\/\.bin(\/|$)/,
      /^\/node_modules\/onnxruntime-web\/dist\/.*\.wasm$/, // transformers.js imports onnxruntime-web even in Node, but never runs its WASM here
      // keep only bin/napi-v3/<platform>/<arch> (the walker visits the platform dir first, so allow it too)
      new RegExp(`^/node_modules/onnxruntime-node/bin/napi-v3/(?!${plat}(/${arch}(/|$)|$))`),
      /libonnxruntime_providers_(cuda|tensorrt)/,
      /onnxruntime_providers_(cuda|tensorrt)\.dll$/,
      new RegExp(`^/node_modules/@img/sharp-(?!libvips-)(?!${plat}-${arch}(/|$))`),
      new RegExp(`^/node_modules/@img/sharp-libvips-(?!${plat}-${arch}(/|$))`),
      /^\/node_modules\/@huggingface\/transformers\/dist\/(?!transformers\.node\.)/,
      /^(?!\/LICENSE\.md$).*\.(map|md|ts)$/,
    ],
  });
  // Narrata's own licence next to the executable, alongside Electron's LICENSE and LICENSES.chromium.html.
  fs.copyFileSync(path.join(root, 'LICENSE.md'), path.join(dir, 'LICENSE.md'));
  console.log(`Packaged: ${dir}`);
  if (args.includes('--archive')) {
    const file = archive(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`Archived: ${file} (${(fs.statSync(file).size / 1e6).toFixed(0)} MB)`);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
