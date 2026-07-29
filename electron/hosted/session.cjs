const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');

const SCHEMA_VERSION = 1;
const MAX_FILE_BYTES = 64 * 1024;

function createHostedSession({ file, codec } = {}) {
  if (!file || typeof codec?.seal !== 'function' || typeof codec?.open !== 'function') {
    throw new Error('托管会话存储配置不完整。');
  }
  let cache = null;

  async function load() {
    if (cache) return cache;
    let stored = null;
    try {
      const raw = await fsp.readFile(file, 'utf8');
      if (raw.length <= MAX_FILE_BYTES) stored = JSON.parse(raw);
    } catch {
      stored = null;
    }
    cache = {
      version: SCHEMA_VERSION,
      deviceId: typeof stored?.deviceId === 'string' && stored.deviceId.length === 64
        ? stored.deviceId
        : crypto.randomBytes(32).toString('hex'),
      credential: typeof stored?.credential === 'string' ? stored.credential : '',
      email: typeof stored?.email === 'string' ? stored.email.slice(0, 160) : '',
    };
    return cache;
  }

  async function persist() {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, JSON.stringify(cache), { mode: 0o600 });
  }

  return {
    async deviceId() {
      return (await load()).deviceId;
    },
    async email() {
      return (await load()).email;
    },
    async credential() {
      const state = await load();
      if (!state.credential) return '';
      try {
        return codec.open(state.credential);
      } catch {
        return '';
      }
    },
    async setCredential(value, email = '') {
      const state = await load();
      state.credential = value ? codec.seal(String(value)) : '';
      state.email = String(email || state.email).slice(0, 160);
      await persist();
    },
    async clear() {
      const state = await load();
      state.credential = '';
      state.email = '';
      await persist();
    },
  };
}

module.exports = { createHostedSession };
