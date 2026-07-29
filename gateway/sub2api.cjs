const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

const MAX_JSON_BYTES = 512 * 1024;

function requestJson(base, path, { method = 'GET', body, token, timeoutMs = 15_000 } = {}) {
  const target = new URL(path, base);
  const driver = target.protocol === 'https:' ? https : http;
  const payload = body ? Buffer.from(JSON.stringify(body)) : null;
  return new Promise((resolve, reject) => {
    const request = driver.request(target, {
      method,
      headers: {
        Accept: 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      timeout: timeoutMs,
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_JSON_BYTES) {
          response.destroy();
          reject(new Error('UPSTREAM_RESPONSE_TOO_LARGE'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        let parsed = null;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          parsed = null;
        }
        resolve({ status: response.statusCode || 0, body: parsed });
      });
    });
    request.on('timeout', () => request.destroy(new Error('UPSTREAM_TIMEOUT')));
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

function pick(source, names) {
  for (const name of names) {
    const value = name.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), source);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

// sub2api 的用户态响应字段在不同版本间存在差异，此处做宽松取值。
// Phase 0 #8 确认实际路径与字段后收敛为精确映射。
function createSub2apiAdapter({ base, paths }) {
  return {
    async login(email, password) {
      const { status, body } = await requestJson(base, paths.loginPath, {
        method: 'POST',
        body: { email, password },
      });
      if (status !== 200) throw Object.assign(new Error('SUB2API_LOGIN_FAILED'), { status });
      const token = pick(body, ['token', 'data.token', 'access_token', 'data.access_token']);
      if (!token) throw Object.assign(new Error('SUB2API_LOGIN_SHAPE'), { status: 502 });
      return { token: String(token), email: String(pick(body, ['data.user.email', 'user.email']) || email) };
    },

    async profile(token) {
      const { status, body } = await requestJson(base, paths.profilePath, { token });
      if (status !== 200) throw Object.assign(new Error('SUB2API_PROFILE_FAILED'), { status });
      const source = body?.data || body || {};
      return {
        email: String(pick(source, ['email', 'user.email']) || ''),
        balance: Number(pick(source, ['balance', 'user_balance', 'user.balance']) || 0),
        totalSpend: Number(pick(source, ['total_spend', 'used_quota', 'user.total_spend']) || 0),
        currency: String(pick(source, ['currency']) || 'CNY'),
      };
    },

    async primaryApiKey(token) {
      const { status, body } = await requestJson(base, paths.apiKeysPath, { token });
      if (status !== 200) throw Object.assign(new Error('SUB2API_KEYS_FAILED'), { status });
      const list = pick(body, ['data.items', 'data', 'items', 'keys']);
      const entries = Array.isArray(list) ? list : [];
      const active = entries.find((item) => item && item.status !== 'disabled' && pick(item, ['key', 'api_key', 'secret']));
      const key = active ? pick(active, ['key', 'api_key', 'secret']) : undefined;
      if (!key) throw Object.assign(new Error('SUB2API_NO_ACTIVE_KEY'), { status: 502 });
      return String(key);
    },
  };
}

module.exports = { createSub2apiAdapter, requestJson };
