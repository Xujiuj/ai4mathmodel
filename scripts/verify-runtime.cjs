const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const runtimeRoot = path.join(projectRoot, 'runtime');
const runtimeLock = JSON.parse(fs.readFileSync(path.join(__dirname, 'runtime-lock.json'), 'utf8'));
const executables = Object.freeze({
  python: path.join(runtimeRoot, 'python', 'python.exe'),
  tectonic: path.join(runtimeRoot, 'tectonic', 'tectonic.exe'),
});

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${path.basename(command)} failed (${result.status}):\n${result.stderr || result.stdout}`);
  }
  return `${result.stdout || ''}${result.stderr || ''}`;
}

function sha256(file) {
  return require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function assertRuntimeLayout() {
  const minimumSizes = { python: 50 * 1024, tectonic: 20 * 1024 * 1024 };
  for (const [tool, executable] of Object.entries(executables)) {
    assert.equal(fs.existsSync(executable), true, `missing bundled ${tool}`);
    assert.ok(fs.statSync(executable).size >= minimumSizes[tool], `${tool} executable is unexpectedly small`);
  }
  assert.equal(sha256(executables.python), runtimeLock.python.executableSha256, 'bundled Python executable hash changed');
  assert.equal(sha256(executables.tectonic), runtimeLock.tectonic.executableSha256, 'bundled Tectonic executable hash changed');

  for (const name of ['simhei.ttf', 'simkai.ttf', 'simsun.ttf']) {
    const font = path.join(runtimeRoot, 'tectonic', 'fonts', name);
    assert.equal(fs.existsSync(font), true, `missing bundled Tectonic font alias: ${name}`);
    assert.ok(fs.statSync(font).size > 1024 * 1024, `bundled font alias is unexpectedly small: ${name}`);
    assert.equal(sha256(font), runtimeLock.tectonic.fontAliases[name], `bundled font alias hash changed: ${name}`);
  }

  const cacheRoot = path.join(runtimeRoot, 'tectonic', 'cache');
  let cacheFiles = 0;
  let cacheBytes = 0;
  const cachePending = [cacheRoot];
  while (cachePending.length) {
    const directory = cachePending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) cachePending.push(target);
      if (entry.isFile()) {
        cacheFiles += 1;
        cacheBytes += fs.statSync(target).size;
      }
    }
  }
  assert.ok(cacheFiles >= 300, 'bundled Tectonic cache is incomplete');
  assert.ok(cacheBytes >= 50 * 1024 * 1024, 'bundled Tectonic cache is unexpectedly small');

  const forbiddenNames = new Set(['skill.md', '.agents', 'agents.md', '__pycache__']);
  const pending = [runtimeRoot];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      assert.equal(forbiddenNames.has(entry.name.toLowerCase()), false, `forbidden runtime entry: ${path.join(directory, entry.name)}`);
      assert.equal(entry.name.toLowerCase().endsWith('.pyc'), false, `compiled Python cache must not be packaged: ${path.join(directory, entry.name)}`);
      if (entry.isDirectory()) pending.push(path.join(directory, entry.name));
    }
  }

}

function smokeTectonicCompile() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mmw-tectonic-audit-'));
  const source = path.join(root, 'runtime-smoke.tex');
  try {
    for (const name of ['simhei.ttf', 'simkai.ttf', 'simsun.ttf']) {
      fs.copyFileSync(path.join(runtimeRoot, 'tectonic', 'fonts', name), path.join(root, name));
    }
    fs.writeFileSync(source, String.raw`\documentclass[12pt]{article}
\usepackage{ctex}
\setCJKmainfont{simkai.ttf}
\setCJKsansfont{simhei.ttf}
\setCJKmonofont{simsun.ttf}
\begin{document}
中文论文编译运行时验证。Mathematical modeling runtime verification.
\end{document}
`, 'utf8');
    run(executables.tectonic, [
      '--untrusted',
      '--only-cached',
      '--outdir', root,
      path.basename(source),
    ], {
      cwd: root,
      env: {
        ...process.env,
        TECTONIC_CACHE_DIR: path.join(runtimeRoot, 'tectonic', 'cache'),
      },
    });
    const pdf = path.join(root, 'runtime-smoke.pdf');
    assert.equal(fs.existsSync(pdf), true, 'Tectonic did not produce the smoke-test PDF');
    assert.equal(fs.readFileSync(pdf).subarray(0, 5).toString('ascii'), '%PDF-', 'Tectonic smoke output is not a PDF');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function smokeRuntime() {
  const pythonEnvironment = {
    ...process.env,
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONNOUSERSITE: '1',
    PYTHONUTF8: '1',
  };
  const pythonVersion = run(executables.python, ['-c', [
    'import cvxpy, geopandas, matplotlib, networkx, numpy, openpyxl, ortools, pandas',
    'import pymupdf, rapidocr_onnxruntime, scipy, sklearn, statsmodels, sympy, xgboost',
    "print('python-runtime-ok', numpy.__version__, pandas.__version__, scipy.__version__)",
  ].join('; ')], { env: pythonEnvironment }).trim();
  const installed = run(executables.python, ['-m', 'pip', 'freeze', '--all'], { env: pythonEnvironment })
    .split(/\r?\n/).map((line) => line.trim()).filter(Boolean).sort();
  const expected = fs.readFileSync(path.join(__dirname, 'runtime-python-requirements.txt'), 'utf8')
    .split(/\r?\n/).map((line) => line.trim()).filter(Boolean).sort();
  assert.deepEqual(installed, expected, 'bundled Python dependencies differ from the locked requirements');
  const tectonicVersion = run(executables.tectonic, ['--version']).trim();
  process.stdout.write(`${pythonVersion}\n${tectonicVersion}\n`);
}

assertRuntimeLayout();
smokeRuntime();
smokeTectonicCompile();
process.stdout.write('Bundled runtime verification passed.\n');
