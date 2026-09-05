'use strict';
// Bundles Narrata for the current platform into dist/. Prunes the parts of node_modules that
// only exist for other platforms or for GPUs, which is most of their size.
const path = require('node:path');
const { packager } = require('@electron/packager');

const plat = process.platform;
const arch = process.arch;

packager({
  dir: path.join(__dirname, '..'),
  out: path.join(__dirname, '..', 'dist'),
  name: 'Narrata',
  executableName: 'narrata',
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
    /^\/node_modules\/@huggingface\/transformers\/dist\/(?!transformers\.node\.)/,
    /\.(map|md|ts)$/,
  ],
}).then((paths) => {
  console.log(`Packaged: ${paths.join(', ')}`);
}, (err) => {
  console.error(err);
  process.exit(1);
});
