const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const packageInfo = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
const kitRoot = path.join(projectRoot, 'release', `MathModelingWorkbench-${packageInfo.version}-Installer`);
const setupFile = path.join(kitRoot, `MathModelingWorkbench-${packageInfo.version}-Setup.exe`);
const smokeRoot = path.join(projectRoot, 'release', 'installer-smoke');
const installRoot = path.join(smokeRoot, 'install');
const appRoot = path.join(installRoot, 'app');
const executable = path.join(appRoot, `${packageInfo.build.productName}.exe`);
const runtimeExecutable = path.join(appRoot, 'MathModelingWorkbench.runtime.exe');
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function install(args) {
  const startedAt = Date.now();
  const result = spawnSync(setupFile, [...args, `/D=${installRoot}`], {
    cwd: kitRoot,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10 * 60 * 1000,
  });
  assert.equal(result.error, undefined, `installer process failed: ${result.error?.message || ''}`);
  assert.equal(result.status, 0, `installer exited with ${result.status}: ${result.stderr || result.stdout || ''}`);
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

function runtimeProcesses() {
  const result = spawnSync('tasklist.exe', ['/v', '/fo', 'csv', '/nh', '/fi', 'IMAGENAME eq MathModelingWorkbench.runtime.exe'], {
    windowsHide: true,
    encoding: 'latin1',
  });
  return String(result.stdout || '').split(/\r?\n/).map((line) => {
    const fields = [...line.matchAll(/"([^"]*)"(?:,|$)/g)].map((match) => match[1]);
    if (fields.length < 2 || !/^\d+$/.test(fields[1])) return null;
    return { pid: Number(fields[1]), title: fields.at(-1) || '' };
  }).filter(Boolean);
}

function terminate(pid) {
  if (!pid) return;
  spawnSync('taskkill.exe', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
}

async function launchInstalled(label) {
  assert.equal(fs.existsSync(executable), true, `${label} executable is missing`);
  assert.ok(fs.statSync(executable).size < 1024 * 1024, `${label} entry executable is not lightweight`);
  assert.ok(fs.statSync(runtimeExecutable).size > 100 * 1024 * 1024, `${label} Electron runtime is missing`);
  const baseline = new Set(runtimeProcesses().map((item) => item.pid));
  const launcher = spawn(executable, [], {
    cwd: appRoot,
    windowsHide: true,
    shell: false,
    stdio: 'ignore',
  });
  const startedAt = Date.now();
  let runtime = null;
  try {
    while (Date.now() - startedAt < 20_000) {
      runtime = runtimeProcesses().find((item) => !baseline.has(item.pid) && item.title && !['N/A', 'OleMainThreadWndName'].includes(item.title));
      if (runtime) break;
      await wait(400);
    }
    assert.ok(runtime, `${label} application did not show a window within 20 seconds`);
    return Date.now() - startedAt;
  } finally {
    if (runtime?.pid) terminate(runtime.pid);
    terminate(launcher.pid);
  }
}

function assertRuntime(expected) {
  const runtime = path.join(appRoot, 'resources', 'runtime');
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

async function main() {
  assert.equal(process.platform, 'win32', 'installer smoke test requires Windows');
  assert.equal(fs.existsSync(setupFile), true, 'installer entry executable is missing');
  fs.rmSync(smokeRoot, { recursive: true, force: true });
  fs.mkdirSync(smokeRoot, { recursive: true });

  const coreInstallMs = install(['/S', '/COREONLY', '/NOSHORTCUTS']);
  assertRuntime(false);
  const coreWindowMs = await launchInstalled('core');

  const fullInstallMs = install(['/S', '/NOSHORTCUTS']);
  const paths = assertRuntime(true);
  verifyExecutables(paths);
  const fullWindowMs = await launchInstalled('full');

  const reconfigureMs = install(['/S', '/COREONLY', '/NOSHORTCUTS']);
  assertRuntime(false);
  const reconfiguredWindowMs = await launchInstalled('reconfigured');

  const uninstaller = path.join(installRoot, 'Uninstall.exe');
  assert.equal(fs.existsSync(uninstaller), true, 'uninstaller is missing');
  const uninstallResult = spawnSync(uninstaller, ['/S'], { windowsHide: true, timeout: 120_000 });
  assert.equal(uninstallResult.status, 0, `uninstaller exited with ${uninstallResult.status}`);
  const uninstallDeadline = Date.now() + 15_000;
  while (fs.existsSync(appRoot) && Date.now() < uninstallDeadline) await wait(250);
  assert.equal(fs.existsSync(appRoot), false, 'installed application remains after uninstall');

  process.stdout.write([
    'Modular installer smoke test passed:',
    `core install=${coreInstallMs} ms/window=${coreWindowMs} ms`,
    `full install=${fullInstallMs} ms/window=${fullWindowMs} ms`,
    `reconfigure=${reconfigureMs} ms/window=${reconfiguredWindowMs} ms`,
  ].join(' ') + '\n');
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
