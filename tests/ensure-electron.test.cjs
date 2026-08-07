const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ensureElectron,
  readElectronContract,
  verifyElectronInstallation,
} = require('../scripts/ensure-electron.cjs');

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mmw-ensure-electron-'));
  const electronRoot = path.join(root, 'node_modules', 'electron');
  fs.mkdirSync(electronRoot, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    devDependencies: { electron: '^43.2.0' },
  }));
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({
    lockfileVersion: 3,
    packages: { 'node_modules/electron': { version: '43.2.0' } },
  }));
  fs.writeFileSync(path.join(electronRoot, 'package.json'), JSON.stringify({
    version: '43.2.0',
    bin: { 'install-electron': 'install.js' },
  }));
  fs.writeFileSync(path.join(electronRoot, 'install.js'), '// official installer fixture');
  return root;
}

function writeInstalled(root, version = '43.2.0', executable = true) {
  const dist = path.join(root, 'node_modules', 'electron', 'dist');
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, 'version'), `${version}\n`);
  fs.writeFileSync(path.join(root, 'node_modules', 'electron', 'path.txt'), 'electron.exe\n');
  if (executable) fs.writeFileSync(path.join(dist, 'electron.exe'), Buffer.alloc(2048, 1));
}

function setContractVersions(root, spec, version) {
  const packagePath = path.join(root, 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  packageJson.devDependencies.electron = spec;
  fs.writeFileSync(packagePath, JSON.stringify(packageJson));
  const lockPath = path.join(root, 'package-lock.json');
  const lockfile = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  lockfile.packages['node_modules/electron'].version = version;
  fs.writeFileSync(lockPath, JSON.stringify(lockfile));
  const electronPath = path.join(root, 'node_modules', 'electron', 'package.json');
  const electronPackage = JSON.parse(fs.readFileSync(electronPath, 'utf8'));
  electronPackage.version = version;
  fs.writeFileSync(electronPath, JSON.stringify(electronPackage));
}

test('ensureElectron runs the official installer only when Electron is incomplete', () => {
  const root = makeFixture();
  let installs = 0;
  const install = () => {
    installs += 1;
    writeInstalled(root);
  };

  const first = ensureElectron({ projectRoot: root, hostPlatform: 'win32', install });
  assert.equal(first.ok, true);
  assert.equal(installs, 1);
  const second = ensureElectron({ projectRoot: root, hostPlatform: 'win32', install });
  assert.equal(second.ok, true);
  assert.equal(installs, 1);
});

test('ensureElectron fails closed when the installer cannot produce a matching executable', () => {
  const root = makeFixture();
  assert.throws(
    () => ensureElectron({
      projectRoot: root,
      hostPlatform: 'win32',
      install: () => writeInstalled(root, '43.2.0', false),
    }),
    /installation failed closed.*executable is missing/,
  );
});

test('Electron contract rejects a package that is not the lockfile version', () => {
  const root = makeFixture();
  fs.writeFileSync(path.join(root, 'node_modules', 'electron', 'package.json'), JSON.stringify({
    version: '43.2.1',
    bin: { 'install-electron': 'install.js' },
  }));
  assert.throws(() => readElectronContract(root), /does not match lockfile/);
});

test('Electron contract enforces exact, caret, and tilde semver lower and upper bounds', () => {
  const lowerBound = makeFixture();
  setContractVersions(lowerBound, '^43.2.0', '43.1.9');
  assert.throws(() => readElectronContract(lowerBound), /does not include locked version/);

  const caretPatch = makeFixture();
  setContractVersions(caretPatch, '^43.2.0', '43.2.1');
  assert.doesNotThrow(() => readElectronContract(caretPatch));

  const caretSameMajor = makeFixture();
  setContractVersions(caretSameMajor, '^43.2.0', '43.9.0');
  assert.doesNotThrow(() => readElectronContract(caretSameMajor));

  const caretMajor = makeFixture();
  setContractVersions(caretMajor, '^43.2.0', '44.0.0');
  assert.throws(() => readElectronContract(caretMajor), /does not include locked version/);

  const tildePatch = makeFixture();
  setContractVersions(tildePatch, '~43.2.0', '43.2.9');
  assert.doesNotThrow(() => readElectronContract(tildePatch));

  const tildeMinor = makeFixture();
  setContractVersions(tildeMinor, '~43.2.0', '43.3.0');
  assert.throws(() => readElectronContract(tildeMinor), /does not include locked version/);
});

test('verifyElectronInstallation checks version, path metadata, and executable size', () => {
  const root = makeFixture();
  const contract = readElectronContract(root);
  assert.equal(verifyElectronInstallation(contract, {}, 'win32').ok, false);
  writeInstalled(root);
  assert.equal(verifyElectronInstallation(contract, {}, 'win32').ok, true);
  fs.writeFileSync(path.join(root, 'node_modules', 'electron', 'path.txt'), 'electron\n');
  assert.match(verifyElectronInstallation(contract, {}, 'win32').reason, /path\.txt/);
});
