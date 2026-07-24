const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..');

test('installer keeps application and runtime payloads outside the entry executable', () => {
  const source = fs.readFileSync(path.join(projectRoot, 'installer', 'installer.nsi'), 'utf8');
  assert.match(source, /\$EXEDIR\\packages\\\$\{CORE_FILE\}/);
  assert.match(source, /certutil\.exe.*SHA256/);
  assert.match(source, /SectionGroup "可选运行组件"/);
  assert.match(source, /SectionSetFlags \$\{SEC_PYTHON\} 0/);
  assert.doesNotMatch(source, /SEC_CODEX|CODEX_FILE/);
  assert.doesNotMatch(source, /File \/r .*win-unpacked|File .*CORE_FILE/);
});

test('installed application uses a lightweight launcher in front of the Electron runtime', () => {
  const source = fs.readFileSync(path.join(projectRoot, 'installer', 'launcher.nsi'), 'utf8');
  assert.match(source, /MathModelingWorkbench\.runtime\.exe/);
  assert.match(source, /SilentInstall silent/);
  assert.doesNotMatch(source, /File \/r|File .*app\.asar/);
});

test('installer builder emits three independently verifiable component archives', () => {
  const source = fs.readFileSync(path.join(projectRoot, 'scripts', 'build-modular-installer.cjs'), 'utf8');
  for (const component of ['core', 'python', 'tectonic']) {
    assert.match(source, new RegExp(`id: '${component}'`));
  }
  assert.match(source, /sha256/);
  assert.match(source, /payload-manifest\.json/);
});
