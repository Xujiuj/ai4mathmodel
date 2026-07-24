const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const path = require('node:path');

const STATE_FILE = 'state.bin';
const EVENT_FILE = 'events.log';
const DEFAULT_MAX_JOURNAL_BYTES = 8 * 1024 * 1024;

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

  return {
    directory,
    stateFile,
    eventFile,
    async load() {
      try {
        const ciphertext = (await fsp.readFile(stateFile, 'utf8')).trim();
        const value = JSON.parse(encryption.open(ciphertext));
        if (value?.schemaVersion !== 1 || typeof value.runId !== 'string' || typeof value.tasks !== 'object') return null;
        return value;
      } catch {
        return null;
      }
    },
    async save(state) {
      const next = {
        ...state,
        revision: Number(state.revision || 0) + 1,
        updatedAt: new Date().toISOString(),
      };
      await writeTextAtomic(stateFile, encryption.seal(JSON.stringify(next)));
      return next;
    },
    async append(event) {
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
    },
    async readEvents({ runId, afterSeq = 0, limit = 1000 } = {}) {
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
      return events.slice(-Math.max(1, Math.min(2000, Number(limit) || 1000)));
    },
  };
}

module.exports = {
  DEFAULT_MAX_JOURNAL_BYTES,
  EVENT_FILE,
  STATE_FILE,
  createRunStore,
  storageKey,
  writeTextAtomic,
};
