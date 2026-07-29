const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { URL } = require('node:url');

const { parsePlaceholder, PLACEHOLDER_LENGTH } = require('../electron/hosted/playbook-ref.cjs');
const { openKey, sealKey, sign, verify } = require('./tokens.cjs');
const { createSub2apiAdapter } = require('./sub2api.cjs');

const HEAD_LIMIT = 8 * 1024;
const FORWARD_PATHS = new Set(['/v1/chat/completions', '/v1/images/generations']);

function loadConfig() {
  const file = process.env.GATEWAY_CONFIG || path.join(__dirname, 'config.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const field of ['upstream', 'portal', 'publicBaseUrl', 'tokenSecret', 'keySecret']) {
    if (!config[field] || String(config[field]).includes('change-me')) throw new Error(`网关配置缺少 ${field}`);
  }
  return config;
}

function loadPlaybooks() {
  try {
    return require('./playbooks.cjs');
  } catch {
    throw new Error('缺少 gateway/playbooks.cjs，参考 playbooks.example.cjs 创建。');
  }
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length });
  res.end(body);
}

function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        reject(new Error('BODY_TOO_LARGE'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('BODY_INVALID'));
      }
    });
    req.on('error', reject);
  });
}

function bearer(req) {
  const header = String(req.headers.authorization || '');
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

// 只重写请求头部的定长占位符，其余请求体原样透传，CPU 开销与 payload 大小无关。
function spliceHead(head, expanded) {
  const text = head.toString('latin1');
  const start = text.indexOf('@@PB1|');
  if (start < 0) return null;
  const placeholder = text.slice(start, start + PLACEHOLDER_LENGTH);
  const parsed = parsePlaceholder(placeholder);
  if (!parsed) return null;
  const replacement = expanded(parsed);
  if (!replacement) return null;
  const escaped = JSON.stringify(replacement).slice(1, -1);
  return Buffer.concat([
    head.subarray(0, start),
    Buffer.from(escaped, 'utf8'),
    head.subarray(start + PLACEHOLDER_LENGTH),
  ]);
}

function forwardStream({ req, res, config, apiKey, expanded }) {
  const target = new URL(req.url, config.upstream);
  const driver = target.protocol === 'https:' ? https : http;
  const chunks = [];
  let size = 0;
  let spliced = false;
  let upstream = null;

  const open = (headBuffer) => {
    upstream = driver.request(target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: String(req.headers.accept || 'application/json'),
        Authorization: `Bearer ${apiKey}`,
      },
      timeout: Number(config.requestTimeoutMs) || 600_000,
    }, (response) => {
      const requestId = String(response.headers['x-request-id'] || '')
        .replace(/[^\x20-\x7e]/g, '')
        .slice(0, 160);
      res.writeHead(response.statusCode || 502, {
        'Content-Type': response.headers['content-type'] || 'application/json',
        ...(response.headers['content-encoding'] ? { 'Content-Encoding': response.headers['content-encoding'] } : {}),
        ...(requestId ? { 'X-Request-Id': requestId } : {}),
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders?.();
      response.pipe(res);
    });
    upstream.on('timeout', () => upstream.destroy(new Error('UPSTREAM_TIMEOUT')));
    upstream.on('error', () => {
      if (!res.headersSent) sendJson(res, 502, { error: { message: '上游服务不可用。' } });
      else res.destroy();
    });
    upstream.write(headBuffer);
  };

  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > (Number(config.maxBodyBytes) || 8 * 1024 * 1024)) {
      req.destroy();
      if (!res.headersSent) sendJson(res, 413, { error: { message: '请求体过大。' } });
      return;
    }
    if (spliced) {
      upstream.write(chunk);
      return;
    }
    chunks.push(chunk);
    const head = Buffer.concat(chunks);
    if (head.length < HEAD_LIMIT) return;
    const rewritten = spliceHead(head, expanded);
    if (!rewritten) {
      req.destroy();
      sendJson(res, 403, { error: { message: '请求缺少有效的阶段标识。' } });
      return;
    }
    spliced = true;
    chunks.length = 0;
    open(rewritten);
  });

  req.on('end', () => {
    if (spliced) {
      upstream?.end();
      return;
    }
    const rewritten = spliceHead(Buffer.concat(chunks), expanded);
    if (!rewritten) {
      sendJson(res, 403, { error: { message: '请求缺少有效的阶段标识。' } });
      return;
    }
    spliced = true;
    open(rewritten);
    upstream.end();
  });

  req.on('error', () => {
    upstream?.destroy();
  });
}

function createGateway(config = loadConfig(), playbooks = loadPlaybooks()) {
  const sub2api = createSub2apiAdapter({ base: config.upstream, paths: config.sub2api });
  const ttl = Number(config.accessTokenTtlSeconds) || 900;

  async function issueAccessToken(credential, deviceId) {
    const key = await sub2api.primaryApiKey(credential);
    const exp = Math.floor(Date.now() / 1000) + ttl;
    return {
      accessToken: sign({
        exp,
        dev: String(deviceId || '').slice(0, 64),
        k: sealKey(key, config.keySecret),
        c: sealKey(credential, config.keySecret),
      }, config.tokenSecret),
      expiresAt: exp * 1000,
    };
  }

  function authorize(req) {
    const payload = verify(bearer(req), config.tokenSecret);
    const deviceId = String(req.headers['x-device-id'] || '').slice(0, 64);
    if (payload.dev && payload.dev !== deviceId) throw new Error('TOKEN_DEVICE_MISMATCH');
    if (!payload.k || !payload.c) throw new Error('TOKEN_PAYLOAD_INVALID');
    try {
      return {
        apiKey: openKey(payload.k, config.keySecret),
        credential: openKey(payload.c, config.keySecret),
      };
    } catch {
      throw new Error('TOKEN_PAYLOAD_INVALID');
    }
  }

  return http.createServer(async (req, res) => {
    const route = String(req.url || '').split('?')[0];
    try {
      if (req.method === 'GET' && route === '/health') return sendJson(res, 200, { ok: true });

      if (req.method === 'POST' && route === '/auth/login') {
        const body = await readJsonBody(req);
        const session = await sub2api.login(String(body.email || ''), String(body.password || ''));
        return sendJson(res, 200, { credential: session.token, email: session.email });
      }

      if (req.method === 'POST' && route === '/auth/token') {
        const body = await readJsonBody(req);
        return sendJson(res, 200, await issueAccessToken(bearer(req), body.deviceId));
      }

      if (req.method === 'GET' && route === '/catalog') {
        authorize(req);
        return sendJson(res, 200, {
          baseUrl: `${config.publicBaseUrl}/v1`,
          tiers: config.tiers,
          defaultTiers: config.defaultTiers,
          imageEnabled: Boolean(config.imageEnabled),
          topUpEnabled: config.sub2api.topUpEnabled === true,
          maxImagesPerStage: Number(config.maxImagesPerStage) || 0,
        });
      }

      if (req.method === 'GET' && route === '/account') {
        const { credential } = authorize(req);
        return sendJson(res, 200, await sub2api.profile(credential));
      }

      if (req.method === 'GET' && route === '/topup') {
        authorize(req);
        if (config.sub2api.topUpEnabled !== true) {
          return sendJson(res, 409, { error: { message: '在线充值暂未开放。' } });
        }
        return sendJson(res, 200, { url: `${config.portal}${config.sub2api.topUpPath}` });
      }

      if (req.method === 'POST' && route === '/billing') {
        const body = await readJsonBody(req);
        const { credential } = authorize(req);
        const requestIds = Array.isArray(body.requestIds) ? body.requestIds : [];
        if (!requestIds.length || requestIds.length > 72) {
          return sendJson(res, 400, { error: { message: 'requestIds 参数无效。' } });
        }
        return sendJson(res, 200, await sub2api.billing(credential, requestIds));
      }

      if (req.method === 'POST' && FORWARD_PATHS.has(route)) {
        const { apiKey } = authorize(req);
        return forwardStream({
          req,
          res,
          config,
          apiKey,
          expanded: ({ stage, readOnly }) => playbooks.expandPlaybook({ stage, readOnly }),
        });
      }

      return sendJson(res, 404, { error: { message: '未知接口。' } });
    } catch (error) {
      const message = String(error?.message || '');
      if (message.startsWith('TOKEN_')) return sendJson(res, 401, { error: { message: '访问令牌无效或已过期。' } });
      if (message === 'SUB2API_LOGIN_FAILED') return sendJson(res, 401, { error: { message: '账户或密码不正确。' } });
      if (message === 'BODY_TOO_LARGE') return sendJson(res, 413, { error: { message: '请求体过大。' } });
      if (message === 'BODY_INVALID') return sendJson(res, 400, { error: { message: '请求格式无效。' } });
      return sendJson(res, Number(error?.status) === 402 ? 402 : 502, { error: { message: '服务暂时不可用。' } });
    }
  });
}

if (require.main === module) {
  const config = loadConfig();
  createGateway(config).listen(config.port || 8788, () => {
    process.stdout.write(`gateway listening on ${config.port || 8788}\n`);
  });
}

module.exports = { createGateway, spliceHead };
