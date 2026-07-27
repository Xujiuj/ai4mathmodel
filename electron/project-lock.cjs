const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

function lockFile(root) {
  return path.join(root, 'work', '.desktop-supervisor', 'run.lock');
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireLock(root) {
  const file = lockFile(root);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const lock = { pid: process.pid, startedAt: Date.now(), hostname: os.hostname() };
  try {
    await fsp.writeFile(file, JSON.stringify(lock, null, 2), { flag: 'wx', mode: 0o600 });
    return { acquired: true, lock };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let existing = null;
    try {
      existing = JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch {
      await fsp.writeFile(file, JSON.stringify(lock, null, 2), { mode: 0o600 });
      return { acquired: true, lock, stale: true };
    }
    if (!existing?.pid || !isPidAlive(existing.pid)) {
      await fsp.writeFile(file, JSON.stringify(lock, null, 2), { mode: 0o600 });
      return { acquired: true, lock, stale: existing };
    }
    return { acquired: false, existing };
  }
}

async function releaseLock(root) {
  await fsp.rm(lockFile(root), { force: true }).catch(() => {});
}

module.exports = { acquireLock, releaseLock, lockFile, isPidAlive };
