const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const packageInfo = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
const unpackedRoot = path.resolve(process.argv[2] || path.join(projectRoot, 'release', 'win-unpacked'));
const executable = path.join(unpackedRoot, `${packageInfo.build.productName}.exe`);
const smokeRoot = path.join(projectRoot, 'release', 'smoke');
const userData = path.join(process.env.APPDATA || '', packageInfo.name);
const stdoutFile = path.join(smokeRoot, 'stdout.log');
const stderrFile = path.join(smokeRoot, 'stderr.log');
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const STARTUP_TIMEOUT_MS = 20_000;

function readWindowTitle(pid) {
  if (process.platform !== 'win32') return '';
  const result = spawnSync('tasklist.exe', [
    '/v',
    '/fo',
    'csv',
    '/nh',
    '/fi',
    `PID eq ${pid}`,
  ], {
    windowsHide: true,
    encoding: 'latin1',
  });
  const match = String(result.stdout || '').match(/"([^"]*)"\s*$/m);
  const title = match?.[1]?.trim() || '';
  return title === 'N/A' || title === 'OleMainThreadWndName' ? '' : title;
}

function countFiles(root) {
  if (!fs.existsSync(root)) return 0;
  let count = 0;
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(target);
      if (entry.isFile()) count += 1;
    }
  }
  return count;
}

function terminate(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch {}
  }
}

async function main() {
  assert.equal(fs.existsSync(executable), true, `packaged executable is missing: ${executable}`);
  assert.equal(path.isAbsolute(userData), true, 'Windows APPDATA is unavailable');
  fs.rmSync(smokeRoot, { recursive: true, force: true });
  fs.mkdirSync(smokeRoot, { recursive: true });
  const stdout = fs.openSync(stdoutFile, 'w');
  const stderr = fs.openSync(stderrFile, 'w');
  const child = spawn(executable, ['--enable-logging=stderr'], {
    cwd: unpackedRoot,
    detached: false,
    windowsHide: true,
    shell: false,
    stdio: ['ignore', stdout, stderr],
  });
  fs.closeSync(stdout);
  fs.closeSync(stderr);

  try {
    let exited = false;
    child.once('exit', () => { exited = true; });
    const startedAt = Date.now();
    let windowTitle = '';
    while (!exited && Date.now() - startedAt < STARTUP_TIMEOUT_MS) {
      windowTitle = readWindowTitle(child.pid);
      if (windowTitle) break;
      await wait(500);
    }
    const stderrText = fs.readFileSync(stderrFile, 'utf8');
    assert.equal(exited, false, `packaged application exited during smoke test: ${stderrText}`);
    const startupMs = Date.now() - startedAt;
    assert.ok(windowTitle, `packaged application did not show a window within ${STARTUP_TIMEOUT_MS} ms`);
    const bundledTectonic = path.join(unpackedRoot, 'resources', 'runtime', 'tectonic', 'tectonic.exe');
    const cache = path.join(userData, 'runtime', 'cache', 'tectonic');
    let cacheFiles = 0;
    if (fs.existsSync(bundledTectonic)) {
      const marker = fs.existsSync(cache)
        ? fs.readdirSync(cache).find((name) => /^\.bundled-cache-[A-Za-z0-9._-]+\.json$/.test(name))
        : null;
      cacheFiles = countFiles(cache);
      assert.ok(marker, 'Tectonic cache seed marker is missing');
      assert.ok(cacheFiles >= 300, `Tectonic cache seed is incomplete: ${cacheFiles} files`);
    }
    assert.doesNotMatch(stderrText, /uncaught|unhandled|fatal|integrity check failed|could not be loaded|runtime asset is missing/i);
    const tectonicStatus = fs.existsSync(bundledTectonic) ? `${cacheFiles} cache files` : 'not installed';
    process.stdout.write(`Packaged application smoke test passed: pid=${child.pid}, window=${startupMs} ms, tectonic=${tectonicStatus}\n`);
  } finally {
    terminate(child.pid);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
