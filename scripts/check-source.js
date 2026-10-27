const fs = require('node:fs');
const path = require('node:path');

const roots = ['renderer.js', 'main.js', 'preload.js', 'launcher/main.js', 'launcher/preload.js'];
// Catch the escaped-newline corruption that previously broke esbuild.
const suspicious = /\\n[ \t]*(?=(?:const|let|var|function|if|for|while|return|class|async|window\.|document\.|\}|\);))/g;
let failed = false;

for (const file of roots) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  for (const match of source.matchAll(suspicious)) {
    const line = source.slice(0, match.index).split('\n').length;
    console.error(file + ':' + line + ': literal backslash-n appears before JavaScript code; use a real newline.');
    failed = true;
  }
}

if (failed) {
  console.error('Build stopped: fix the escaped-newline corruption before packaging.');
  process.exit(1);
}
console.log('Source preflight passed: no suspicious escaped newlines found.');
