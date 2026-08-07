const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const STAGE_DIR_MAP = Object.freeze({
  analysis: '01_analysis',
  solving: '02_solving',
  paper: '03_paper',
  review: '04_review',
});

const TRANSIENT_RENAME_CODES = new Set(['EBUSY', 'EPERM']);
const RENAME_RETRY_DELAYS_MS = Object.freeze([40, 120, 240, 480, 800]);

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function renameWithRetry(source, destination, {
  rename = fsp.rename,
  sleep = wait,
  delays = RENAME_RETRY_DELAYS_MS,
} = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      const delay = delays[attempt];
      if (!TRANSIENT_RENAME_CODES.has(error?.code) || delay == null) throw error;
      await sleep(delay);
    }
  }
}

async function copyWithRetry(source, destination, {
  copy = fsp.cp,
  sleep = wait,
  delays = RENAME_RETRY_DELAYS_MS,
} = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await copy(source, destination, { recursive: true, force: true });
      return;
    } catch (error) {
      const delay = delays[attempt];
      if (!TRANSIENT_RENAME_CODES.has(error?.code) || delay == null) throw error;
      await sleep(delay);
    }
  }
}

function stagingPath(root, runId, stage) {
  if (!STAGE_DIR_MAP[stage]) throw new Error(`Unknown stage: ${stage}`);
  return path.join(root, 'work', '.staging', runId, STAGE_DIR_MAP[stage]);
}

function committedPath(root, stage) {
  if (!STAGE_DIR_MAP[stage]) throw new Error(`Unknown stage: ${stage}`);
  return path.join(root, 'work', STAGE_DIR_MAP[stage]);
}

function trashPath(root, timestamp, stage) {
  return path.join(root, 'work', '.trash', String(timestamp), STAGE_DIR_MAP[stage]);
}

function commitMarkerPath(root, stage) {
  return path.join(root, 'work', '.desktop-supervisor', 'commits', `${stage}.json`);
}

function projectView(root, resolvePath) {
  return {
    root,
    resolvePath: typeof resolvePath === 'function'
      ? resolvePath
      : (relative) => path.join(root, relative),
  };
}

function stagingProjectView(root, runId) {
  return projectView(root, (relative) => {
    const normalized = String(relative || '').replaceAll('\\', '/');
    for (const dir of Object.values(STAGE_DIR_MAP)) {
      if (normalized === `work/${dir}` || normalized.startsWith(`work/${dir}/`)) {
        const stagedDirectory = path.join(root, 'work', '.staging', runId, dir);
        const staged = path.join(root, 'work', '.staging', runId, normalized.slice('work/'.length));
        // Completed upstream stages may predate staging snapshots. Keep their
        // committed artifacts visible while the current stage is still isolated.
        // Once a stage has a staging directory, every path in that stage must
        // remain isolated, including a newly-created output file.
        return fs.existsSync(stagedDirectory) ? staged : path.join(root, relative);
      }
    }
    return path.join(root, relative);
  });
}

async function commitStage(root, runId, stage, gateResult) {
  const staging = stagingPath(root, runId, stage);
  const committed = committedPath(root, stage);
  const marker = commitMarkerPath(root, stage);
  if (!gateResult?.ok) return { committed: false, gate: gateResult };
  if (!fs.existsSync(staging)) return { committed: false, gate: { ok: false, reason: 'staging 目录不存在' } };

  await fsp.mkdir(path.dirname(committed), { recursive: true });
  await fsp.mkdir(path.dirname(marker), { recursive: true });

  if (fs.existsSync(committed)) {
    const trash = trashPath(root, Date.now(), stage);
    await fsp.mkdir(path.dirname(trash), { recursive: true });
    // Windows may deny renaming a directory that another process is reading.
    // A best-effort snapshot preserves rollback evidence without blocking publish.
    await copyWithRetry(committed, trash).catch(() => {});
    await copyWithRetry(staging, committed);
  } else {
    await copyWithRetry(staging, committed);
  }
  // Retain the run-local snapshot until the pipeline ends. Downstream tools
  // compile and execute against this consistent view, while the committed copy
  // remains the recoverable public artifact set.
  await fsp.writeFile(marker, JSON.stringify({
    runId,
    stage,
    committedAt: new Date().toISOString(),
    gate: {
      ok: true,
      code: gateResult.code || null,
      summary: gateResult.summary || '',
      artifactRefs: gateResult.artifactRefs || [],
    },
  }, null, 2), 'utf8');
  await cleanOldTrash(root);
  return { committed: true, gate: gateResult };
}

async function readCommitMarker(root, stage) {
  try {
    return JSON.parse(await fsp.readFile(commitMarkerPath(root, stage), 'utf8'));
  } catch {
    return null;
  }
}

async function cleanOldTrash(root, keep = 3) {
  const trashRoot = path.join(root, 'work', '.trash');
  const entries = await fsp.readdir(trashRoot, { withFileTypes: true }).catch(() => []);
  const dirs = entries.filter((entry) => entry.isDirectory()).sort((a, b) => b.name.localeCompare(a.name));
  for (const dir of dirs.slice(Math.max(0, keep))) {
    await fsp.rm(path.join(trashRoot, dir.name), { recursive: true, force: true }).catch(() => {});
  }
}

async function recoverProjectState(root, state) {
  const stagingRoot = path.join(root, 'work', '.staging');
  const orphans = await fsp.readdir(stagingRoot).catch(() => []);
  for (const dir of orphans) {
    if (dir === state.runId) continue;
    const orphan = path.join(stagingRoot, dir);
    const trash = path.join(root, 'work', '.trash', `orphan-${Date.now()}`, dir);
    await fsp.mkdir(path.dirname(trash), { recursive: true });
    await fsp.rename(orphan, trash).catch(() => {});
  }
  await cleanOldTrash(root);
  for (const [stage, task] of Object.entries(state.tasks || {})) {
    const marker = await readCommitMarker(root, stage);
    if (task.status === 'completed' && !marker) {
      task.status = 'pending';
      task.attempts = [];
      task.completedAt = null;
    }
    if (task.status !== 'completed' && marker?.runId === state.runId) {
      task.status = 'completed';
      task.completedAt = marker.committedAt;
      task.lastError = null;
      task.artifactRefs = marker.gate?.artifactRefs || task.artifactRefs || [];
    }
  }
  return state;
}

async function prepareStageStaging(root, runId, stage) {
  const staging = stagingPath(root, runId, stage);
  await fsp.mkdir(staging, { recursive: true });
  const committed = committedPath(root, stage);
  if (fs.existsSync(committed) && !(await fsp.readdir(staging).catch(() => [])).length) {
    await fsp.cp(committed, staging, { recursive: true, force: true }).catch(() => {});
  }
  return staging;
}

module.exports = {
  STAGE_DIR_MAP,
  stagingPath,
  committedPath,
  trashPath,
  commitMarkerPath,
  projectView,
  stagingProjectView,
  renameWithRetry,
  copyWithRetry,
  commitStage,
  readCommitMarker,
  cleanOldTrash,
  recoverProjectState,
  prepareStageStaging,
};
