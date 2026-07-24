const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const packageInfo = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
const kitRoot = path.join(projectRoot, 'release', `MathModelingWorkbench-${packageInfo.version}-Installer`);
const setupFile = path.join(kitRoot, `MathModelingWorkbench-${packageInfo.version}-Setup.exe`);
const manifestFile = path.join(kitRoot, 'payload-manifest.json');

function sha256(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function archiveEntries(archive) {
  const sevenZip = path.join(projectRoot, 'node_modules', 'electron-winstaller', 'vendor', '7z.exe');
  assert.equal(fs.existsSync(sevenZip), true, '7-Zip verification tool is missing');
  const result = spawnSync(sevenZip, ['l', '-slt', archive], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `Unable to inspect archive: ${path.basename(archive)}\n${result.stderr || result.stdout}`);
  const separator = result.stdout.indexOf('----------');
  return result.stdout.slice(separator + 10).split(/\r?\n/)
    .filter((line) => line.startsWith('Path = '))
    .map((line) => line.slice(7).replaceAll('\\', '/'));
}

assert.equal(fs.existsSync(setupFile), true, 'installer entry executable is missing');
const setupSize = fs.statSync(setupFile).size;
assert.ok(setupSize > 128 * 1024, 'installer entry executable is unexpectedly small');
assert.ok(setupSize < 5 * 1024 * 1024, `installer entry must not embed application payloads: ${setupSize} bytes`);
assert.equal(fs.existsSync(manifestFile), true, 'installer payload manifest is missing');

const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.version, packageInfo.version);
assert.ok(manifest.entryExecutable.bytes > 32 * 1024, 'application entry executable is unexpectedly small');
assert.ok(manifest.entryExecutable.bytes < 1024 * 1024, 'application entry executable must remain a lightweight launcher');
assert.equal(manifest.entryExecutable.runtimeFile, 'MathModelingWorkbench.runtime.exe');
assert.deepEqual(manifest.packages.map((item) => item.id), ['core', 'python', 'tectonic']);
assert.equal(manifest.packages.find((item) => item.id === 'core').required, true);
assert.deepEqual(
  fs.readdirSync(path.join(kitRoot, 'packages')).sort(),
  manifest.packages.map((item) => item.file).sort(),
  'installer package directory contains an unexpected payload',
);

for (const item of manifest.packages) {
  const archive = path.join(kitRoot, 'packages', item.file);
  assert.equal(fs.existsSync(archive), true, `installer payload is missing: ${item.id}`);
  assert.equal(fs.statSync(archive).size, item.bytes, `installer payload size changed: ${item.id}`);
  assert.equal(sha256(archive), item.sha256, `installer payload digest changed: ${item.id}`);
  const entries = archiveEntries(archive);
  assert.ok(entries.length > 0, `installer payload is empty: ${item.id}`);
  for (const entry of entries) {
    assert.equal(path.posix.isAbsolute(entry), false, `absolute payload path: ${entry}`);
    assert.equal(entry.split('/').includes('..'), false, `traversal payload path: ${entry}`);
    assert.doesNotMatch(entry.toLowerCase(), /(?:^|\/)(?:skill\.md|agents\.md|\.agents)(?:\/|$)/, `private file in payload: ${entry}`);
  }
  if (item.id === 'core') {
    assert.ok(entries.filter((entry) => !entry.includes('/') && entry.toLowerCase().endsWith('.exe')).length >= 2, 'launcher or runtime executable is missing');
    assert.ok(entries.includes('MathModelingWorkbench.runtime.exe'), 'Electron runtime executable is missing');
    assert.ok(entries.includes('resources/app.asar'), 'core ASAR is missing');
    assert.equal(entries.some((entry) => /^resources\/runtime\/(?:python|tectonic)(?:\/|$)/i.test(entry)), false, 'optional runtime leaked into core payload');
  } else {
    assert.ok(entries.every((entry) => entry === item.id || entry.startsWith(`${item.id}/`)), `payload crossed component boundary: ${item.id}`);
  }
}

const kitEntries = fs.readdirSync(kitRoot).sort();
assert.deepEqual(kitEntries, [
  `MathModelingWorkbench-${packageInfo.version}-Setup.exe`,
  'packages',
  'payload-manifest.json',
].sort());
process.stdout.write(`Modular installer verification passed: ${kitRoot}\n`);
