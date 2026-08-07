const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  acquireSmokeLock,
  assertManagedAppRoot,
  assertManagedInstallRoot,
  assertOwnedSmokeRoot,
  captureManagedFileBaseline,
  cleanupOwnedSmokeRoot,
  createSmokeWorkspace,
  releaseSmokeLock,
  restoreManagedFileBaseline,
  runtimeProcessTreeRoots,
  withSmokeLock,
} = require('../scripts/smoke-installer.cjs');

const projectRoot = path.resolve(__dirname, '..');

test('installer keeps application and runtime payloads outside the entry executable', () => {
  const source = fs.readFileSync(path.join(projectRoot, 'installer', 'installer.nsi'), 'utf8');
  assert.match(source, /\$EXEDIR\\packages\\\$\{CORE_FILE\}/);
  assert.match(source, /certutil\.exe.*SHA256/);
  assert.match(source, /SectionGroup "可选运行组件"/);
  assert.match(source, /SectionSetFlags \$\{SEC_PYTHON\} 0/);
  assert.match(source, /app\.new/);
  assert.match(source, /app\.backup/);
  assert.match(source, /Rename "\$INSTDIR\\app\.backup" "\$INSTDIR\\app"/);
  assert.match(source, /core_backup_retry:[\s\S]*?IntCmp \$3 40 core_switch_failed core_backup_sleep core_switch_failed/);
  assert.match(source, /core_activate_retry:[\s\S]*?IntCmp \$3 40 core_activate_failed core_activate_sleep core_activate_failed/);
  assert.match(source, /stage=core-switch/);
  assert.doesNotMatch(source, /SEC_CODEX|CODEX_FILE/);
  assert.doesNotMatch(source, /File \/r .*win-unpacked|File .*CORE_FILE/);
});

test('installer retries backup restoration and preserves the last known-good payload on exhaustion', () => {
  const source = fs.readFileSync(path.join(projectRoot, 'installer', 'installer.nsi'), 'utf8');
  const restoreStart = source.indexOf('  core_restore_backup:');
  const restoreEnd = source.indexOf('  core_switch_failed:', restoreStart);
  assert.ok(restoreStart >= 0 && restoreEnd > restoreStart, 'restore control-flow block must exist');
  const restore = source.slice(restoreStart, restoreEnd);
  const extractStart = source.indexOf('  core_extract_ok:');
  assert.ok(extractStart >= 0 && extractStart < restoreStart, 'extract transition must precede restore control flow');
  const extract = source.slice(extractStart, restoreStart);
  const prepareSwitch = extract.indexOf('  core_prepare_switch:');
  assert.ok(prepareSwitch >= 0, 'switch preparation guard must exist');
  const backupGuard = extract.slice(0, prepareSwitch);

  assert.match(backupGuard, /IfFileExists "\$INSTDIR\\app\.backup\\\*" core_backup_leftover core_prepare_switch/);
  assert.match(backupGuard, /core_backup_leftover:[\s\S]*?IfFileExists "\$INSTDIR\\app\\\*" core_backup_conflict core_restore_existing_backup/);
  assert.match(backupGuard, /core_backup_conflict:[\s\S]*?reason=app-and-backup-exist/);
  assert.doesNotMatch(backupGuard, /RMDir \/r "\$INSTDIR\\app\.backup"/);
  assert.match(restore, /StrCpy \$3 0/);
  assert.match(restore, /core_restore_retry:[\s\S]*?Rename "\$INSTDIR\\app\.backup" "\$INSTDIR\\app"/);
  assert.match(restore, /IfErrors core_restore_wait core_restore_complete/);
  assert.match(restore, /IntCmp \$3 40 core_restore_failed core_restore_sleep core_restore_failed/);
  assert.match(restore, /core_restore_sleep:[\s\S]*?Sleep 250[\s\S]*?Goto core_restore_retry/);
  assert.match(restore, /stage=core-restore/);
  assert.match(restore, /retries=40/);
  assert.match(restore, /attempts=\$3/);
  assert.match(restore, /FileOpen \$2[\s\S]*?FileWrite \$2[\s\S]*?FileClose \$2/);
  assert.doesNotMatch(restore, /FileOpen \$3/);
  assert.match(restore, /StrCmp \$4 "2" core_restore_existing_complete core_switch_failed/);
  assert.match(restore, /core_restore_existing_complete:[\s\S]*?reason=interrupted-restore-recovered/);
  assert.match(restore, /已恢复原版本；本次安装已停止/);
  assert.doesNotMatch(restore, /RMDir \/r "\$INSTDIR\\app\.backup"/);

  const exhausted = simulateRestoreAttempts(40, () => false);
  assert.equal(exhausted.restored, false);
  assert.equal(exhausted.attempts, 40, 'the restore loop is bounded at 40 attempts');
  assert.equal(exhausted.backupPreserved, true);

  const transientlyLocked = simulateRestoreAttempts(40, (attempt) => attempt === 3);
  assert.deepEqual(transientlyLocked, { restored: true, attempts: 3, backupPreserved: false });

  assert.deepEqual(simulateLeftoverBackupState({ app: false, backup: true, renameSucceeds: () => true }), {
    action: 'restore-and-stop',
    backupPreserved: false,
  });
  assert.deepEqual(simulateLeftoverBackupState({ app: true, backup: true, renameSucceeds: () => true }), {
    action: 'stop-with-both-payloads',
    backupPreserved: true,
  });
});

function simulateRestoreAttempts(maxRetries, renameSucceeds) {
  let retryCount = 0;
  let attempts = 0;
  while (true) {
    attempts += 1;
    if (renameSucceeds(attempts)) {
      return { restored: true, attempts, backupPreserved: false };
    }
    retryCount += 1;
    if (retryCount >= maxRetries) {
      return { restored: false, attempts, backupPreserved: true };
    }
  }
}

function simulateLeftoverBackupState({ app, backup, renameSucceeds }) {
  if (!backup) return { action: 'continue-upgrade', backupPreserved: false };
  if (app) return { action: 'stop-with-both-payloads', backupPreserved: true };
  const restored = renameSucceeds();
  return restored
    ? { action: 'restore-and-stop', backupPreserved: false }
    : { action: 'stop-with-backup', backupPreserved: true };
}

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
  assert.match(source, /signWindowsArtifact\(launcherExecutable\)/);
  assert.match(source, /signWindowsArtifact\(setupFile\)/);
  assert.match(source, /signtool/i);
});

test('installer smoke harness uses an isolated temporary root and always cleans it up', () => {
  const source = fs.readFileSync(path.join(projectRoot, 'scripts', 'smoke-installer.cjs'), 'utf8');
  assert.match(source, /require\('node:os'\)/);
  assert.match(source, /os\.tmpdir\(\)/);
  assert.match(source, /fs\.mkdtempSync\(path\.join\(tempRoot, 'math-modeling-workbench-installer-smoke-'/);
  assert.match(source, /fs\.realpathSync\.native/);
  assert.match(source, /fs\.lstatSync/);
  assert.match(source, /assertOwnedSmokeRoot/);
  assert.match(source, /projectReleaseRoot/);
  assert.match(source, /finally\s*\{/);
  assert.match(source, /cleanupOwnedSmokeRoot/);
  assert.doesNotMatch(source, /path\.join\(projectRoot, 'release', 'installer-smoke'\)/);
});

test('installer smoke mode avoids shared registry, shortcut, and process side effects', () => {
  const installer = fs.readFileSync(path.join(projectRoot, 'installer', 'installer.nsi'), 'utf8');
  const smoke = fs.readFileSync(path.join(projectRoot, 'scripts', 'smoke-installer.cjs'), 'utf8');

  assert.match(installer, /Var SmokeTestMode/);
  assert.match(installer, /Var UninstallSmokeTestMode/);
  assert.match(installer, /\$\{GetOptions\} \$R0 "\/SMOKETEST"/);
  assert.match(installer, /Function un\.onInit/);
  assert.match(installer, /\$\{un\.GetParameters\} \$R0/);
  assert.match(installer, /\$\{un\.GetOptions\} \$R0 "\/SMOKETEST"/);
  assert.match(installer, /\.installer-smoke/);
  assert.match(installer, /StrCmp \$SmokeTestMode "1" core_processes_ready/);
  assert.match(installer, /StrCmp \$UninstallSmokeTestMode "1" smoke_uninstall_files/);
  assert.match(installer, /IfFileExists "\$INSTDIR\\\.installer-smoke" smoke_uninstall_files/);
  assert.match(installer, /SectionSetFlags \$\{SEC_SHORTCUTS\} 0/);
  assert.match(smoke, /'\/SMOKETEST'/);
  assert.match(smoke, /REGISTRY_KEYS/);
  assert.match(smoke, /snapshotRegistryKeys/);
  assert.match(smoke, /verifyOrRestoreRegistryBaseline/);
  assert.match(smoke, /verifyOrRestoreShortcutBaseline/);

  const smokeRegistration = installer.indexOf('smoke_registration:');
  const markerWrite = installer.indexOf('FileOpen $0 "$INSTDIR\\.installer-smoke" w', smokeRegistration);
  const smokeUninstallerWrite = installer.indexOf('WriteUninstaller "$INSTDIR\\Uninstall.exe"', markerWrite);
  assert.ok(smokeRegistration >= 0 && markerWrite > smokeRegistration);
  assert.ok(smokeUninstallerWrite > markerWrite, 'smoke marker must exist before the uninstaller is exposed');

  const explicitSmokeUninstalls = smoke.match(/spawnSync\(uninstaller, \['\/S', '\/SMOKETEST'\]/g) || [];
  assert.equal(explicitSmokeUninstalls.length, 2, 'normal and fallback smoke uninstalls must pass /SMOKETEST');
  assert.match(smoke, /fs\.unlinkSync\(workspace\.smokeMarker\)/);
});

test('installer smoke harness serializes runs and verifies uninstall before fallback cleanup', () => {
  const source = fs.readFileSync(path.join(projectRoot, 'scripts', 'smoke-installer.cjs'), 'utf8');

  assert.match(source, /acquireSmokeLock/);
  assert.match(source, /['"]wx['"]/);
  assert.match(source, /releaseSmokeLock/);
  assert.match(source, /while \(fs\.existsSync\(workspace\.installRoot\)/);
  assert.match(source, /assert\.equal\(fs\.existsSync\(workspace\.installRoot\), false/);
  assert.match(source, /assert\.equal\(fs\.existsSync\(workspace\.smokeMarker\), false/);

  const uninstallAssertion = source.indexOf('assert.equal(fs.existsSync(workspace.installRoot), false');
  const fallbackCleanup = source.lastIndexOf('cleanupOwnedSmokeRoot(workspace)');
  assert.notEqual(uninstallAssertion, -1);
  assert.notEqual(fallbackCleanup, -1);
  assert.ok(uninstallAssertion < fallbackCleanup, 'uninstall residue must be asserted before fallback cleanup');
});

test('installer smoke workspace rejects replacement by a junction before cleanup', () => {
  const workspace = createSmokeWorkspace();
  const junctionTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'math-modeling-workbench-junction-target-'));
  try {
    fs.rmdirSync(workspace.installRoot);
    fs.rmdirSync(workspace.smokeRoot);
    fs.symlinkSync(junctionTarget, workspace.smokeRoot, 'junction');
    assert.throws(() => assertOwnedSmokeRoot(workspace), /symbolic link|junction|reparse-point|identity changed/);
  } finally {
    if (fs.existsSync(workspace.smokeRoot)) fs.rmdirSync(workspace.smokeRoot);
    fs.rmSync(junctionTarget, { recursive: true, force: true });
  }
});

test('installer smoke workspace rejects replaced install and app child directories', () => {
  const installWorkspace = createSmokeWorkspace();
  const installTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'math-modeling-workbench-install-junction-target-'));
  try {
    fs.rmdirSync(installWorkspace.installRoot);
    fs.symlinkSync(installTarget, installWorkspace.installRoot, 'junction');
    assert.throws(() => assertManagedInstallRoot(installWorkspace), /symbolic link|junction|reparse-point|identity changed/);
    assert.throws(() => cleanupOwnedSmokeRoot(installWorkspace), /symbolic link|junction|reparse-point|identity changed/);
  } finally {
    if (fs.existsSync(installWorkspace.installRoot)) fs.rmdirSync(installWorkspace.installRoot);
    if (fs.existsSync(installWorkspace.smokeRoot)) fs.rmdirSync(installWorkspace.smokeRoot);
    fs.rmSync(installTarget, { recursive: true, force: true });
  }

  const appWorkspace = createSmokeWorkspace();
  const appTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'math-modeling-workbench-app-junction-target-'));
  try {
    fs.symlinkSync(appTarget, appWorkspace.appRoot, 'junction');
    assert.throws(() => assertManagedAppRoot(appWorkspace), /symbolic link|junction|reparse-point|escaped/);
    assert.throws(() => cleanupOwnedSmokeRoot(appWorkspace), /symbolic link|junction|reparse-point|escaped/);
  } finally {
    if (fs.existsSync(appWorkspace.appRoot)) fs.rmdirSync(appWorkspace.appRoot);
    cleanupOwnedSmokeRoot(appWorkspace);
    fs.rmSync(appTarget, { recursive: true, force: true });
  }
});

test('installer smoke lock fails closed while another run owns it', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'math-modeling-workbench-lock-test-'));
  let lock;
  try {
    lock = acquireSmokeLock(tempRoot);
    assert.throws(() => acquireSmokeLock(tempRoot), /already running/);
    releaseSmokeLock(lock);
    lock = null;
  } finally {
    if (lock && fs.existsSync(lock.lockFile)) releaseSmokeLock(lock);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('installer smoke lock is released when initial snapshot setup fails', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'math-modeling-workbench-lock-failure-test-'));
  let reacquired;
  try {
    assert.equal(typeof withSmokeLock, 'function');
    await assert.rejects(
      () => withSmokeLock(tempRoot, async () => { throw new Error('snapshot setup failed'); }),
      /snapshot setup failed/,
    );
    reacquired = acquireSmokeLock(tempRoot);
    releaseSmokeLock(reacquired);
    reacquired = null;
  } finally {
    if (reacquired && fs.existsSync(reacquired.lockFile)) releaseSmokeLock(reacquired);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('installer smoke workspace cleanup succeeds only for the original owned directory', () => {
  const workspace = createSmokeWorkspace();
  cleanupOwnedSmokeRoot(workspace);
  assert.equal(fs.existsSync(workspace.smokeRoot), false);
});

test('installer smoke restores managed files to their exact baseline', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'math-modeling-workbench-baseline-test-'));
  try {
    assert.equal(typeof captureManagedFileBaseline, 'function');
    assert.equal(typeof restoreManagedFileBaseline, 'function');

    const existing = path.join(tempRoot, 'existing.lnk');
    const existingBackup = path.join(tempRoot, 'existing.backup');
    fs.writeFileSync(existing, 'before');
    const existingBaseline = captureManagedFileBaseline(existing, existingBackup);
    fs.writeFileSync(existing, 'after');
    restoreManagedFileBaseline(existingBaseline);
    assert.equal(fs.readFileSync(existing, 'utf8'), 'before');

    const absent = path.join(tempRoot, 'absent.lnk');
    const absentBaseline = captureManagedFileBaseline(absent, path.join(tempRoot, 'absent.backup'));
    fs.writeFileSync(absent, 'created-by-smoke');
    restoreManagedFileBaseline(absentBaseline);
    assert.equal(fs.existsSync(absent), false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('installer smoke restores shared state on mismatch and drains late runtime processes', () => {
  const source = fs.readFileSync(path.join(projectRoot, 'scripts', 'smoke-installer.cjs'), 'utf8');
  assert.match(source, /captureRegistryBaseline/);
  assert.match(source, /restoreRegistryBaseline/);
  assert.match(source, /captureShortcutBaseline/);
  assert.match(source, /restoreShortcutBaseline/);
  assert.match(source, /reg\.exe.*export/s);
  assert.match(source, /reg\.exe.*import/s);

  const launchFinally = source.indexOf('} finally {', source.indexOf('async function launchInstalled'));
  const knownRuntimeTermination = source.indexOf('terminate(runtime.pid)', launchFinally);
  const launcherTermination = source.indexOf('terminate(launcher.pid)', launchFinally);
  const runtimeTermination = source.indexOf('await terminateOwnedRuntimeProcesses(workspace)', launchFinally);
  assert.ok(launchFinally >= 0 && knownRuntimeTermination > launchFinally);
  assert.ok(launcherTermination > knownRuntimeTermination, 'the identified runtime tree must stop before the launcher cleanup');
  assert.ok(runtimeTermination > launcherTermination, 'launcher must stop before runtime descendants are drained');
  assert.match(source, /Select-Object ProcessId, ParentProcessId, ExecutablePath/);
  assert.match(source, /includeWindowTitles \? readWindowTitle\(pid\) : ''/);

  const cleanupStart = source.indexOf('async function terminateOwnedRuntimeProcesses');
  const cleanupEnd = source.indexOf('async function launchInstalled', cleanupStart);
  const cleanupSource = source.slice(cleanupStart, cleanupEnd);
  assert.doesNotMatch(cleanupSource, /includeWindowTitles|readWindowTitle/);
  assert.match(cleanupSource, /runtimeProcessTreeRoots\(remaining\)/);
  assert.match(cleanupSource, /for \(const processInfo of roots\) terminate\(processInfo\.pid\)/);
  assert.match(source, /result\.status !== 0\) && isProcessRunning\(pid\)/);
});

test('installer smoke terminates runtime tree roots before their Electron children', () => {
  assert.equal(typeof runtimeProcessTreeRoots, 'function');
  const roots = runtimeProcessTreeRoots([
    { pid: 100, parentPid: 900 },
    { pid: 101, parentPid: 100 },
    { pid: 102, parentPid: 101 },
    { pid: 200, parentPid: 800 },
    { pid: 201, parentPid: 200 },
  ]);
  assert.deepEqual(roots.map((item) => item.pid), [100, 200]);
});
