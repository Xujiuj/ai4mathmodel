const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const path = require('node:path');
const { URL } = require('node:url');

const { parsePlaceholder, PLACEHOLDER_LENGTH } = require('../electron/hosted/playbook-ref.cjs');
const {
  anonymizeIdentity,
  createAdmissionQueue,
  createGatewayMetrics,
  createRateLimiter,
  createRequestId,
  normalizeOperations,
} = require('./operations.cjs');
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

function forwardStream({ req, res, config, apiKey, expanded, gatewayRequestId, onComplete, onUpstream, registerActive }) {
  const target = new URL(req.url, config.upstream);
  const driver = target.protocol === 'https:' ? https : http;
  const chunks = [];
  let size = 0;
  let spliced = false;
  let upstream = null;
  let upstreamResponse = null;
  let upstreamObserved = false;
  let completed = false;
  let unregister = () => {};
  const upstreamStartedAt = Date.now();

  function complete() {
    if (completed) return;
    completed = true;
    unregister();
    onComplete?.();
  }

  function observeUpstream(status) {
    if (upstreamObserved) return;
    upstreamObserved = true;
    onUpstream?.({ status, durationMs: Date.now() - upstreamStartedAt });
  }

  res.once('finish', complete);
  res.once('close', complete);
  unregister = registerActive?.({
    abort() {
      req.destroy();
      upstream?.destroy();
      upstreamResponse?.destroy();
      res.destroy();
    },
  }) || unregister;

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
      upstreamResponse = response;
      const requestId = String(response.headers['x-request-id'] || '')
        .replace(/[^\x20-\x7e]/g, '')
        .slice(0, 160);
      res.writeHead(response.statusCode || 502, {
        'Content-Type': response.headers['content-type'] || 'application/json',
        ...(response.headers['content-encoding'] ? { 'Content-Encoding': response.headers['content-encoding'] } : {}),
        ...(requestId ? { 'X-Request-Id': requestId } : {}),
        'X-Gateway-Request-Id': gatewayRequestId,
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders?.();
      response.once('end', () => observeUpstream(response.statusCode || 502));
      response.once('error', () => observeUpstream(502));
      response.pipe(res);
    });
    upstream.on('timeout', () => upstream.destroy(new Error('UPSTREAM_TIMEOUT')));
    upstream.on('error', () => {
      observeUpstream(502);
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
  const operations = normalizeOperations(config.operations);
  const limiter = createRateLimiter(operations.rateLimit);
  const admission = createAdmissionQueue(operations.admission);
  const metrics = createGatewayMetrics();
  const sockets = new Set();
  const activeStreams = new Set();
  const logger = typeof config.logger === 'function'
    ? config.logger
    : (entry) => process.stdout.write(`${JSON.stringify(entry)}\n`);
  let shuttingDown = false;
  let shutdownPromise = null;

  function metricRoute(route) {
    return new Set(['/health', '/auth/login', '/auth/token', '/catalog', '/account', '/topup', '/billing', ...FORWARD_PATHS]).has(route)
      ? route
      : 'other';
  }

  function log(entry) {
    try {
      logger(entry);
    } catch {
      // Telemetry must not affect the gateway response path.
    }
  }

  function metricsAuthorized(req) {
    const expected = operations.metrics.token;
    const actual = bearer(req);
    if (!expected || actual.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
  }

  function reject(res, status, retryAfterSeconds, message) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil(retryAfterSeconds || 1))));
    return sendJson(res, status, { error: { message } });
  }

  async function issueAccessToken(credential, deviceId) {
    const device = String(deviceId || '').trim().slice(0, 64);
    if (!device) throw new Error('TOKEN_DEVICE_REQUIRED');
    const key = await sub2api.primaryApiKey(credential);
    const exp = Math.floor(Date.now() / 1000) + ttl;
    return {
      accessToken: sign({
        exp,
        dev: device,
        k: sealKey(key, config.keySecret),
        c: sealKey(credential, config.keySecret),
      }, config.tokenSecret),
      expiresAt: exp * 1000,
    };
  }

  function authorize(req) {
    const payload = verify(bearer(req), config.tokenSecret);
    const deviceId = String(req.headers['x-device-id'] || '').trim().slice(0, 64);
    if (!deviceId || !payload.dev || payload.dev !== deviceId) throw new Error('TOKEN_DEVICE_MISMATCH');
    if (!payload.k || !payload.c) throw new Error('TOKEN_PAYLOAD_INVALID');
    try {
      return {
        apiKey: openKey(payload.k, config.keySecret),
        credential: openKey(payload.c, config.keySecret),
        identity: deviceId,
      };
    } catch {
      throw new Error('TOKEN_PAYLOAD_INVALID');
    }
  }

  const server = http.createServer(async (req, res) => {
    const route = String(req.url || '').split('?')[0];
    const requestId = createRequestId();
    const startedAt = Date.now();
    let identity = '';
    let observed = false;
    res.setHeader('X-Gateway-Request-Id', requestId);

    const observeResponse = () => {
      if (observed || route === operations.metrics.path) return;
      observed = true;
      const status = res.statusCode || 499;
      metrics.observeRequest({ route: metricRoute(route), status, durationMs: Date.now() - startedAt });
      log({
        event: 'gateway_request_completed',
        requestId,
        route: metricRoute(route),
        status,
        durationMs: Date.now() - startedAt,
        ...(identity ? { device: anonymizeIdentity(identity, config.tokenSecret) } : {}),
      });
    };
    res.once('finish', observeResponse);
    res.once('close', observeResponse);

    try {
      if (req.method === 'GET' && route === '/health') {
        return sendJson(res, shuttingDown ? 503 : 200, { ok: !shuttingDown });
      }

      if (req.method === 'GET' && route === operations.metrics.path) {
        if (!operations.metrics.enabled || !operations.metrics.token) return sendJson(res, 404, { error: { message: '未知接口。' } });
        if (!metricsAuthorized(req)) return sendJson(res, 401, { error: { message: '访问令牌无效。' } });
        const body = Buffer.from(metrics.render(admission.snapshot()));
        res.writeHead(200, {
          'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
          'Content-Length': body.length,
          'Cache-Control': 'no-store',
        });
        return res.end(body);
      }

      if (shuttingDown) return reject(res, 503, 1, '服务正在关闭。');

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
        const auth = authorize(req);
        identity = auth.identity;
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
        const auth = authorize(req);
        identity = auth.identity;
        return sendJson(res, 200, await sub2api.profile(auth.credential));
      }

      if (req.method === 'GET' && route === '/topup') {
        const auth = authorize(req);
        identity = auth.identity;
        if (config.sub2api.topUpEnabled !== true) {
          return sendJson(res, 409, { error: { message: '在线充值暂未开放。' } });
        }
        return sendJson(res, 200, { url: `${config.portal}${config.sub2api.topUpPath}` });
      }

      if (req.method === 'POST' && route === '/billing') {
        const body = await readJsonBody(req);
        const auth = authorize(req);
        identity = auth.identity;
        const requestIds = Array.isArray(body.requestIds) ? body.requestIds : [];
        if (!requestIds.length || requestIds.length > 72) {
          return sendJson(res, 400, { error: { message: 'requestIds 参数无效。' } });
        }
        return sendJson(res, 200, await sub2api.billing(auth.credential, requestIds));
      }

      if (req.method === 'POST' && FORWARD_PATHS.has(route)) {
        const auth = authorize(req);
        identity = auth.identity;
        const rate = limiter.check(identity);
        if (!rate.allowed) {
          metrics.reject('rate_limit');
          return reject(res, 429, rate.retryAfterSeconds, '请求过于频繁。');
        }
        const controller = new AbortController();
        req.once('aborted', () => controller.abort());
        let lease;
        try {
          lease = await admission.acquire({ signal: controller.signal });
        } catch (error) {
          const reason = String(error?.code || error?.message || 'admission').replace('ADMISSION_', '').toLowerCase();
          metrics.reject(reason);
          if (String(error?.code || '') === 'ADMISSION_CLOSED') {
            return reject(res, 503, error.retryAfterSeconds, '服务正在关闭。');
          }
          return reject(res, 429, error.retryAfterSeconds, '请求等待队列已满或已超时。');
        }
        return forwardStream({
          req,
          res,
          config,
          apiKey: auth.apiKey,
          gatewayRequestId: requestId,
          onComplete: () => lease.release(),
          onUpstream: (value) => metrics.observeUpstream(value),
          registerActive: (stream) => {
            activeStreams.add(stream);
            return () => activeStreams.delete(stream);
          },
          expanded: ({ stage, readOnly }) => playbooks.expandPlaybook({ stage, readOnly }),
        });
      }

      return sendJson(res, 404, { error: { message: '未知接口。' } });
    } catch (error) {
      if (res.writableEnded || res.destroyed) return undefined;
      const message = String(error?.message || '');
      if (message.startsWith('TOKEN_')) return sendJson(res, 401, { error: { message: '访问令牌无效或已过期。' } });
      if (message === 'SUB2API_LOGIN_FAILED') return sendJson(res, 401, { error: { message: '账户或密码不正确。' } });
      if (message === 'BODY_TOO_LARGE') return sendJson(res, 413, { error: { message: '请求体过大。' } });
      if (message === 'BODY_INVALID') return sendJson(res, 400, { error: { message: '请求格式无效。' } });
      return sendJson(res, Number(error?.status) === 402 ? 402 : 502, { error: { message: '服务暂时不可用。' } });
    }
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  server.shutdown = async ({ graceMs = operations.shutdownGraceMs } = {}) => {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    admission.close();
    const grace = Math.max(1_000, Number(graceMs) || operations.shutdownGraceMs);
    const deadline = Date.now() + grace;
    const serverClosed = new Promise((resolve) => {
      try {
        server.close(() => resolve());
      } catch {
        resolve();
      }
    });
    shutdownPromise = (async () => {
      let drained = false;
      if (await admission.waitForIdle(grace)) {
        // Active streams have finished; keep-alive clients must not consume the grace period.
        server.closeIdleConnections?.();
        const remaining = Math.max(1, deadline - Date.now());
        drained = await Promise.race([
          serverClosed.then(() => true),
          new Promise((resolve) => setTimeout(() => resolve(false), remaining)),
        ]);
      }
      if (!drained) {
        for (const stream of activeStreams) stream.abort();
        for (const socket of sockets) socket.destroy();
        await serverClosed;
      }
      log({ event: 'gateway_shutdown_completed', drained: Boolean(drained) });
    })();
    return shutdownPromise;
  };

  return server;
}

if (require.main === module) {
  const config = loadConfig();
  const server = createGateway(config);
  let signalHandled = false;
  const shutdown = (signal) => {
    if (signalHandled) return;
    signalHandled = true;
    process.stdout.write(`gateway received ${signal}, draining\n`);
    server.shutdown().then(() => {
      process.exitCode = 0;
    }).catch(() => {
      process.exitCode = 1;
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  server.listen(config.port || 8788, () => {
    process.stdout.write(`gateway listening on ${config.port || 8788}\n`);
  });
}

module.exports = { createGateway, spliceHead };
