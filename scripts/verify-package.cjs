const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const asar = require('@electron/asar');
const {
  FuseV1Options,
  getCurrentFuseWire,
} = require('@electron/fuses');
const FUSE_DISABLED = '0'.charCodeAt(0);
const FUSE_ENABLED = '1'.charCodeAt(0);

const projectRoot = path.resolve(__dirname, '..');
const packageInfo = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
const unpackedRoot = path.resolve(process.argv[2] || path.join(projectRoot, 'release', 'win-unpacked'));
const resources = path.join(unpackedRoot, 'resources');
const archive = path.join(resources, 'app.asar');
const executable = path.join(unpackedRoot, `${packageInfo.build.productName}.exe`);

function normalize(entry) {
  return String(entry).replaceAll('\\', '/').replace(/^\/+/, '');
}

function assertArchiveBoundary() {
  assert.equal(fs.existsSync(archive), true, 'packaged app.asar is missing');
  const rawEntries = asar.listPackage(archive, { isPack: false });
  const entries = rawEntries.map(normalize).filter(Boolean);
  const allowedRoots = ['dist/', 'electron/', 'node_modules/bytenode/', 'package.json'];
  for (const entry of entries) {
    assert.ok(allowedRoots.some((root) => {
      const allowed = root.replace(/\/$/, '');
      return entry === allowed || entry.startsWith(`${allowed}/`) || allowed.startsWith(`${entry}/`);
    }), `unexpected ASAR entry: ${entry}`);
    assert.doesNotMatch(entry.toLowerCase(), /(?:^|\/)(?:skill\.md|agents\.md|\.agents|src|scripts|tests)(?:\/|$)/, `private source entry in ASAR: ${entry}`);
    assert.doesNotMatch(entry.toLowerCase(), /\.map$/, `source map in ASAR: ${entry}`);
  }
  for (const required of [
    'electron/bootstrap.cjs',
    'electron/preload.cjs',
    'electron/protected/loader.jsc',
    'electron/protected/runtime.bin',
    'electron/protected/spreadsheet-worker.cjs',
    'package.json',
  ]) {
    assert.ok(entries.includes(required), `required ASAR entry is missing: ${required}`);
  }
  assert.equal(entries.includes('electron/main.cjs'), false, 'plaintext Electron main process was packaged');
  const protectedRuntimeEntry = 'electron\\protected\\runtime.bin';
  assert.ok(asar.extractFile(archive, protectedRuntimeEntry).length > 32 * 1024, 'protected runtime payload is unexpectedly small');
}

function assertRuntimeBoundary() {
  const runtimeRoot = path.join(resources, 'runtime');
  const notices = path.join(runtimeRoot, 'THIRD_PARTY_NOTICES.txt');
  assert.equal(fs.existsSync(notices), true, 'core package third-party notices are missing');
  assert.ok(fs.statSync(notices).size >= 256, 'core package third-party notices are unexpectedly small');
  for (const component of ['python', 'tectonic']) {
    assert.equal(fs.existsSync(path.join(runtimeRoot, component)), false, `optional runtime leaked into core package: ${component}`);
  }
  const forbidden = new Set(['skill.md', 'agents.md', '.agents', '__pycache__']);
  const pending = [runtimeRoot];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      assert.equal(forbidden.has(entry.name.toLowerCase()), false, `forbidden packaged runtime entry: ${target}`);
      assert.equal(entry.name.toLowerCase().endsWith('.pyc'), false, `compiled Python cache was packaged: ${target}`);
      if (entry.isDirectory()) pending.push(target);
    }
  }
}

async function assertFuses() {
  assert.equal(fs.existsSync(executable), true, 'packaged application executable is missing');
  const wire = await getCurrentFuseWire(executable);
  assert.equal(wire[FuseV1Options.RunAsNode], FUSE_DISABLED, 'RunAsNode fuse is not disabled');
  assert.equal(wire[FuseV1Options.EnableCookieEncryption], FUSE_ENABLED, 'cookie encryption fuse is not enabled');
  assert.equal(wire[FuseV1Options.EnableNodeOptionsEnvironmentVariable], FUSE_DISABLED, 'NODE_OPTIONS fuse is not disabled');
  assert.equal(wire[FuseV1Options.EnableNodeCliInspectArguments], FUSE_DISABLED, 'Node inspect fuse is not disabled');
  assert.equal(wire[FuseV1Options.EnableEmbeddedAsarIntegrityValidation], FUSE_ENABLED, 'ASAR integrity fuse is not enabled');
  assert.equal(wire[FuseV1Options.OnlyLoadAppFromAsar], FUSE_ENABLED, 'ASAR-only fuse is not enabled');
}

assertArchiveBoundary();
assertRuntimeBoundary();
assertFuses()
  .then(() => process.stdout.write(`Packaged application verification passed: ${unpackedRoot}\n`))
  .catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
