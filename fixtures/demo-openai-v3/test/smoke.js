// Offline smoke test: every JS source file in this repo must parse.
// Deliberately dependency-free (the fixture has no node_modules) so it can
// run in any sandbox; a fixer that emits broken syntax makes this fail.
const { execFileSync } = require('node:child_process');
const { readdirSync, statSync } = require('node:fs');
const { join } = require('node:path');

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(js|cjs|mjs)$/.test(name)) yield p;
  }
}

let checked = 0;
for (const file of walk(join(__dirname, '..'))) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  checked++;
}
if (checked === 0) throw new Error('smoke test found no JS files to check');
console.log(`smoke: ${checked} file(s) parsed OK`);
