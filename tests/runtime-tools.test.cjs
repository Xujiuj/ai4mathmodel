const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildRuntimeEnvironment,
  resolveRuntimeExecutable,
  resolveLatexCompiler,
  runtimeStatus,
  runtimeToolPath,
  seedTectonicCache,
  withTectonicFontAliases,
} = require('../electron/runtime-tools.cjs');

test('packaged builds prioritize installed optional runtime executables and fall back to local commands', () => {
  const resourcesPath = fs.mkdtempSync(path.join(os.tmpdir(), 'mmw-runtime-'));
  const candidate = runtimeToolPath('tectonic', {
    isPackaged: true,
    resourcesPath,
    platform: 'win32',
  });
  fs.mkdirSync(path.dirname(candidate), { recursive: true });
  fs.writeFileSync(candidate, 'binary');

  assert.equal(resolveRuntimeExecutable('tectonic', {
    isPackaged: true,
    resourcesPath,
    platform: 'win32',
  }), candidate);
  assert.equal(resolveRuntimeExecutable('python', {
    isPackaged: true,
    resourcesPath,
    platform: 'win32',
    env: { Path: '' },
  }), 'python');
});

test('reports bundled and local runtime component availability', () => {
  const resourcesPath = path.resolve('resources');
  const installed = runtimeToolPath('python', { isPackaged: true, resourcesPath, platform: 'win32' });
  const status = runtimeStatus({
    isPackaged: true,
    resourcesPath,
    platform: 'win32',
    existsSync: (candidate) => candidate === installed,
  });

  assert.deepEqual(status, { python: true, tectonic: false });

  const localPython = path.join('C:\\LocalTools', 'python.exe');
  const localStatus = runtimeStatus({
    isPackaged: true,
    resourcesPath,
    platform: 'win32',
    env: { Path: 'C:\\LocalTools' },
    existsSync: (candidate) => candidate === localPython,
  });
  assert.deepEqual(localStatus, { python: true, tectonic: false });
  assert.equal(resolveRuntimeExecutable('python', {
    isPackaged: true,
    resourcesPath,
    platform: 'win32',
    env: { Path: 'C:\\LocalTools' },
    existsSync: (candidate) => candidate === localPython,
  }), localPython);
});

test('development builds fall back to command names', () => {
  assert.equal(resolveRuntimeExecutable('tectonic', {
    isPackaged: false,
    appRoot: path.resolve('missing-app-root'),
    platform: 'win32',
    existsSync: () => false,
  }), 'tectonic');
});

test('runtime environment isolates application state and prioritizes bundled tools', () => {
  const resourcesPath = path.resolve('resources');
  const userData = path.resolve('user-data');
  const environment = buildRuntimeEnvironment({
    base: { Path: 'C:\\Users\\test\\bin', SystemRoot: 'C:\\Windows' },
    isPackaged: true,
    resourcesPath,
    userData,
    platform: 'win32',
    existsSync: () => true,
  });

  assert.equal(environment.HOME, path.join(userData, 'runtime', 'home'));
  assert.equal(environment.PYTHONHOME, path.join(resourcesPath, 'runtime', 'python'));
  assert.equal(environment.PYTHONNOUSERSITE, '1');
  assert.equal(environment.TECTONIC_CACHE_DIR, path.join(userData, 'runtime', 'cache', 'tectonic'));
  assert.match(environment.Path, /runtime[\\/]python/);
  assert.ok(environment.Path.indexOf(path.join(resourcesPath, 'runtime', 'python')) < environment.Path.indexOf('C:\\Windows'));
  assert.doesNotMatch(environment.Path, /Users[\\/]test[\\/]bin/i);
  assert.match(environment.Path, /Windows[\\/]System32/i);
});

test('local Python fallback does not force the bundled PYTHONHOME', () => {
  const environment = buildRuntimeEnvironment({
    base: { Path: 'C:\\Tools\\python' },
    isPackaged: true,
    resourcesPath: path.resolve('core-only-resources'),
    userData: path.resolve('user-data'),
    platform: 'win32',
    existsSync: () => false,
  });
  assert.equal(environment.PYTHONHOME, undefined);
  assert.match(environment.Path, /Tools[\\/]python/i);
});

test('uses a local LaTeX compiler when bundled Tectonic is absent', () => {
  const localXeLaTeX = path.join('C:\\LocalTeX', 'xelatex.exe');
  const compiler = resolveLatexCompiler({
    isPackaged: true,
    resourcesPath: path.resolve('core-only-resources'),
    platform: 'win32',
    env: { Path: 'C:\\LocalTeX' },
    existsSync: (candidate) => candidate === localXeLaTeX,
  });
  assert.deepEqual(compiler, { executable: localXeLaTeX, kind: 'xelatex', source: 'local' });
});

test('development runtime keeps the inherited PATH fallback', () => {
  const environment = buildRuntimeEnvironment({
    base: { Path: 'C:\\Tools\\custom-bin' },
    isPackaged: false,
    appRoot: path.resolve('app'),
    userData: path.resolve('user-data'),
    platform: 'win32',
  });

  assert.match(environment.Path, /Tools[\\/]custom-bin/i);
});

test('seeds the bundled Tectonic cache once per application version', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mmw-tectonic-cache-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appRoot = path.join(root, 'app');
  const userData = path.join(root, 'user-data');
  const sourceFile = path.join(appRoot, 'runtime', 'tectonic', 'cache', 'files', 'bundle.dat');
  fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
  fs.writeFileSync(sourceFile, 'cached-resource');

  const first = await seedTectonicCache({ appRoot, userData }, { seedVersion: '0.1.0' });
  const second = await seedTectonicCache({ appRoot, userData }, { seedVersion: '0.1.0' });

  assert.equal(first.seeded, true);
  assert.equal(second.reason, 'current');
  assert.equal(fs.readFileSync(path.join(userData, 'runtime', 'cache', 'tectonic', 'files', 'bundle.dat'), 'utf8'), 'cached-resource');
});

test('starts without Tectonic when the optional component is not installed', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mmw-core-runtime-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = await seedTectonicCache({
    isPackaged: true,
    resourcesPath: path.join(root, 'resources'),
    userData: path.join(root, 'user-data'),
  }, { required: false });

  assert.equal(result.seeded, false);
  assert.equal(result.reason, 'source-missing');
  await assert.rejects(seedTectonicCache({
    isPackaged: true,
    resourcesPath: path.join(root, 'resources'),
    userData: path.join(root, 'required-user-data'),
  }, { required: true }), (error) => error.code === 'RUNTIME_ASSET_MISSING');
});

test('Tectonic font aliases are temporary and preserve template-owned fonts', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mmw-tectonic-fonts-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appRoot = path.join(root, 'app');
  const paperDirectory = path.join(root, 'paper');
  const fontDirectory = path.join(appRoot, 'runtime', 'tectonic', 'fonts');
  fs.mkdirSync(fontDirectory, { recursive: true });
  fs.mkdirSync(paperDirectory, { recursive: true });
  for (const name of ['simhei.ttf', 'simkai.ttf', 'simsun.ttf']) {
    fs.writeFileSync(path.join(fontDirectory, name), `bundled-${name}`);
  }
  fs.writeFileSync(path.join(paperDirectory, 'simkai.ttf'), 'template-font');

  await assert.rejects(withTectonicFontAliases(paperDirectory, { appRoot }, async () => {
    assert.equal(fs.existsSync(path.join(paperDirectory, 'simhei.ttf')), true);
    assert.equal(fs.existsSync(path.join(paperDirectory, 'simsun.ttf')), true);
    assert.equal(fs.readFileSync(path.join(paperDirectory, 'simkai.ttf'), 'utf8'), 'template-font');
    throw new Error('compile failed');
  }), /compile failed/);

  assert.equal(fs.existsSync(path.join(paperDirectory, 'simhei.ttf')), false);
  assert.equal(fs.existsSync(path.join(paperDirectory, 'simsun.ttf')), false);
  assert.equal(fs.readFileSync(path.join(paperDirectory, 'simkai.ttf'), 'utf8'), 'template-font');
});
