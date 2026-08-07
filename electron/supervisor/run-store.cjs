const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const path = require('node:path');

const STATE_FILE = 'state.bin';
const EVENT_FILE = 'events.log';
const RUNS_DIRECTORY = 'runs';
const DEFAULT_MAX_JOURNAL_BYTES = 8 * 1024 * 1024;
const fileOperationTails = new Map();

function serializeFileOperation(file, operation) {
  const resolved = path.resolve(file);
  const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  const previous = fileOperationTails.get(key) || Promise.resolve();
  const next = previous.then(operation, operation);
  let settled;
  settled = next.then(
    () => {
      if (fileOperationTails.get(key) === settled) fileOperationTails.delete(key);
    },
    () => {
      if (fileOperationTails.get(key) === settled) fileOperationTails.delete(key);
    },
  );
  fileOperationTails.set(key, settled);
  return next;
}

async function fsyncFile(file) {
  const handle = await fsp.open(file, 'r+');
  try {
    await handle.sync();
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EPERM'].includes(error.code)) throw error;
  } finally {
    await handle.close();
  }
}

async function writeTextAtomic(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(temporary, value, { encoding: 'utf8', mode: 0o600 });
  await fsyncFile(temporary);
  await fsp.rename(temporary, file);
}

async function compactJournal(file, maxBytes) {
  const stat = await fsp.stat(file).catch(() => null);
  if (!stat || stat.size <= maxBytes) return;
  const source = await fsp.readFile(file, 'utf8');
  const retained = source.split(/\r?\n/).filter(Boolean).slice(-1500).join('\n');
  await writeTextAtomic(file, retained ? `${retained}\n` : '');
}

function storageKey(root) {
  const normalized = path.resolve(root);
  const canonical = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function runStorageKey(runId) {
  return crypto.createHash('sha256').update(String(runId)).digest('hex');
}

function normalizeRunLimit(value, fallback = 100) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(200, Math.floor(parsed))) : fallback;
}

function assertCodec(codec) {
  if (!codec || typeof codec.seal !== 'function' || typeof codec.open !== 'function') {
    throw new Error('Private run storage requires an encryption codec.');
  }
  return codec;
}

function createRunStore(root, {
  baseDirectory,
  codec,
  maxJournalBytes = DEFAULT_MAX_JOURNAL_BYTES,
} = {}) {
  if (!baseDirectory) throw new Error('Private run storage directory is required.');
  const encryption = assertCodec(codec);
  const directory = path.join(path.resolve(baseDirectory), storageKey(root));
  const stateFile = path.join(directory, STATE_FILE);
  const eventFile = path.join(directory, EVENT_FILE);
  const runsDirectory = path.join(directory, RUNS_DIRECTORY);

  async function loadStateFile(file) {
    try {
      const ciphertext = (await fsp.readFile(file, 'utf8')).trim();
      const value = JSON.parse(encryption.open(ciphertext));
      if (value?.schemaVersion !== 1 || typeof value.runId !== 'string' || typeof value.tasks !== 'object') return null;
      return value;
    } catch {
      return null;
    }
  }

  function publicRunSummary(state) {
    if (!state || typeof state.runId !== 'string') return null;
    const taskStages = Object.entries(state.tasks || {});
    const lastStage = [...taskStages].reverse().find(([, task]) => task?.status === 'completed')?.[0];
    return {
      runId: state.runId.slice(0, 160),
      status: String(state.status || 'unknown').slice(0, 40),
      stage: typeof state.currentStage === 'string'
        ? state.currentStage.slice(0, 40)
        : (typeof lastStage === 'string' ? lastStage.slice(0, 40) : null),
      startedAt: state.startedAt || null,
      updatedAt: state.updatedAt || null,
      completedAt: state.completedAt || null,
    };
  }

  async function eventRunSummaries() {
    if (!fs.existsSync(eventFile)) return [];
    const lines = (await fsp.readFile(eventFile, 'utf8')).split(/\r?\n/).filter(Boolean);
    const byRun = new Map();
    for (const line of lines) {
      try {
        const event = JSON.parse(encryption.open(line));
        const runId = typeof event?.runId === 'string' ? event.runId : '';
        if (!runId) continue;
        const summary = byRun.get(runId) || {
          runId: runId.slice(0, 160),
          status: 'unknown',
          stage: null,
          startedAt: null,
          updatedAt: null,
          completedAt: null,
        };
        const at = event.createdAt || null;
        summary.updatedAt = at || summary.updatedAt;
        summary.stage = event.payload?.stage || event.taskId || summary.stage;
        if (event.type === 'run.created' || event.type === 'run.started') {
          summary.startedAt = summary.startedAt || at;
          summary.status = event.type === 'run.started' ? 'running' : summary.status;
        } else if (event.type === 'run.resumed') {
          summary.status = 'running';
          summary.startedAt = summary.startedAt || at;
        } else if (event.type === 'run.paused') {
          summary.status = 'paused';
        } else if (event.type === 'run.cancelled') {
          summary.status = 'cancelled';
          summary.completedAt = at;
        } else if (event.type === 'run.completed') {
          summary.status = 'completed';
          summary.completedAt = at;
        }
        byRun.set(runId, summary);
      } catch {
        // A damaged final record is ignored; the encrypted state snapshot remains authoritative.
      }
    }
    return [...byRun.values()];
  }

  return {
    directory,
    stateFile,
    eventFile,
    runsDirectory,
    async load() {
      return loadStateFile(stateFile);
    },
    async loadRun(runId) {
      if (typeof runId !== 'string' || !runId.trim() || runId.length > 160) return null;
      const requested = runId.trim();
      const snapshot = await loadStateFile(path.join(runsDirectory, `${runStorageKey(requested)}.bin`));
      if (snapshot?.runId === requested) return snapshot;
      const current = await loadStateFile(stateFile);
      return current?.runId === requested ? current : null;
    },
    async listRuns({ limit = 100 } = {}) {
      const summaries = new Map();
      const current = await loadStateFile(stateFile);
      if (current) summaries.set(current.runId, publicRunSummary(current));
      if (fs.existsSync(runsDirectory)) {
        const files = await fsp.readdir(runsDirectory).catch(() => []);
        for (const file of files.filter((item) => item.endsWith('.bin')).slice(-500)) {
          const state = await loadStateFile(path.join(runsDirectory, file));
          if (state) summaries.set(state.runId, publicRunSummary(state));
        }
      }
      for (const summary of await eventRunSummaries()) {
        const currentSummary = summaries.get(summary.runId);
        summaries.set(summary.runId, currentSummary
          ? { ...summary, ...currentSummary, stage: currentSummary.stage || summary.stage }
          : summary);
      }
      return [...summaries.values()]
        .filter(Boolean)
        .sort((left, right) => String(right.updatedAt || right.startedAt || '').localeCompare(String(left.updatedAt || left.startedAt || '')))
        .slice(0, normalizeRunLimit(limit));
    },
    async save(state) {
      const next = {
        ...state,
        revision: Number(state.revision || 0) + 1,
        updatedAt: new Date().toISOString(),
      };
      await writeTextAtomic(stateFile, encryption.seal(JSON.stringify(next)));
      await writeTextAtomic(path.join(runsDirectory, `${runStorageKey(next.runId)}.bin`), encryption.seal(JSON.stringify(next)));
      return next;
    },
    async append(event) {
      return serializeFileOperation(eventFile, async () => {
        await fsp.mkdir(directory, { recursive: true });
        await compactJournal(eventFile, maxJournalBytes);
        const handle = await fsp.open(eventFile, 'a', 0o600);
        try {
          await handle.write(`${encryption.seal(JSON.stringify(event))}\n`, null, 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }
        return event;
      });
    },
    async readEvents({ runId, afterSeq = 0, limit = 1000, oldestFirst = false } = {}) {
      if (!fs.existsSync(eventFile)) return [];
      const lines = (await fsp.readFile(eventFile, 'utf8')).split(/\r?\n/).filter(Boolean);
      const events = [];
      for (const line of lines) {
        try {
          const event = JSON.parse(encryption.open(line));
          if ((!runId || event.runId === runId) && Number(event.seq) > Number(afterSeq || 0)) events.push(event);
        } catch {
          // A damaged final record is ignored; the encrypted state snapshot remains authoritative.
        }
      }
      const boundedLimit = Math.max(1, Math.min(2000, Number(limit) || 1000));
      return oldestFirst ? events.slice(0, boundedLimit) : events.slice(-boundedLimit);
    },
  };
}

module.exports = {
  DEFAULT_MAX_JOURNAL_BYTES,
  EVENT_FILE,
  RUNS_DIRECTORY,
  STATE_FILE,
  createRunStore,
  runStorageKey,
  storageKey,
  writeTextAtomic,
};
