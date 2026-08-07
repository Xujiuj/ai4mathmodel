#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const result = spawnSync(require('electron'), [path.join(projectRoot, 'electron', 'qa.cjs')], {
  cwd: projectRoot,
  env: process.env,
  stdio: 'inherit',
  windowsHide: true,
});

if (result.error) throw result.error;
if (result.signal) {
  process.stderr.write(`Electron QA terminated by ${result.signal}\n`);
  process.exitCode = 1;
} else {
  process.exitCode = Number.isInteger(result.status) ? result.status : 1;
}
