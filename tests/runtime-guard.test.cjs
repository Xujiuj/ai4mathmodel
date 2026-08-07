const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  assertGuardArtifacts,
  readRuntimeLock,
} = require('../scripts/verify-runtime.cjs');

const projectRoot = path.resolve(__dirname, '..');
const runtimeRoot = path.join(projectRoot, 'runtime');

function scanSource(source) {
  const file = path.join(os.tmpdir(), `mmw-guard-scan-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.py`);
  fs.writeFileSync(file, source, 'utf8');
  try {
    return spawnSync('python', [path.join(runtimeRoot, 'guard', 'scan.py'), file], { encoding: 'utf8' });
  } finally {
    fs.rmSync(file, { force: true });
  }
}

async function runSandbox(root, source, { allowNetwork = false, extraEnv = {} } = {}) {
  const stageRoot = path.join(root, 'work', 'stage');
  const scriptDirectory = path.join(stageRoot, 'scripts');
  await fsp.mkdir(scriptDirectory, { recursive: true });
  const script = path.join(scriptDirectory, 'boundary.py');
  await fsp.writeFile(script, source, 'utf8');
  const guard = path.join(runtimeRoot, 'guard', 'sandbox_entry.py');
  return spawnSync('python', [guard, script], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...extraEnv,
      PROJECT_ROOT: root,
      WORKSPACE_STAGE_ROOT: stageRoot,
      WORKSPACE_CWD: scriptDirectory,
      ALLOW_NETWORK: allowNetwork ? '1' : '0',
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONNOUSERSITE: '1',
    },
  });
}

test('runtime lock pins the shipped guard scripts by size and hash', () => {
  const runtimeLock = readRuntimeLock();
  const guardNames = Object.keys(runtimeLock.guard || {}).sort();

  assert.deepEqual(guardNames, ['sandbox_entry.py', 'scan.py']);
  assertGuardArtifacts(runtimeRoot, runtimeLock);
});

test('AST guard rejects aliased forbidden modules and imported calls without blocking pathlib aliases', () => {
  const moduleAlias = scanSource([
    'import os as filesystem',
    'filesystem.remove("result.txt")',
  ].join('\n'));
  assert.notEqual(moduleAlias.status, 0);
  assert.match(`${moduleAlias.stderr}${moduleAlias.stdout}`, /Forbidden/);

  const callAlias = scanSource([
    'from subprocess import run as execute',
    'execute(["echo", "blocked"])',
  ].join('\n'));
  assert.notEqual(callAlias.status, 0);
  assert.match(`${callAlias.stderr}${callAlias.stdout}`, /Forbidden/);

  const allowedAlias = scanSource([
    'from pathlib import Path as SafePath',
    'SafePath("result.txt").write_text("ok", encoding="utf-8")',
  ].join('\n'));
  assert.equal(allowedAlias.status, 0, `${allowedAlias.stdout}\n${allowedAlias.stderr}`);
});

test('guard verification fails closed when the script size changes', async (context) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mmw-guard-size-'));
  context.after(() => fsp.rm(root, { recursive: true, force: true }));

  await fsp.mkdir(path.join(root, 'guard'), { recursive: true });
  await fsp.copyFile(path.join(runtimeRoot, 'guard', 'scan.py'), path.join(root, 'guard', 'scan.py'));
  await fsp.copyFile(path.join(runtimeRoot, 'guard', 'sandbox_entry.py'), path.join(root, 'guard', 'sandbox_entry.py'));

  const runtimeLock = readRuntimeLock();
  await fsp.appendFile(path.join(root, 'guard', 'scan.py'), '\n');

  assert.throws(() => assertGuardArtifacts(root, runtimeLock), /scan\.py.*size changed/);
});

test('guard verification fails closed when the script content changes without changing size', async (context) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mmw-guard-hash-'));
  context.after(() => fsp.rm(root, { recursive: true, force: true }));

  await fsp.mkdir(path.join(root, 'guard'), { recursive: true });
  await fsp.copyFile(path.join(runtimeRoot, 'guard', 'scan.py'), path.join(root, 'guard', 'scan.py'));
  await fsp.copyFile(path.join(runtimeRoot, 'guard', 'sandbox_entry.py'), path.join(root, 'guard', 'sandbox_entry.py'));

  const runtimeLock = readRuntimeLock();
  const scanPath = path.join(root, 'guard', 'scan.py');
  const bytes = await fsp.readFile(scanPath);
  bytes[0] ^= 0xff;
  await fsp.writeFile(scanPath, bytes);

  assert.throws(() => assertGuardArtifacts(root, runtimeLock), /scan\.py.*hash changed/);
});

test('runtime boundary enforces low-level reads, writes, process creation, network, and imports', async (context) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mmw-guard-boundary-'));
  const secretRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'mmw-guard-secret-'));
  context.after(() => Promise.all([
    fsp.rm(root, { recursive: true, force: true }),
    fsp.rm(secretRoot, { recursive: true, force: true }),
  ]));

  const secret = path.join(secretRoot, 'credentials.txt');
  const outsideWrite = path.join(secretRoot, 'outside-write.txt');
  const outsideDirectory = path.join(secretRoot, 'outside-directory');
  await fsp.writeFile(secret, 'private-value', 'utf8');
  await fsp.writeFile(path.join(root, 'approved.txt'), 'project-value', 'utf8');
  const stageOutput = path.join(root, 'work', 'stage', 'scripts', 'result.json');
  const source = [
    'import importlib',
    'import json',
    'import os',
    'import socket',
    'from pathlib import Path',
    `secret = ${JSON.stringify(secret)}`,
    `outside_write = ${JSON.stringify(outsideWrite)}`,
    `outside_directory = ${JSON.stringify(outsideDirectory)}`,
    `output = ${JSON.stringify(stageOutput)}`,
    'result = {}',
    'result["env_scrubbed"] = "SECRET_TOKEN" not in os.environ and set(os.environ) <= {"PROJECT_ROOT", "ALLOW_NETWORK", "HOME", "USERPROFILE", "TMP", "TEMP", "TMPDIR", "XDG_CONFIG_HOME", "MPLCONFIGDIR", "WINDIR", "SYSTEMROOT"}',
    `result["project_read"] = Path(${JSON.stringify(path.join(root, 'approved.txt'))}).read_text()`,
    'for name, action in [',
    '    ("pathlib_read", lambda: Path(secret).read_text()),',
    '    ("os_open_read", lambda: os.open(secret, os.O_RDONLY)),',
    '    ("reflective_open_read", lambda: importlib.import_module("os").open(secret, os.O_RDONLY)),',
    '    ("list_secret", lambda: os.listdir(os.path.dirname(secret))),',
    '    ("pathlib_write", lambda: Path(outside_write).write_text("blocked")),',
    '    ("mkdir_outside", lambda: os.mkdir(outside_directory)),',
    '    ("rename_outside", lambda: os.rename(output, outside_write)),',
    '    ("unlink_outside", lambda: os.unlink(secret)),',
    '    ("link_outside", lambda: os.symlink(secret, outside_write)),',
    '    ("child_process", lambda: os.system("echo blocked")),',
    '    ("network", lambda: socket.socket()),',
    '    ("reflective_process_import", lambda: importlib.import_module("subprocess").Popen(["python", "-c", "pass"])),',
    ']:',
    '    try:',
    '        action()',
    '        result[name] = "allowed"',
    '    except Exception as error:',
    '        result[name] = type(error).__name__',
    'Path(output).write_text(json.dumps(result, sort_keys=True), encoding="utf-8")',
  ].join('\n');

  const result = await runSandbox(root, source, { extraEnv: { SECRET_TOKEN: 'must-not-leak' } });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(await fsp.readFile(stageOutput, 'utf8'));
  assert.equal(report.env_scrubbed, true);
  assert.equal(report.project_read, 'project-value');
  for (const key of ['pathlib_read', 'os_open_read', 'reflective_open_read', 'list_secret', 'pathlib_write', 'mkdir_outside', 'rename_outside', 'unlink_outside', 'link_outside', 'child_process', 'network', 'reflective_process_import']) {
    assert.notEqual(report[key], 'allowed', `${key} unexpectedly bypassed the runtime boundary`);
  }
  assert.equal(fs.existsSync(outsideWrite), false);
  assert.equal(fs.existsSync(outsideDirectory), false);
  assert.equal(await fsp.readFile(secret, 'utf8'), 'private-value');
});

test('runtime entry module hides guard internals and audit hooks still cover reflected callables', async (context) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mmw-guard-main-module-'));
  const secretRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'mmw-guard-main-secret-'));
  context.after(() => Promise.all([
    fsp.rm(root, { recursive: true, force: true }),
    fsp.rm(secretRoot, { recursive: true, force: true }),
  ]));

  const secret = path.join(secretRoot, 'outside.txt');
  const output = path.join(root, 'work', 'stage', 'scripts', 'guard-module.json');
  await fsp.writeFile(secret, 'outside-secret', 'utf8');
  const source = [
    'import __main__',
    'import builtins',
    'import json',
    'from pathlib import Path',
    `secret = ${JSON.stringify(secret)}`,
    'result = {',
    '    "guard_globals_hidden": not any(hasattr(__main__, name) for name in ("_REAL_OPEN", "_REAL_IMPORT", "_REAL_OS_OPEN")),',
    '}',
    'actions = {',
    '    "main_real_open": lambda: getattr(__main__, "_REAL_OPEN")(secret).read(),',
    '    "reflected_real_open": lambda: builtins.open.__globals__["_REAL_OPEN"](secret).read(),',
    '    "reflected_real_import": lambda: builtins.__import__.__globals__["_REAL_IMPORT"]("subprocess").Popen(["python", "-c", "pass"]),',
    '    "native_fileio": lambda: builtins.__import__("_io").FileIO(secret, "r").read(),',
    '}',
    'for name, action in actions.items():',
    '    try:',
    '        action()',
    '        result[name] = "allowed"',
    '    except Exception as error:',
    '        result[name] = type(error).__name__',
    `Path(${JSON.stringify(output)}).write_text(json.dumps(result, sort_keys=True), encoding="utf-8")`,
  ].join('\n');

  const result = await runSandbox(root, source);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(await fsp.readFile(output, 'utf8'));
  assert.equal(report.guard_globals_hidden, true);
  assert.equal(report.main_real_open, 'AttributeError');
  assert.notEqual(report.reflected_real_open, 'allowed');
  assert.notEqual(report.reflected_real_import, 'allowed');
  assert.notEqual(report.native_fileio, 'allowed');
  assert.equal(await fsp.readFile(secret, 'utf8'), 'outside-secret');
});

test('desktop Python execution fails closed instead of embedding an unguarded fallback', () => {
  const mainSource = fs.readFileSync(path.join(projectRoot, 'electron', 'main.cjs'), 'utf8');
  assert.doesNotMatch(mainSource, /PYTHON_WORKSPACE_RUNNER|\['-c',\s*PYTHON_WORKSPACE_RUNNER/);
  assert.match(mainSource, /!fs\.existsSync\(guardScan\)\s*\|\|\s*!fs\.existsSync\(guardEntry\)/);
  assert.match(mainSource, /error:\s*'PYTHON_SANDBOX_UNAVAILABLE'/);
  assert.match(mainSource, /runPythonProgram\(root,\s*\[guardEntry,\s*target(?:,\s*\.\.\.argumentsList)?\]/);
});

test('runtime boundary permits socket construction only when explicitly enabled', async (context) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mmw-guard-network-'));
  context.after(() => fsp.rm(root, { recursive: true, force: true }));
  const stageRoot = path.join(root, 'work', 'stage');
  const output = path.join(stageRoot, 'network.txt');
  const source = [
    'import socket',
    'from pathlib import Path',
    'try:',
    '    sock = socket.socket()',
    '    sock.close()',
    '    status = "allowed"',
    'except PermissionError:',
    '    status = "blocked"',
    'except OSError:',
    '    status = "platform-unavailable"',
    `Path(${JSON.stringify(output)}).write_text(status, encoding="utf-8")`,
  ].join('\n');
  const result = await runSandbox(root, source, { allowNetwork: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.notEqual(await fsp.readFile(output, 'utf8'), 'blocked');
});

test('runtime boundary blocks native escape surfaces reached through scientific libraries', async (context) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mmw-guard-native-'));
  context.after(() => fsp.rm(root, { recursive: true, force: true }));
  const stageRoot = path.join(root, 'work', 'stage');
  const output = path.join(stageRoot, 'native.json');
  const source = [
    'import json',
    'import numpy',
    'from pathlib import Path',
    'ctypes_module = numpy.ctypeslib.ctypes',
    'low_level = ctypes_module._sys.modules["_ctypes"]',
    'result = {}',
    'for name, action in [',
    '    ("pythonapi", lambda: ctypes_module.pythonapi()),',
    '    ("memmove", lambda: ctypes_module.memmove()),',
    '    ("native_call", lambda: low_level.call_function()),',
    '    ("object_from_pointer", lambda: low_level.PyObj_FromPtr()),',
    ']:',
    '    try:',
    '        action()',
    '        result[name] = "allowed"',
    '    except Exception as error:',
    '        result[name] = type(error).__name__',
    `Path(${JSON.stringify(output)}).write_text(json.dumps(result, sort_keys=True), encoding="utf-8")`,
  ].join('\n');

  const result = await runSandbox(root, source);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(await fsp.readFile(output, 'utf8'));
  assert.deepEqual(report, {
    memmove: 'PermissionError',
    native_call: 'PermissionError',
    object_from_pointer: 'PermissionError',
    pythonapi: 'PermissionError',
  });
});

test('runtime boundary keeps the supported scientific libraries usable', async (context) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mmw-guard-libraries-'));
  context.after(() => fsp.rm(root, { recursive: true, force: true }));
  const stageRoot = path.join(root, 'work', 'stage');
  const output = path.join(stageRoot, 'libraries.txt');
  const figure = path.join(stageRoot, 'figure.png');
  const workbook = path.join(stageRoot, 'table.xlsx');
  const document = path.join(stageRoot, 'paper.docx');
  const source = [
    'import matplotlib',
    'matplotlib.use("Agg")',
    'import matplotlib.pyplot as plt',
    'import numpy',
    'import pandas',
    'import scipy',
    'import docx',
    'from pathlib import Path',
    'registry = numpy.ctypeslib.ctypes._sys.modules.get("winreg")',
    'assert registry is not None',
    'for action in [',
    '    lambda: registry.OpenKey(registry.HKEY_CURRENT_USER, "Software"),',
    '    lambda: registry.CreateKey(registry.HKEY_CURRENT_USER, "Software\\\\ModelingWorkbenchSandboxTest"),',
    ']:',
    '    try:',
    '        action()',
    '        raise AssertionError("registry boundary bypassed")',
    '    except PermissionError:',
    '        pass',
    'values = numpy.array([1.0, 2.0, 3.0])',
    'assert float(scipy.linalg.norm(values)) > 0',
    'plt.plot(values)',
    `plt.savefig(${JSON.stringify(figure)})`,
    `pandas.DataFrame({"value": values}).to_excel(${JSON.stringify(workbook)}, index=False)`,
    'document = docx.Document()',
    'document.add_heading("Model result", level=1)',
    `document.save(${JSON.stringify(document)})`,
    `Path(${JSON.stringify(output)}).write_text("ok", encoding="utf-8")`,
  ].join('\n');
  const result = await runSandbox(root, source);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(await fsp.readFile(output, 'utf8'), 'ok');
  for (const artifact of [figure, workbook, document]) {
    assert.equal((await fsp.stat(artifact)).size > 100, true, `${artifact} was not created`);
  }
});
