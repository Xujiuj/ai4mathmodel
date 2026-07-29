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

function envelopeData(body, errorCode) {
  if (!body || body.code !== 0 || !body.data || typeof body.data !== 'object') {
    throw Object.assign(new Error(errorCode), { status: 502 });
  }
  return body.data;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function createSub2apiAdapter({ base, paths }) {
  if (!base) throw new Error('SUB2API_CONFIG_INVALID:base');
  for (const field of ['loginPath', 'profilePath', 'usagePath', 'usageListPath', 'apiKeysPath']) {
    if (!paths?.[field]) throw new Error(`SUB2API_CONFIG_INVALID:${field}`);
  }

  return {
    async login(email, password) {
      const { status, body } = await requestJson(base, paths.loginPath, {
        method: 'POST',
        body: { email, password },
      });
      if (status !== 200) throw Object.assign(new Error('SUB2API_LOGIN_FAILED'), { status });
      const data = envelopeData(body, 'SUB2API_LOGIN_SHAPE');
      const token = data.access_token;
      if (!token) throw Object.assign(new Error('SUB2API_LOGIN_SHAPE'), { status: 502 });
      return { token: String(token), email: String(data.user?.email || email) };
    },

    async profile(token) {
      const [profileResponse, usageResponse] = await Promise.all([
        requestJson(base, paths.profilePath, { token }),
        requestJson(base, paths.usagePath, { token }),
      ]);
      if (profileResponse.status !== 200) {
        throw Object.assign(new Error('SUB2API_PROFILE_FAILED'), { status: profileResponse.status });
      }
      if (usageResponse.status !== 200) {
        throw Object.assign(new Error('SUB2API_USAGE_FAILED'), { status: usageResponse.status });
      }
      const profile = envelopeData(profileResponse.body, 'SUB2API_PROFILE_SHAPE');
      const usage = envelopeData(usageResponse.body, 'SUB2API_USAGE_SHAPE');
      return {
        email: String(profile.email || ''),
        balance: finiteNumber(profile.balance),
        totalSpend: finiteNumber(usage.total_actual_cost),
        currency: 'USD',
      };
    },

    async primaryApiKey(token) {
      const { status, body } = await requestJson(base, paths.apiKeysPath, { token });
      if (status !== 200) throw Object.assign(new Error('SUB2API_KEYS_FAILED'), { status });
      const data = envelopeData(body, 'SUB2API_KEYS_SHAPE');
      const entries = Array.isArray(data.items) ? data.items : [];
      const active = entries.find((item) => item?.status === 'active' && item.key);
      if (!active) throw Object.assign(new Error('SUB2API_NO_ACTIVE_KEY'), { status: 502 });
      return String(active.key);
    },

    async billing(token, requestIds = []) {
      const ids = [...new Set((Array.isArray(requestIds) ? requestIds : [])
        .map((value) => String(value || '').trim().slice(0, 160))
        .filter(Boolean))].slice(0, 72);
      const [profileResponse, ...usageResponses] = await Promise.all([
        requestJson(base, paths.profilePath, { token }),
        ...ids.map((requestId) => {
          const query = new URLSearchParams({ request_id: requestId, page: '1', page_size: '20' });
          return requestJson(base, `${paths.usageListPath}?${query}`, { token });
        }),
      ]);
      if (profileResponse.status !== 200) {
        throw Object.assign(new Error('SUB2API_PROFILE_FAILED'), { status: profileResponse.status });
      }
      const profile = envelopeData(profileResponse.body, 'SUB2API_PROFILE_SHAPE');
      const costs = [];
      const missingRequestIds = [];
      for (const [index, response] of usageResponses.entries()) {
        if (response.status !== 200) {
          throw Object.assign(new Error('SUB2API_USAGE_FAILED'), { status: response.status });
        }
        const data = envelopeData(response.body, 'SUB2API_USAGE_SHAPE');
        const requestId = ids[index];
        const item = (Array.isArray(data.items) ? data.items : [])
          .find((entry) => String(entry?.request_id || '') === requestId);
        if (!item) missingRequestIds.push(requestId);
        else costs.push(finiteNumber(item.actual_cost));
      }
      return {
        actualCost: costs.reduce((total, value) => total + value, 0),
        balance: finiteNumber(profile.balance),
        currency: 'USD',
        complete: missingRequestIds.length === 0,
        missingRequestIds,
      };
    },
  };
}

module.exports = { createSub2apiAdapter, requestJson };
