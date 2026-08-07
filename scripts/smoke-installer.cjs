const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const packageInfo = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
const kitRoot = path.join(projectRoot, 'release', `MathModelingWorkbench-${packageInfo.version}-Installer`);
const setupFile = path.join(kitRoot, `MathModelingWorkbench-${packageInfo.version}-Setup.exe`);
const REGISTRY_KEYS = [
  'HKCU\\Software\\MathModelingWorkbench',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\MathModelingWorkbench',
];
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function normalizePath(target) {
  const resolved = path.resolve(target);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isWithinDirectory(candidate, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function captureDirectoryIdentity(directory, label = 'managed directory') {
  const entry = fs.lstatSync(directory, { bigint: true });
  assert.equal(entry.isSymbolicLink(), false, `${label} must not be a symbolic link or junction: ${directory}`);
  assert.equal(entry.isDirectory(), true, `${label} must be a directory: ${directory}`);
  const resolved = fs.realpathSync.native(directory);
  assert.equal(normalizePath(resolved), normalizePath(directory), `${label} contains a reparse-point redirect: ${directory}`);
  const target = fs.statSync(directory, { bigint: true });
  return { realPath: resolved, dev: String(target.dev), ino: String(target.ino) };
}

function assertOwnedSmokeRoot(workspace) {
  const { smokeRoot, tempRoot, projectReleaseRoot, identity } = workspace;
  assert.equal(isWithinDirectory(smokeRoot, tempRoot), true, `smoke root must stay under os.tmpdir(): ${smokeRoot}`);
  assert.equal(isWithinDirectory(smokeRoot, projectReleaseRoot), false, `smoke root must stay outside project release: ${smokeRoot}`);
  const current = captureDirectoryIdentity(smokeRoot, 'smoke root');
  assert.deepEqual(current, identity, `smoke root identity changed before a destructive operation: ${smokeRoot}`);
  assert.equal(isWithinDirectory(current.realPath, tempRoot), true, `resolved smoke root escaped os.tmpdir(): ${current.realPath}`);
}

function createSmokeWorkspace() {
  const requestedTempRoot = path.resolve(os.tmpdir());
  const tempRoot = fs.realpathSync.native(requestedTempRoot);
  const projectReleaseRoot = fs.existsSync(path.join(projectRoot, 'release'))
    ? fs.realpathSync.native(path.join(projectRoot, 'release'))
    : path.resolve(projectRoot, 'release');
  const smokeRoot = fs.mkdtempSync(path.join(tempRoot, 'math-modeling-workbench-installer-smoke-'));
  const installRoot = path.join(smokeRoot, 'install');
  const appRoot = path.join(installRoot, 'app');
  fs.mkdirSync(installRoot);
  const workspace = {
    tempRoot,
    projectReleaseRoot,
    smokeRoot,
    installRoot,
    appRoot,
    executable: path.join(appRoot, `${packageInfo.build.productName}.exe`),
    runtimeExecutable: path.join(appRoot, 'MathModelingWorkbench.runtime.exe'),
    smokeMarker: path.join(installRoot, '.installer-smoke'),
    identity: captureDirectoryIdentity(smokeRoot, 'smoke root'),
    installIdentity: captureDirectoryIdentity(installRoot, 'install root'),
  };
  assertOwnedSmokeRoot(workspace);
  assertManagedInstallRoot(workspace);
  return workspace;
}

function assertManagedInstallRoot(workspace, { allowMissing = false } = {}) {
  assertOwnedSmokeRoot(workspace);
  assert.equal(isWithinDirectory(workspace.installRoot, workspace.smokeRoot), true, 'install root escaped the owned smoke root');
  if (!fs.existsSync(workspace.installRoot)) {
    assert.equal(allowMissing, true, `managed install root is missing: ${workspace.installRoot}`);
    return null;
  }
  const current = captureDirectoryIdentity(workspace.installRoot, 'install root');
  assert.deepEqual(current, workspace.installIdentity, `install root identity changed: ${workspace.installRoot}`);
  assert.equal(isWithinDirectory(current.realPath, workspace.identity.realPath), true, 'resolved install root escaped the owned smoke root');
  return current;
}

function assertManagedAppRoot(workspace, { allowMissing = false } = {}) {
  const install = assertManagedInstallRoot(workspace, { allowMissing });
  if (!install) return null;
  assert.equal(isWithinDirectory(workspace.appRoot, workspace.installRoot), true, 'application root escaped the managed install root');
  if (!fs.existsSync(workspace.appRoot)) {
    assert.equal(allowMissing, true, `managed application root is missing: ${workspace.appRoot}`);
    return null;
  }
  const current = captureDirectoryIdentity(workspace.appRoot, 'application root');
  assert.equal(isWithinDirectory(current.realPath, install.realPath), true, 'resolved application root escaped the managed install root');
  return current;
}

function assertManagedRegularFile(workspace, target, parent) {
  const parentIdentity = parent === workspace.installRoot
    ? assertManagedInstallRoot(workspace)
    : assertManagedAppRoot(workspace);
  assert.equal(isWithinDirectory(target, parent), true, `managed file escaped its parent: ${target}`);
  const entry = fs.lstatSync(target);
  assert.equal(entry.isSymbolicLink(), false, `managed file must not be a symbolic link: ${target}`);
  assert.equal(entry.isFile(), true, `managed path must be a regular file: ${target}`);
  const resolved = fs.realpathSync.native(target);
  assert.equal(isWithinDirectory(resolved, parentIdentity.realPath), true, `resolved managed file escaped its parent: ${target}`);
}

function cleanupOwnedSmokeRoot(workspace) {
  if (!workspace || !fs.existsSync(workspace.smokeRoot)) return;
  assertOwnedSmokeRoot(workspace);
  if (fs.existsSync(workspace.installRoot)) {
    assertManagedInstallRoot(workspace);
    assertManagedAppRoot(workspace, { allowMissing: true });
  }
  fs.rmSync(workspace.smokeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

function isProcessRunning(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function readLock(lockFile) {
  const entry = fs.lstatSync(lockFile);
  assert.equal(entry.isSymbolicLink(), false, `installer smoke lock must not be a link: ${lockFile}`);
  assert.equal(entry.isFile(), true, `installer smoke lock must be a regular file: ${lockFile}`);
  assert.ok(entry.size > 0 && entry.size < 4096, `installer smoke lock has an invalid size: ${lockFile}`);
  const value = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  assert.ok(Number.isSafeInteger(value.pid) && value.pid > 0, `installer smoke lock has an invalid pid: ${lockFile}`);
  assert.match(String(value.nonce || ''), /^[0-9a-f-]{36}$/i, `installer smoke lock has an invalid nonce: ${lockFile}`);
  return value;
}

function acquireSmokeLock(tempRoot) {
  const lockFile = path.join(tempRoot, 'math-modeling-workbench-installer-smoke.lock');
  const lock = { pid: process.pid, nonce: crypto.randomUUID(), createdAt: new Date().toISOString() };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const descriptor = fs.openSync(lockFile, 'wx', 0o600);
      try {
        fs.writeFileSync(descriptor, `${JSON.stringify(lock)}\n`, 'utf8');
      } finally {
        fs.closeSync(descriptor);
      }
      return { ...lock, lockFile };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = readLock(lockFile);
      if (isProcessRunning(existing.pid)) {
        throw new Error(`another installer smoke test is already running (pid ${existing.pid})`);
      }

      const staleFile = `${lockFile}.stale-${process.pid}-${crypto.randomUUID()}`;
      try {
        fs.renameSync(lockFile, staleFile);
      } catch (renameError) {
        if (renameError?.code === 'ENOENT') continue;
        throw renameError;
      }
      const staleEntry = fs.lstatSync(staleFile);
      assert.equal(staleEntry.isSymbolicLink(), false, `stale installer smoke lock must not be a link: ${staleFile}`);
      assert.equal(staleEntry.isFile(), true, `stale installer smoke lock must be a regular file: ${staleFile}`);
      fs.unlinkSync(staleFile);
    }
  }
  throw new Error('could not acquire the installer smoke lock after reclaiming stale entries');
}

function releaseSmokeLock(lock) {
  if (!lock) return;
  const current = readLock(lock.lockFile);
  assert.equal(current.pid, lock.pid, 'installer smoke lock ownership changed');
  assert.equal(current.nonce, lock.nonce, 'installer smoke lock token changed');
  fs.unlinkSync(lock.lockFile);
}

async function withSmokeLock(tempRoot, operation) {
  const lock = acquireSmokeLock(tempRoot);
  let result;
  let operationError = null;
  let releaseError = null;
  try {
    result = await operation(lock);
  } catch (error) {
    operationError = error;
  } finally {
    try {
      releaseSmokeLock(lock);
    } catch (error) {
      releaseError = error;
    }
  }
  if (operationError && releaseError) {
    throw new AggregateError([operationError, releaseError], 'installer smoke operation and lock release both failed');
  }
  if (operationError) throw operationError;
  if (releaseError) throw releaseError;
  return result;
}

function queryRegistryKey(key) {
  const result = spawnSync('reg.exe', ['query', key, '/s'], { windowsHide: true });
  assert.equal(result.error, undefined, `could not snapshot registry key ${key}: ${result.error?.message || ''}`);
  assert.ok(result.status === 0 || result.status === 1, `reg.exe query failed for ${key} with status ${result.status}`);
  return {
    status: result.status,
    stdout: Buffer.from(result.stdout || '').toString('base64'),
    stderr: Buffer.from(result.stderr || '').toString('base64'),
  };
}

function snapshotRegistryKeys() {
  return Object.fromEntries(REGISTRY_KEYS.map((key) => [key, queryRegistryKey(key)]));
}

function runRegistryCommand(args, allowedStatuses, label) {
  const result = spawnSync('reg.exe', args, { windowsHide: true });
  assert.equal(result.error, undefined, `${label}: ${result.error?.message || ''}`);
  assert.ok(allowedStatuses.includes(result.status), `${label} (status ${result.status})`);
  return result;
}

function captureRegistryBaseline(workspace) {
  assertOwnedSmokeRoot(workspace);
  const backupRoot = path.join(workspace.smokeRoot, 'baseline', 'registry');
  fs.mkdirSync(backupRoot, { recursive: true });
  const snapshot = snapshotRegistryKeys();
  const entries = REGISTRY_KEYS.map((key, index) => {
    const backupFile = path.join(backupRoot, `${index}.reg`);
    const exists = snapshot[key].status === 0;
    if (exists) {
      runRegistryCommand(['export', key, backupFile, '/y'], [0], `could not export registry baseline ${key}`);
      assert.equal(fs.existsSync(backupFile), true, `registry baseline export is missing: ${key}`);
    }
    return { key, exists, backupFile };
  });
  return { snapshot, entries };
}

function restoreRegistryBaseline(baseline) {
  for (const entry of baseline.entries) {
    runRegistryCommand(['delete', entry.key, '/f'], [0, 1], `could not clear changed registry key ${entry.key}`);
    if (entry.exists) {
      assert.equal(fs.existsSync(entry.backupFile), true, `registry baseline backup is missing: ${entry.key}`);
      runRegistryCommand(['import', entry.backupFile], [0], `could not restore registry key ${entry.key}`);
    }
  }
  assert.deepEqual(snapshotRegistryKeys(), baseline.snapshot, 'registry baseline restoration was incomplete');
}

function verifyOrRestoreRegistryBaseline(baseline) {
  const current = snapshotRegistryKeys();
  try {
    assert.deepEqual(current, baseline.snapshot, 'installer smoke changed the production HKCU registration');
  } catch (mismatch) {
    try {
      restoreRegistryBaseline(baseline);
    } catch (restoreError) {
      throw new AggregateError([mismatch, restoreError], 'installer smoke changed HKCU registration and restoration failed');
    }
    throw mismatch;
  }
}

function resolveShellFolder(name) {
  const command = `[Environment]::GetFolderPath([Environment+SpecialFolder]::${name})`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.error, undefined, `could not resolve the ${name} shell folder: ${result.error?.message || ''}`);
  assert.equal(result.status, 0, `could not resolve the ${name} shell folder: ${result.stderr || result.stdout || ''}`);
  const folder = String(result.stdout || '').trim();
  assert.ok(path.isAbsolute(folder), `${name} shell folder is not absolute: ${folder}`);
  return folder;
}

function snapshotFile(target) {
  if (!fs.existsSync(target)) return { exists: false };
  const entry = fs.lstatSync(target);
  if (entry.isSymbolicLink()) return { exists: true, type: 'link', target: fs.readlinkSync(target) };
  assert.equal(entry.isFile(), true, `expected shortcut path to be a file: ${target}`);
  const content = fs.readFileSync(target);
  return {
    exists: true,
    type: 'file',
    size: content.length,
    sha256: crypto.createHash('sha256').update(content).digest('hex'),
  };
}

function shortcutTargets() {
  const desktop = resolveShellFolder('DesktopDirectory');
  const programs = resolveShellFolder('Programs');
  const programDirectory = path.join(programs, '数模工坊');
  const targets = [
    path.join(desktop, '数模工坊.lnk'),
    path.join(programDirectory, '数模工坊.lnk'),
    path.join(programDirectory, '卸载数模工坊.lnk'),
  ];
  return { programDirectory, targets };
}

function snapshotShortcuts(targets = shortcutTargets().targets) {
  return Object.fromEntries(targets.map((target) => [target, snapshotFile(target)]));
}

function captureManagedFileBaseline(target, backupFile) {
  const state = snapshotFile(target);
  if (state.exists && state.type === 'file') {
    fs.mkdirSync(path.dirname(backupFile), { recursive: true });
    fs.copyFileSync(target, backupFile);
  }
  return { target, backupFile, state };
}

function removeManagedFile(target) {
  if (!fs.existsSync(target)) return;
  const entry = fs.lstatSync(target);
  assert.equal(entry.isDirectory(), false, `refusing to replace a directory at managed shortcut path: ${target}`);
  fs.unlinkSync(target);
}

function restoreManagedFileBaseline(baseline) {
  removeManagedFile(baseline.target);
  if (!baseline.state.exists) return;
  fs.mkdirSync(path.dirname(baseline.target), { recursive: true });
  if (baseline.state.type === 'link') {
    fs.symlinkSync(baseline.state.target, baseline.target, 'file');
  } else {
    assert.equal(fs.existsSync(baseline.backupFile), true, `managed file backup is missing: ${baseline.target}`);
    const restoreFile = path.join(path.dirname(baseline.target), `.${path.basename(baseline.target)}.smoke-restore-${crypto.randomUUID()}`);
    try {
      fs.copyFileSync(baseline.backupFile, restoreFile);
      fs.renameSync(restoreFile, baseline.target);
    } finally {
      fs.rmSync(restoreFile, { force: true });
    }
  }
  assert.deepEqual(snapshotFile(baseline.target), baseline.state, `managed file restoration was incomplete: ${baseline.target}`);
}

function captureShortcutBaseline(workspace) {
  assertOwnedSmokeRoot(workspace);
  const { programDirectory, targets } = shortcutTargets();
  const backupRoot = path.join(workspace.smokeRoot, 'baseline', 'shortcuts');
  const entries = targets.map((target, index) => captureManagedFileBaseline(target, path.join(backupRoot, `${index}.lnk`)));
  return {
    entries,
    programDirectory,
    programDirectoryExisted: fs.existsSync(programDirectory),
    snapshot: Object.fromEntries(entries.map((entry) => [entry.target, entry.state])),
    targets,
  };
}

function restoreShortcutBaseline(baseline) {
  for (const entry of baseline.entries) restoreManagedFileBaseline(entry);
  if (!baseline.programDirectoryExisted && fs.existsSync(baseline.programDirectory)) {
    fs.rmdirSync(baseline.programDirectory);
  }
  assert.deepEqual(snapshotShortcuts(baseline.targets), baseline.snapshot, 'shortcut baseline restoration was incomplete');
}

function verifyOrRestoreShortcutBaseline(baseline) {
  const current = snapshotShortcuts(baseline.targets);
  try {
    assert.deepEqual(current, baseline.snapshot, 'installer smoke changed production shortcuts');
  } catch (mismatch) {
    try {
      restoreShortcutBaseline(baseline);
    } catch (restoreError) {
      throw new AggregateError([mismatch, restoreError], 'installer smoke changed shortcuts and restoration failed');
    }
    throw mismatch;
  }
}

function install(workspace, args) {
  assertManagedInstallRoot(workspace);
  assertManagedAppRoot(workspace, { allowMissing: true });
  const startedAt = Date.now();
  const result = spawnSync(setupFile, [...args, '/SMOKETEST', `/D=${workspace.installRoot}`], {
    cwd: kitRoot,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10 * 60 * 1000,
  });
  assert.equal(result.error, undefined, `installer process failed: ${result.error?.message || ''}`);
  assert.equal(result.status, 0, `installer exited with ${result.status}: ${result.stderr || result.stdout || ''}`);
  assertManagedInstallRoot(workspace);
  assertManagedAppRoot(workspace);
  assertManagedRegularFile(workspace, workspace.executable, workspace.appRoot);
  assertManagedRegularFile(workspace, workspace.runtimeExecutable, workspace.appRoot);
  assertManagedRegularFile(workspace, workspace.smokeMarker, workspace.installRoot);
  assert.equal(fs.existsSync(workspace.smokeMarker), true, 'installer did not activate isolated smoke mode');
  return Date.now() - startedAt;
}

function readWindowTitle(pid) {
  const result = spawnSync('tasklist.exe', ['/v', '/fo', 'csv', '/nh', '/fi', `PID eq ${pid}`], {
    windowsHide: true,
    encoding: 'latin1',
  });
  const match = String(result.stdout || '').match(/"([^"]*)"\s*$/m);
  const title = match?.[1]?.trim() || '';
  return title === 'N/A' || title === 'OleMainThreadWndName' ? '' : title;
}

function runtimeProcesses(workspace, { includeWindowTitles = false } = {}) {
  const command = [
    'Get-CimInstance Win32_Process -Filter "Name = \'MathModelingWorkbench.runtime.exe\'"',
    'Select-Object ProcessId, ParentProcessId, ExecutablePath',
    'ConvertTo-Json -Compress',
  ].join(' | ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
  });
  assert.equal(result.error, undefined, `could not enumerate installed runtime processes: ${result.error?.message || ''}`);
  assert.equal(result.status, 0, `could not enumerate installed runtime processes: ${result.stderr || result.stdout || ''}`);
  const output = String(result.stdout || '').trim();
  if (!output) return [];
  const parsed = JSON.parse(output);
  const records = Array.isArray(parsed) ? parsed : [parsed];
  return records
    .filter((item) => item?.ExecutablePath && normalizePath(item.ExecutablePath) === normalizePath(workspace.runtimeExecutable))
    .map((item) => {
      const pid = Number(item.ProcessId);
      return {
        pid,
        parentPid: Number(item.ParentProcessId) || 0,
        title: includeWindowTitles ? readWindowTitle(pid) : '',
      };
    })
    .filter((item) => Number.isSafeInteger(item.pid) && item.pid > 0);
}

function runtimeProcessTreeRoots(processes) {
  const valid = (Array.isArray(processes) ? processes : [])
    .filter((item) => Number.isSafeInteger(item?.pid) && item.pid > 0);
  const owned = new Set(valid.map((item) => item.pid));
  const roots = valid.filter((item) => !owned.has(item.parentPid));
  return roots.length > 0 ? roots : valid;
}

function terminate(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  const result = spawnSync('taskkill.exe', ['/pid', String(pid), '/T', '/F'], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 10_000,
  });
  if ((result.error || result.status !== 0) && isProcessRunning(pid)) {
    assert.fail(`could not terminate process tree ${pid}: ${result.error?.message || result.stderr || result.stdout || `exit ${result.status}`}`);
  }
  return result.status === 0;
}

async function terminateOwnedRuntimeProcesses(workspace) {
  const deadline = Date.now() + 10_000;
  let remaining = runtimeProcesses(workspace);
  while (Date.now() < deadline) {
    if (remaining.length === 0) return;
    const roots = runtimeProcessTreeRoots(remaining);
    for (const processInfo of roots) terminate(processInfo.pid);
    await wait(250);
    remaining = runtimeProcesses(workspace);
  }
  assert.deepEqual(remaining, [], `smoke runtime processes remain: ${remaining.map((item) => item.pid).join(', ')}`);
}

async function launchInstalled(workspace, label) {
  assertManagedRegularFile(workspace, workspace.executable, workspace.appRoot);
  assertManagedRegularFile(workspace, workspace.runtimeExecutable, workspace.appRoot);
  assert.equal(fs.existsSync(workspace.executable), true, `${label} executable is missing`);
  assert.ok(fs.statSync(workspace.executable).size < 1024 * 1024, `${label} entry executable is not lightweight`);
  assert.ok(fs.statSync(workspace.runtimeExecutable).size > 100 * 1024 * 1024, `${label} Electron runtime is missing`);
  const baseline = new Set(runtimeProcesses(workspace).map((item) => item.pid));
  const launcher = spawn(workspace.executable, [], {
    cwd: workspace.appRoot,
    windowsHide: true,
    shell: false,
    stdio: 'ignore',
  });
  const startedAt = Date.now();
  let runtime = null;
  try {
    while (Date.now() - startedAt < 20_000) {
      runtime = runtimeProcesses(workspace, { includeWindowTitles: true })
        .find((item) => !baseline.has(item.pid) && item.title);
      if (runtime) break;
      await wait(400);
    }
    assert.ok(runtime, `${label} application did not show a window within 20 seconds`);
    return Date.now() - startedAt;
  } finally {
    if (runtime?.pid) terminate(runtime.pid);
    if (launcher.exitCode === null) terminate(launcher.pid);
    await terminateOwnedRuntimeProcesses(workspace);
  }
}

function assertRuntime(workspace, expected) {
  const runtime = path.join(workspace.appRoot, 'resources', 'runtime');
  const paths = {
    python: path.join(runtime, 'python', 'python.exe'),
    tectonic: path.join(runtime, 'tectonic', 'tectonic.exe'),
  };
  for (const [component, target] of Object.entries(paths)) {
    assert.equal(fs.existsSync(target), expected, `${component} component state is incorrect`);
  }
  return paths;
}

function verifyExecutables(paths) {
  const checks = [
    [paths.python, ['-I', '-c', 'import numpy, scipy; print("python-ok")'], /python-ok/i],
    [paths.tectonic, ['--version'], /tectonic/i],
  ];
  for (const [command, args, expected] of checks) {
    const result = spawnSync(command, args, { cwd: path.dirname(command), encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    assert.equal(result.status, 0, `${path.basename(command)} failed: ${result.stderr || result.stdout}`);
    assert.match(`${result.stdout || ''}${result.stderr || ''}`, expected);
  }
}

function listResidualEntries(directory, prefix = '') {
  if (!fs.existsSync(directory)) return [];
  const residuals = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    residuals.push(relative);
    if (entry.isDirectory() && !entry.isSymbolicLink() && residuals.length < 50) {
      residuals.push(...listResidualEntries(path.join(directory, entry.name), relative));
    }
    if (residuals.length >= 50) break;
  }
  return residuals.slice(0, 50);
}

async function runSmoke(workspace) {
  const coreInstallMs = install(workspace, ['/S', '/COREONLY', '/NOSHORTCUTS']);
  assertRuntime(workspace, false);
  const coreWindowMs = await launchInstalled(workspace, 'core');

  const fullInstallMs = install(workspace, ['/S', '/NOSHORTCUTS']);
  const paths = assertRuntime(workspace, true);
  verifyExecutables(paths);
  const fullWindowMs = await launchInstalled(workspace, 'full');

  const reconfigureMs = install(workspace, ['/S', '/COREONLY', '/NOSHORTCUTS']);
  assertRuntime(workspace, false);
  const reconfiguredWindowMs = await launchInstalled(workspace, 'reconfigured');

  const uninstaller = path.join(workspace.installRoot, 'Uninstall.exe');
  assert.equal(fs.existsSync(uninstaller), true, 'uninstaller is missing');
  assertManagedRegularFile(workspace, uninstaller, workspace.installRoot);
  assertManagedRegularFile(workspace, workspace.smokeMarker, workspace.installRoot);
  assert.equal(fs.existsSync(workspace.smokeMarker), true, 'installer smoke marker is missing before uninstall isolation check');
  fs.unlinkSync(workspace.smokeMarker);
  assert.equal(fs.existsSync(workspace.smokeMarker), false, 'installer smoke marker could not be removed for parameter-only isolation check');
  assertManagedInstallRoot(workspace);
  assertManagedAppRoot(workspace);
  assertManagedRegularFile(workspace, uninstaller, workspace.installRoot);
  const uninstallResult = spawnSync(uninstaller, ['/S', '/SMOKETEST'], { windowsHide: true, timeout: 120_000 });
  assert.equal(uninstallResult.error, undefined, `uninstaller process failed: ${uninstallResult.error?.message || ''}`);
  assert.equal(uninstallResult.status, 0, `uninstaller exited with ${uninstallResult.status}`);
  const uninstallDeadline = Date.now() + 30_000;
  while (fs.existsSync(workspace.installRoot) && Date.now() < uninstallDeadline) await wait(250);
  const residuals = listResidualEntries(workspace.installRoot);
  assert.equal(fs.existsSync(workspace.smokeMarker), false, 'installer smoke marker remains after uninstall');
  assert.equal(fs.existsSync(workspace.installRoot), false, `installed files remain after uninstall: ${residuals.join(', ')}`);

  return { coreInstallMs, coreWindowMs, fullInstallMs, fullWindowMs, reconfigureMs, reconfiguredWindowMs };
}

async function bestEffortUninstall(workspace) {
  if (!workspace || !fs.existsSync(workspace.installRoot)) return;
  assertManagedInstallRoot(workspace);
  assertManagedAppRoot(workspace, { allowMissing: true });
  if (fs.existsSync(workspace.runtimeExecutable)) {
    assertManagedRegularFile(workspace, workspace.runtimeExecutable, workspace.appRoot);
    await terminateOwnedRuntimeProcesses(workspace);
  }
  const uninstaller = path.join(workspace.installRoot, 'Uninstall.exe');
  if (fs.existsSync(uninstaller)) {
    assertManagedRegularFile(workspace, uninstaller, workspace.installRoot);
    const result = spawnSync(uninstaller, ['/S', '/SMOKETEST'], { windowsHide: true, timeout: 120_000 });
    assert.equal(result.error, undefined, `fallback uninstaller process failed: ${result.error?.message || ''}`);
    assert.equal(result.status, 0, `fallback uninstaller exited with ${result.status}`);
  }
}

async function main() {
  assert.equal(process.platform, 'win32', 'installer smoke test requires Windows');
  assert.equal(fs.existsSync(setupFile), true, 'installer entry executable is missing');
  const tempRoot = fs.realpathSync.native(path.resolve(os.tmpdir()));
  await withSmokeLock(tempRoot, async () => {
    let workspace;
    let registryBaseline;
    let shortcutBaseline;
    let timings;
    let runError = null;
    const cleanupErrors = [];

    try {
      workspace = createSmokeWorkspace();
      registryBaseline = captureRegistryBaseline(workspace);
      shortcutBaseline = captureShortcutBaseline(workspace);
      timings = await runSmoke(workspace);
    } catch (error) {
      runError = error;
    } finally {
      try {
        await bestEffortUninstall(workspace);
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        if (registryBaseline) verifyOrRestoreRegistryBaseline(registryBaseline);
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        if (shortcutBaseline) verifyOrRestoreShortcutBaseline(shortcutBaseline);
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        cleanupOwnedSmokeRoot(workspace);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    const failures = [runError, ...cleanupErrors].filter(Boolean);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'installer smoke test and cleanup checks failed');

    process.stdout.write([
      'Modular installer smoke test passed:',
      `core install=${timings.coreInstallMs} ms/window=${timings.coreWindowMs} ms`,
      `full install=${timings.fullInstallMs} ms/window=${timings.fullWindowMs} ms`,
      `reconfigure=${timings.reconfigureMs} ms/window=${timings.reconfiguredWindowMs} ms`,
    ].join(' ') + '\n');
  });
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  acquireSmokeLock,
  assertManagedAppRoot,
  assertManagedInstallRoot,
  assertOwnedSmokeRoot,
  captureDirectoryIdentity,
  captureManagedFileBaseline,
  cleanupOwnedSmokeRoot,
  createSmokeWorkspace,
  isWithinDirectory,
  releaseSmokeLock,
  restoreManagedFileBaseline,
  runtimeProcessTreeRoots,
  withSmokeLock,
};
