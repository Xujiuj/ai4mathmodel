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
const { createAccountApiAdapter } = require('./account-api.cjs');
const { createSub2apiAdapter } = require('./sub2api.cjs');

const HEAD_LIMIT = 8 * 1024;
const MAX_IMAGE_REQUESTS = 4;
const MAX_IMAGE_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_READINESS_JSON_BYTES = 64 * 1024;
const DEFAULT_BODY_TOTAL_TIMEOUT_MS = 15_000;
const DEFAULT_BODY_INACTIVITY_TIMEOUT_MS = 5_000;
const CHAT_COMPLETIONS_PATH = '/v1/chat/completions';
const IMAGE_GENERATIONS_PATH = '/v1/images/generations';
const FORWARD_PATHS = new Set([CHAT_COMPLETIONS_PATH, IMAGE_GENERATIONS_PATH]);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const PLACEHOLDER_SECRET_RE = /(?:replace[-_ ]?with|change[-_ ]?me|changeme|your[-_ ]?(?:password|secret|token|key)|example[-_ ]?(?:password|secret|token|key))/i;
const MODEL_ROLES = ['coordinator', 'modeler', 'coder', 'writer', 'image'];
const ROLE_ALIASES = {
  coordinator: ['coordinator', 'supervisor', 'reasoning'],
  modeler: ['modeler', 'analysis', 'reasoning'],
  coder: ['coder', 'coding'],
  writer: ['writer', 'writing'],
  image: ['image'],
};

function firstModel(models, role) {
  const source = models && typeof models === 'object' ? models : {};
  return ROLE_ALIASES[role].map((key) => String(source[key] || '').trim()).find(Boolean) || '';
}

function normalizeTier(tier) {
  const models = {};
  for (const role of MODEL_ROLES) models[role] = firstModel(tier?.models, role);
  return {
    ...tier,
    models: {
      ...models,
      reasoning: models.coordinator,
      coding: models.coder,
      writing: models.writer,
    },
  };
}

function normalizeCatalog(config) {
  const tiers = (Array.isArray(config?.tiers) ? config.tiers : [])
    .map(normalizeTier)
    .filter((tier) => String(tier.id || '').trim());
  const rawDefaults = config?.defaultTiers && typeof config.defaultTiers === 'object' ? config.defaultTiers : {};
  const defaultTiers = {};
  for (const role of MODEL_ROLES) {
    const requestedTier = ROLE_ALIASES[role]
      .map((key) => String(rawDefaults[key] || '').trim())
      .find(Boolean) || '';
    defaultTiers[role] = tiers.some((tier) => tier.id === requestedTier)
      ? requestedTier
      : (tiers[0]?.id || '');
  }
  return {
    tiers,
    defaultTiers: {
      ...defaultTiers,
      reasoning: defaultTiers.coordinator,
      coding: defaultTiers.coder,
      writing: defaultTiers.writer,
    },
  };
}

function createModelResolver(config) {
  const catalog = normalizeCatalog(config);
  const allowed = Object.fromEntries(MODEL_ROLES.map((role) => [
    role,
    new Set(catalog.tiers.map((tier) => tier.models[role]).filter(Boolean)),
  ]));
  const defaults = Object.fromEntries(MODEL_ROLES.map((role) => {
    const tier = catalog.tiers.find((entry) => entry.id === catalog.defaultTiers[role]);
    return [role, tier?.models?.[role] || ''];
  }));
  return {
    catalog,
    resolve({ role, requestedModel = '' }) {
      if (!MODEL_ROLES.includes(role)) throw Object.assign(new Error('MODEL_UNAVAILABLE'), { status: 503 });
      const requested = String(requestedModel || '').trim();
      const model = allowed[role].has(requested) ? requested : defaults[role];
      if (!model) throw Object.assign(new Error('MODEL_UNAVAILABLE'), { status: 503 });
      return model;
    },
  };
}

function assertSecureServiceUrl(value, label = 'service') {
  let endpoint;
  try {
    endpoint = new URL(String(value || '').trim());
  } catch {
    throw new Error(`网关配置的 ${label} 地址无效`);
  }
  const loopbackHttp = endpoint.protocol === 'http:' && LOOPBACK_HOSTS.has(endpoint.hostname.toLowerCase());
  if ((endpoint.protocol !== 'https:' && !loopbackHttp) || endpoint.username || endpoint.password) {
    throw new Error(`网关配置的 ${label} 必须使用 HTTPS，回环地址除外`);
  }
  return endpoint;
}

function assertLoopbackBindHost(value) {
  const host = String(value || '127.0.0.1').trim() || '127.0.0.1';
  if (host !== '127.0.0.1' && host !== '::1') {
    throw new Error('Gateway HTTP listener must bind to a loopback address behind the TLS reverse proxy');
  }
  return host;
}

function cleanLoginEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 160) throw new Error('AUTH_LOGIN_INVALID');
  return email;
}

function cleanPipelineId(value) {
  const pipelineId = String(value || '').trim().slice(0, 160);
  if (!pipelineId || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(pipelineId)) throw new Error('BILLING_PIPELINE_INVALID');
  return pipelineId;
}

function loadConfig() {
  const file = process.env.GATEWAY_CONFIG || path.join(__dirname, 'config.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  config.host = assertLoopbackBindHost(config.host);
  for (const field of ['upstream', 'portal', 'publicBaseUrl', 'tokenSecret', 'keySecret']) {
    if (!config[field] || String(config[field]).includes('change-me')) throw new Error(`网关配置缺少 ${field}`);
  }
  if (config.identityProvider?.mode === 'account-api') {
    if (!config.identityProvider.baseUrl || String(config.identityProvider.serviceToken || '').length < 32 || !config.serviceApiKey) {
      throw new Error('网关配置缺少 account-api、serviceToken 或 serviceApiKey');
    }
    if (!config.sub2api?.billingService?.email || !config.sub2api?.billingService?.password) {
      throw new Error('网关配置缺少 Sub2API billingService');
    }
  }
  if (config.imageEnabled !== false && !config.imageGatewayBaseUrl) throw new Error('网关配置缺少 imageGatewayBaseUrl');
  return config;
}

function loadPlaybooks() {
  try {
    return require('./playbooks.cjs');
  } catch {
    throw new Error('缺少 gateway/playbooks.cjs，参考 playbooks.example.cjs 创建。');
  }
}

function sendJson(res, status, payload, options = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    ...(options.noStore ? { 'Cache-Control': 'no-store', Pragma: 'no-cache' } : {}),
  });
  res.end(body);
}

function bodyTimeout(config, key, fallback) {
  const value = Number(config?.[key]);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), 100), 120_000);
}

function readJsonBody(req, limit = 64 * 1024, config = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const totalTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(new Error('BODY_TIMEOUT'));
    }, bodyTimeout(config, 'requestBodyTimeoutMs', DEFAULT_BODY_TOTAL_TIMEOUT_MS));
    const inactivityMs = bodyTimeout(config, 'requestBodyInactivityTimeoutMs', DEFAULT_BODY_INACTIVITY_TIMEOUT_MS);
    let inactivityTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(new Error('BODY_TIMEOUT'));
    }, inactivityMs);
    const clearTimers = () => {
      clearTimeout(totalTimer);
      clearTimeout(inactivityTimer);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        req.destroy();
        reject(new Error('BODY_TIMEOUT'));
      }, inactivityMs);
      size += chunk.length;
      if (size > limit) {
        settled = true;
        clearTimers();
        req.destroy();
        reject(new Error('BODY_TOO_LARGE'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      clearTimers();
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('BODY_INVALID'));
      }
    });
    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      reject(error);
    });
  });
}

function probeReady(base, path = '/health', timeoutMs = 3_000) {
  const target = new URL(path, base);
  const driver = target.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = driver.request(target, { method: 'GET', headers: { Accept: 'application/json' }, timeout: timeoutMs }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_READINESS_JSON_BYTES) {
          response.destroy(new Error('READINESS_RESPONSE_TOO_LARGE'));
          return;
        }
        chunks.push(chunk);
      });
      response.once('end', () => {
        let body = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* handled below */ }
        if (response.statusCode !== 200 || body?.ok !== true) {
          reject(new Error('IMAGE_GATEWAY_UNAVAILABLE'));
          return;
        }
        resolve(response.statusCode || 0);
      });
      response.once('error', reject);
    });
    request.once('timeout', () => request.destroy(new Error('READINESS_TIMEOUT')));
    request.once('error', reject);
    request.end();
  });
}

function upstreamRequestId(value) {
  const id = String(value || '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(id) ? id : '';
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

function forwardStream({ req, res, config, apiKey, expanded, resolveModel, gatewayRequestId, onComplete, onRequestId, onUpstream, registerActive }) {
  const target = new URL(req.url, config.upstream);
  const driver = target.protocol === 'https:' ? https : http;
  const chunks = [];
  let size = 0;
  let upstream = null;
  let upstreamResponse = null;
  let upstreamObserved = false;
  let responseFailed = false;
  let completed = false;
  let clientDisconnected = false;
  let unregister = () => {};
  let reqDataHandler;
  let reqEndHandler;
  let reqErrorHandler;
  let upstreamTimeoutHandler;
  let upstreamErrorHandler;
  let upstreamResponseEndHandler;
  let upstreamResponseErrorHandler;
  let upstreamResponseAbortedHandler;
  const upstreamStartedAt = Date.now();
  const maxBodyBytes = Number(config.maxBodyBytes) || 8 * 1024 * 1024;
  const bodyTimer = setTimeout(() => {
    if (res.headersSent || res.writableEnded) return;
    fail(408, 'request body timeout');
    req.destroy();
    upstream?.destroy();
  }, bodyTimeout(config, 'requestBodyTimeoutMs', DEFAULT_BODY_TOTAL_TIMEOUT_MS));
  const bodyInactivityMs = bodyTimeout(config, 'requestBodyInactivityTimeoutMs', DEFAULT_BODY_INACTIVITY_TIMEOUT_MS);
  let bodyInactivityTimer = setTimeout(() => {
    if (res.headersSent || res.writableEnded) return;
    fail(408, 'request body timeout');
    req.destroy();
    upstream?.destroy();
  }, bodyInactivityMs);
  const stageRoles = { supervisor: 'coordinator', analysis: 'modeler', review: 'modeler', solving: 'coder', paper: 'writer' };

  function cleanup() {
    clearTimeout(bodyTimer);
    clearTimeout(bodyInactivityTimer);
    if (reqDataHandler) req.removeListener('data', reqDataHandler);
    if (reqEndHandler) req.removeListener('end', reqEndHandler);
    if (reqErrorHandler) req.removeListener('error', reqErrorHandler);
    if (upstream && upstreamTimeoutHandler) upstream.removeListener('timeout', upstreamTimeoutHandler);
    if (upstream && upstreamErrorHandler) upstream.removeListener('error', upstreamErrorHandler);
    if (upstreamResponse) {
      if (upstreamResponseEndHandler) upstreamResponse.removeListener('end', upstreamResponseEndHandler);
      if (upstreamResponseErrorHandler) upstreamResponse.removeListener('error', upstreamResponseErrorHandler);
      if (upstreamResponseAbortedHandler) upstreamResponse.removeListener('aborted', upstreamResponseAbortedHandler);
      upstreamResponse.unpipe?.(res);
    }
    res.removeListener('finish', complete);
    res.removeListener('close', disconnect);
    unregister();
    unregister = () => {};
  }

  function complete() {
    if (completed) return;
    completed = true;
    cleanup();
    onComplete?.();
  }

  function disconnect() {
    if (completed) return;
    clientDisconnected = true;
    responseFailed = true;
    req.once('error', () => {});
    upstream?.once('error', () => {});
    upstreamResponse?.once('error', () => {});
    req.destroy();
    upstream?.destroy();
    upstreamResponse?.destroy();
    complete();
  }

  function observeUpstream(status) {
    if (upstreamObserved) return;
    upstreamObserved = true;
    onUpstream?.({ status, durationMs: Date.now() - upstreamStartedAt });
  }

  function fail(status, message) {
    if (clientDisconnected || completed) return;
    if (!res.headersSent && !res.writableEnded) sendJson(res, status, { error: { message } });
  }

  res.once('finish', complete);
  res.once('close', disconnect);
  unregister = registerActive?.({
    abort() {
      disconnect();
      res.destroy();
    },
  }) || unregister;

  const open = (body) => {
    if (clientDisconnected || completed) return;
    upstream = driver.request(target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: String(req.headers.accept || 'application/json'),
        Authorization: `Bearer ${apiKey}`,
        'Content-Length': body.length,
      },
      timeout: Number(config.requestTimeoutMs) || 600_000,
    }, (response) => {
      if (clientDisconnected || completed) {
        response.destroy();
        return;
      }
      upstreamResponse = response;
      const requestId = upstreamRequestId(response.headers['x-request-id']);
      const upstreamStatus = response.statusCode || 502;
      if (upstreamStatus >= 200 && upstreamStatus < 300 && !requestId) {
        responseFailed = true;
        response.resume();
        observeUpstream(502);
        fail(502, 'upstream response missing request id');
        return;
      }
      Promise.resolve().then(() => {
        if (clientDisconnected || completed) {
          response.destroy();
          return;
        }
        res.writeHead(response.statusCode || 502, {
          'Content-Type': response.headers['content-type'] || 'application/json',
          ...(response.headers['content-encoding'] ? { 'Content-Encoding': response.headers['content-encoding'] } : {}),
          ...(requestId ? { 'X-Request-Id': requestId } : {}),
          'X-Gateway-Request-Id': gatewayRequestId,
          'Cache-Control': 'no-cache',
          'X-Accel-Buffering': 'no',
        });
        res.flushHeaders?.();
        upstreamResponseEndHandler = () => {
          if (clientDisconnected || completed || responseFailed) return;
          observeUpstream(upstreamStatus);
          const completedSuccessfully = upstreamStatus >= 200 && upstreamStatus < 300 && Boolean(requestId);
          Promise.resolve(completedSuccessfully ? onRequestId?.(requestId) : undefined)
            .then(() => { if (!res.destroyed) res.end(); })
            .catch(() => { if (!res.destroyed) res.destroy(); });
        };
        upstreamResponseErrorHandler = () => {
          if (clientDisconnected || completed || responseFailed) return;
          responseFailed = true;
          observeUpstream(502);
          if (res.headersSent) res.destroy();
        };
        upstreamResponseAbortedHandler = upstreamResponseErrorHandler;
        response.once('end', upstreamResponseEndHandler);
        response.once('error', upstreamResponseErrorHandler);
        response.once('aborted', upstreamResponseAbortedHandler);
        response.pipe(res, { end: false });
      }).catch(() => {
        response.destroy();
        observeUpstream(502);
        if (!res.headersSent) fail(502, 'billing record service unavailable');
        else res.destroy();
      });
    });
    upstreamTimeoutHandler = () => upstream.destroy(new Error('UPSTREAM_TIMEOUT'));
    upstreamErrorHandler = () => {
      if (clientDisconnected || completed) return;
      observeUpstream(502);
      if (!res.headersSent) fail(502, 'upstream service unavailable');
      else res.destroy();
    };
    upstream.on('timeout', upstreamTimeoutHandler);
    upstream.on('error', upstreamErrorHandler);
    upstream.end(body);
  };

  reqDataHandler = (chunk) => {
    if (clientDisconnected || completed) return;
    clearTimeout(bodyInactivityTimer);
    bodyInactivityTimer = setTimeout(() => {
      if (res.headersSent || res.writableEnded) return;
      fail(408, 'request body timeout');
      req.destroy();
      upstream?.destroy();
    }, bodyInactivityMs);
    size += chunk.length;
    if (size > maxBodyBytes) {
      req.destroy();
      fail(413, 'request body too large');
      return;
    }
    chunks.push(chunk);
  };
  reqEndHandler = () => {
    clearTimeout(bodyTimer);
    clearTimeout(bodyInactivityTimer);
    if (clientDisconnected || completed || res.writableEnded || res.destroyed) return;
    const input = Buffer.concat(chunks);
    const rewritten = spliceHead(input, expanded);
    if (!rewritten) {
      fail(403, 'request is missing a valid stage marker');
      return;
    }
    let payload;
    try {
      payload = JSON.parse(rewritten.toString('utf8'));
    } catch {
      fail(400, 'request body is invalid');
      return;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      fail(400, 'request body is invalid');
      return;
    }
    const markerText = input.toString('latin1');
    const markerStart = markerText.indexOf('@@PB1|');
    const marker = markerStart >= 0 ? parsePlaceholder(markerText.slice(markerStart, markerStart + PLACEHOLDER_LENGTH)) : null;
    if (!marker) {
      fail(403, 'request is missing a valid stage marker');
      return;
    }
    try {
      payload.model = resolveModel({ role: stageRoles[marker.stage] || 'modeler', requestedModel: payload.model });
    } catch (error) {
      fail(Number(error?.status) === 503 ? 503 : 502, 'model service is unavailable');
      return;
    }
    open(Buffer.from(JSON.stringify(payload)));
  };
  reqErrorHandler = () => upstream?.destroy();
  req.on('data', reqDataHandler);
  req.on('end', reqEndHandler);
  req.on('error', reqErrorHandler);
}

function forwardStreamLegacy({ req, res, config, apiKey, expanded, gatewayRequestId, onComplete, onRequestId, onUpstream, registerActive }) {
  const target = new URL(req.url, config.upstream);
  const driver = target.protocol === 'https:' ? https : http;
  const chunks = [];
  let size = 0;
  let spliced = false;
  let upstream = null;
  let upstreamResponse = null;
  let upstreamObserved = false;
  let responseFailed = false;
  let completed = false;
  let clientDisconnected = false;
  let upstreamErrorHandler;
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
      const requestId = upstreamRequestId(response.headers['x-request-id']);
      const upstreamStatus = response.statusCode || 502;
      if (upstreamStatus >= 200 && upstreamStatus < 300 && !requestId) {
        responseFailed = true;
        response.resume();
        observeUpstream(502);
        if (!res.headersSent) sendJson(res, 502, { error: { message: 'upstream response missing request id' } });
        return;
      }
      Promise.resolve().then(() => {
        res.writeHead(response.statusCode || 502, {
          'Content-Type': response.headers['content-type'] || 'application/json',
          ...(response.headers['content-encoding'] ? { 'Content-Encoding': response.headers['content-encoding'] } : {}),
          ...(requestId ? { 'X-Request-Id': requestId } : {}),
          'X-Gateway-Request-Id': gatewayRequestId,
          'Cache-Control': 'no-cache',
          'X-Accel-Buffering': 'no',
        });
        res.flushHeaders?.();
        response.once('end', () => {
          if (responseFailed) return;
          observeUpstream(upstreamStatus);
          const completedSuccessfully = upstreamStatus >= 200 && upstreamStatus < 300 && Boolean(requestId);
          Promise.resolve(completedSuccessfully ? onRequestId?.(requestId) : undefined)
            .then(() => {
              if (!res.destroyed) res.end();
            })
            .catch(() => {
              if (!res.destroyed) res.destroy();
            });
        });
        const failResponse = () => {
          if (responseFailed) return;
          responseFailed = true;
          observeUpstream(502);
          if (res.headersSent) res.destroy();
        };
        response.once('error', failResponse);
        response.once('aborted', failResponse);
        response.pipe(res, { end: false });
      }).catch(() => {
        response.destroy();
        observeUpstream(502);
        if (!res.headersSent) sendJson(res, 502, { error: { message: '计费记录服务暂时不可用。' } });
        else res.destroy();
      });
    });
    upstream.on('timeout', () => upstream.destroy(new Error('UPSTREAM_TIMEOUT')));
    upstreamErrorHandler = () => {
      if (clientDisconnected || completed) return;
      observeUpstream(502);
      if (!res.headersSent) sendJson(res, 502, { error: { message: '上游服务不可用。' } });
      else res.destroy();
    };
    upstream.on('error', upstreamErrorHandler);
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

function imageGatewayTarget(config) {
  const target = new URL(String(config.imageGatewayBaseUrl || '').trim());
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('IMAGE_GATEWAY_CONFIG_INVALID');
  target.search = '';
  target.hash = '';
  const basePath = target.pathname.replace(/\/+$/, '');
  target.pathname = /\/v1\/images\/generations$/i.test(basePath)
    ? basePath
    : (/\/v1$/i.test(basePath) ? `${basePath}/images/generations` : `${basePath}/v1/images/generations`)
      .replace(/\/{2,}/g, '/');
  return target;
}

function imageRequestLimit(config) {
  const configured = Number(config.maxImagesPerStage);
  if (!Number.isFinite(configured) || configured < 1) return 1;
  return Math.min(Math.floor(configured), MAX_IMAGE_REQUESTS);
}

function imageResponseLimit(config) {
  const configured = Number(config.maxImageResponseBytes);
  if (!Number.isFinite(configured) || configured < 1) return MAX_IMAGE_RESPONSE_BYTES;
  return Math.min(Math.floor(configured), MAX_IMAGE_RESPONSE_BYTES);
}

// Image prompts are ordinary JSON and must never enter the model-playbook splice path.
function forwardImage({ req, res, config, resolveModel, gatewayRequestId, onComplete, onRequestId, onUpstream, registerActive }) {
  const target = imageGatewayTarget(config);
  const driver = target.protocol === 'https:' ? https : http;
  const chunks = [];
  let size = 0;
  let upstream = null;
  let upstreamResponse = null;
  let upstreamObserved = false;
  let completed = false;
  let failed = false;
  let clientDisconnected = false;
  let unregister = () => {};
  let reqDataHandler;
  let reqEndHandler;
  let reqErrorHandler;
  let upstreamTimeoutHandler;
  let upstreamErrorHandler;
  let upstreamResponseErrorHandler;
  let upstreamResponseAbortedHandler;
  let upstreamResponseDataHandler;
  let upstreamResponseEndHandler;
  const upstreamStartedAt = Date.now();
  const maxBodyBytes = Number(config.maxBodyBytes) || 8 * 1024 * 1024;
  const bodyTimer = setTimeout(() => {
    if (res.headersSent || res.writableEnded) return;
    fail(408, 'request body timeout');
    req.destroy();
    upstream?.destroy();
  }, bodyTimeout(config, 'requestBodyTimeoutMs', DEFAULT_BODY_TOTAL_TIMEOUT_MS));
  const bodyInactivityMs = bodyTimeout(config, 'requestBodyInactivityTimeoutMs', DEFAULT_BODY_INACTIVITY_TIMEOUT_MS);
  let bodyInactivityTimer = setTimeout(() => {
    if (res.headersSent || res.writableEnded) return;
    fail(408, 'request body timeout');
    req.destroy();
    upstream?.destroy();
  }, bodyInactivityMs);

  function cleanup() {
    clearTimeout(bodyTimer);
    clearTimeout(bodyInactivityTimer);
    if (reqDataHandler) req.removeListener('data', reqDataHandler);
    if (reqEndHandler) req.removeListener('end', reqEndHandler);
    if (reqErrorHandler) req.removeListener('error', reqErrorHandler);
    if (upstream && upstreamTimeoutHandler) upstream.removeListener('timeout', upstreamTimeoutHandler);
    if (upstream && upstreamErrorHandler) upstream.removeListener('error', upstreamErrorHandler);
    if (upstreamResponse) {
      if (upstreamResponseErrorHandler) upstreamResponse.removeListener('error', upstreamResponseErrorHandler);
      if (upstreamResponseAbortedHandler) upstreamResponse.removeListener('aborted', upstreamResponseAbortedHandler);
      if (upstreamResponseDataHandler) upstreamResponse.removeListener('data', upstreamResponseDataHandler);
      if (upstreamResponseEndHandler) upstreamResponse.removeListener('end', upstreamResponseEndHandler);
    }
    res.removeListener('finish', complete);
    res.removeListener('close', disconnect);
    unregister();
    unregister = () => {};
  }

  function complete() {
    if (completed) return;
    completed = true;
    cleanup();
    onComplete?.();
  }

  function disconnect() {
    if (completed) return;
    clientDisconnected = true;
    failed = true;
    req.once('error', () => {});
    upstream?.once('error', () => {});
    upstreamResponse?.once('error', () => {});
    req.destroy();
    upstream?.destroy();
    upstreamResponse?.destroy();
    complete();
  }

  function observeUpstream(status) {
    if (upstreamObserved) return;
    upstreamObserved = true;
    onUpstream?.({ status, durationMs: Date.now() - upstreamStartedAt });
  }

  function fail(status, message) {
    if (failed || clientDisconnected || completed || res.headersSent) return;
    failed = true;
    sendJson(res, status, { error: { message } });
  }

  res.once('finish', complete);
  res.once('close', disconnect);
  unregister = registerActive?.({
    abort() {
      disconnect();
      res.destroy();
    },
  }) || unregister;

  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    fail(415, '图像请求必须使用 JSON。');
    req.resume();
    return;
  }
  const declaredLength = Number(req.headers['content-length'] || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
    fail(413, '请求体过大。');
    req.resume();
    return;
  }

  reqDataHandler = (chunk) => {
    if (failed || clientDisconnected || completed) return;
    clearTimeout(bodyInactivityTimer);
    bodyInactivityTimer = setTimeout(() => {
      if (res.headersSent || res.writableEnded) return;
      fail(408, 'request body timeout');
      req.destroy();
      upstream?.destroy();
    }, bodyInactivityMs);
    size += chunk.length;
    if (size > maxBodyBytes) {
      fail(413, '请求体过大。');
      req.destroy();
      return;
    }
    chunks.push(chunk);
  };
  reqErrorHandler = () => upstream?.destroy();
  reqEndHandler = () => {
    clearTimeout(bodyTimer);
    clearTimeout(bodyInactivityTimer);
    if (failed || clientDisconnected || completed) return;
    const body = Buffer.concat(chunks);
    let payload;
    try {
      payload = JSON.parse(body.toString('utf8'));
    } catch {
      fail(400, 'image request body is invalid');
      return;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      fail(400, 'image request body is invalid');
      return;
    }
    const count = payload.n === undefined ? 1 : payload.n;
    if (!Number.isInteger(count) || count < 1 || count > imageRequestLimit(config)) {
      fail(400, 'image request count exceeds server limit');
      return;
    }
    try {
      payload.model = resolveModel({ role: 'image', requestedModel: payload.model });
    } catch {
      fail(503, 'image model service is unavailable');
      return;
    }
    const upstreamBody = Buffer.from(JSON.stringify(payload));
    upstream = driver.request(target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: String(req.headers.accept || 'application/json'),
        // The upstream Image Gateway owns provider credentials; clients never receive this relay credential.
        Authorization: 'Bearer image-gateway',
        'Content-Length': upstreamBody.length,
      },
      timeout: Number(config.imageRequestTimeoutMs) || Number(config.requestTimeoutMs) || 120_000,
    }, (response) => {
      if (clientDisconnected || completed) {
        response.destroy();
        return;
      }
      upstreamResponse = response;
      const requestId = upstreamRequestId(response.headers['x-request-id']);
      const responseLimit = imageResponseLimit(config);
      let responseTooLarge = false;
      let responseCompleted = false;
      upstreamResponseErrorHandler = () => {
        if (responseCompleted || clientDisconnected || completed) return;
        observeUpstream(502);
        if (!responseTooLarge && !res.headersSent) fail(502, 'image gateway response unavailable');
      };
      upstreamResponseAbortedHandler = upstreamResponseErrorHandler;
      response.once('error', upstreamResponseErrorHandler);
      response.once('aborted', upstreamResponseAbortedHandler);
      const responseLength = Number(response.headers['content-length'] || 0);
      if (Number.isFinite(responseLength) && responseLength > responseLimit) {
        responseTooLarge = true;
        observeUpstream(response.statusCode || 502);
        response.destroy();
        fail(502, 'image response exceeds gateway limit');
        return;
      }
      const responseChunks = [];
      let responseBytes = 0;
      upstreamResponseDataHandler = (chunk) => {
        if (responseTooLarge || clientDisconnected || completed) return;
        if (response.statusCode >= 200 && response.statusCode < 300 && !requestId) {
          observeUpstream(502);
          fail(502, 'image gateway response missing request id');
          return;
        }
        responseBytes += chunk.length;
        if (responseBytes > responseLimit) {
          responseTooLarge = true;
          observeUpstream(response.statusCode || 502);
          response.destroy();
          fail(502, 'image response exceeds gateway limit');
          return;
        }
        responseChunks.push(chunk);
      };
      upstreamResponseEndHandler = () => {
        if (responseCompleted || clientDisconnected || completed) return;
        responseCompleted = true;
        observeUpstream(response.statusCode || 502);
        if (responseTooLarge) return;
        if (response.statusCode >= 200 && response.statusCode < 300 && !requestId) {
          fail(502, 'image gateway response missing request id');
          return;
        }
        const claim = response.statusCode >= 200 && response.statusCode < 300 && Boolean(requestId);
        Promise.resolve(claim ? onRequestId?.(requestId) : undefined).then(() => {
          res.writeHead(response.statusCode || 502, {
            'Content-Type': response.headers['content-type'] || 'application/json',
            ...(requestId ? { 'X-Request-Id': requestId } : {}),
            'X-Gateway-Request-Id': gatewayRequestId,
            'Cache-Control': 'no-store',
          });
          res.end(Buffer.concat(responseChunks));
        }).catch(() => {
          if (!res.headersSent) fail(502, 'image billing claim unavailable');
          else res.destroy();
        });
      };
      response.on('data', upstreamResponseDataHandler);
      response.once('end', upstreamResponseEndHandler);
    });
    upstreamTimeoutHandler = () => upstream.destroy(new Error('IMAGE_GATEWAY_TIMEOUT'));
    upstream.on('timeout', upstreamTimeoutHandler);
    upstreamErrorHandler = () => {
      if (clientDisconnected || completed) return;
      observeUpstream(502);
      if (!res.headersSent) fail(502, '图像服务不可用。');
      else res.destroy();
    };
    upstream.on('error', upstreamErrorHandler);
    upstream.end(upstreamBody);
  };
  req.on('data', reqDataHandler);
  req.on('error', reqErrorHandler);
  req.on('end', reqEndHandler);
}

function createGateway(config = loadConfig(), playbooks = loadPlaybooks()) {
  assertSecureServiceUrl(config.upstream, 'upstream');
  if (config.imageEnabled !== false) assertSecureServiceUrl(config.imageGatewayBaseUrl, 'imageGatewayBaseUrl');
  if (config.identityProvider?.mode === 'account-api') assertSecureServiceUrl(config.identityProvider.baseUrl, 'identityProvider.baseUrl');
  const sub2api = createSub2apiAdapter({
    base: config.upstream,
    paths: config.sub2api,
    billingService: config.sub2api?.billingService,
    billingConcurrency: config.sub2api?.billingConcurrency,
  });
  const modelCatalog = createModelResolver(config);
  const accountApiMode = config.identityProvider?.mode === 'account-api';
  if (accountApiMode) {
    const serviceToken = String(config.identityProvider?.serviceToken || '').trim();
    const serviceApiKey = String(config.serviceApiKey || '').trim();
    const billingPassword = String(config.sub2api?.billingService?.password || '');
    if (serviceToken.length < 32 || serviceApiKey.length < 1 || billingPassword.length < 12
      || PLACEHOLDER_SECRET_RE.test(serviceToken)
      || PLACEHOLDER_SECRET_RE.test(serviceApiKey)
      || PLACEHOLDER_SECRET_RE.test(billingPassword)) {
      throw new Error('GATEWAY_PRODUCTION_CREDENTIALS_INVALID');
    }
  }
  const accountApi = accountApiMode ? createAccountApiAdapter({
    base: config.identityProvider.baseUrl,
    serviceToken: config.identityProvider.serviceToken,
  }) : null;
  const ttl = Number(config.accessTokenTtlSeconds) || 900;
  const operations = normalizeOperations(config.operations);
  const limiter = createRateLimiter(operations.rateLimit);
  const billingLimiter = createRateLimiter(operations.billingRateLimit);
  const accountLimiter = createRateLimiter(operations.accountRateLimit);
  const billingAccountLimiter = createRateLimiter(operations.billingAccountRateLimit);
  const tokenAccountLimiter = createRateLimiter({
    windowMs: operations.tokenRateLimit.windowMs,
    maxRequests: operations.tokenRateLimit.maxAttempts,
    maxTrackedDevices: operations.tokenRateLimit.maxTrackedIdentities,
  });
  const loginLimiterOptions = {
    windowMs: operations.loginRateLimit.windowMs,
    maxRequests: operations.loginRateLimit.maxAttempts,
    maxTrackedDevices: operations.loginRateLimit.maxTrackedIdentities,
  };
  const loginSourceLimiter = createRateLimiter(loginLimiterOptions);
  const loginAccountLimiter = createRateLimiter(loginLimiterOptions);
  const admission = createAdmissionQueue(operations.admission);
  const billingAdmission = createAdmissionQueue(operations.billingAdmission);
  const metrics = createGatewayMetrics();
  const sockets = new Set();
  const activeStreams = new Set();
  const logger = typeof config.logger === 'function'
    ? config.logger
    : (entry) => process.stdout.write(`${JSON.stringify(entry)}\n`);
  let shuttingDown = false;
  let shutdownPromise = null;

  function metricRoute(route) {
    return new Set(['/health', '/ready', '/auth/login', '/auth/token', '/catalog', '/account', '/topup', '/billing', ...FORWARD_PATHS]).has(route)
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

  function loginSource(req) {
    if (operations.loginRateLimit.trustProxy) {
      const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (forwarded) return forwarded.slice(0, 128);
    }
    return String(req.socket?.remoteAddress || 'unknown').slice(0, 128);
  }

  function accountRateKey(auth) {
    return anonymizeIdentity(auth?.userId || auth?.credential || auth?.identity, config.tokenSecret);
  }

  async function issueAccessToken(credential, deviceId) {
    const device = String(deviceId || '').trim().slice(0, 64);
    if (!device) throw new Error('TOKEN_DEVICE_REQUIRED');
    const user = accountApiMode ? await accountApi.profile(credential) : null;
    const tokenRate = tokenAccountLimiter.check(anonymizeIdentity(user?.id || credential, config.tokenSecret));
    if (!tokenRate.allowed) {
      throw Object.assign(new Error('TOKEN_RATE_LIMIT'), { retryAfterSeconds: tokenRate.retryAfterSeconds });
    }
    const key = accountApiMode ? String(config.serviceApiKey) : await sub2api.primaryApiKey(credential);
    if (!key) throw new Error('TOKEN_SERVICE_KEY_INVALID');
    const exp = Math.floor(Date.now() / 1000) + ttl;
    return {
      accessToken: sign({
        exp,
        dev: device,
        k: sealKey(key, config.keySecret),
        c: sealKey(credential, config.keySecret),
        ...(user ? { uid: user.id } : {}),
      }, config.tokenSecret),
      expiresAt: exp * 1000,
    };
  }

  async function authorize(req) {
    const payload = verify(bearer(req), config.tokenSecret);
    const deviceId = String(req.headers['x-device-id'] || '').trim().slice(0, 64);
    if (!deviceId || !payload.dev || payload.dev !== deviceId) throw new Error('TOKEN_DEVICE_MISMATCH');
    if (!payload.k || !payload.c) throw new Error('TOKEN_PAYLOAD_INVALID');
    try {
      const auth = {
        apiKey: openKey(payload.k, config.keySecret),
        credential: openKey(payload.c, config.keySecret),
        identity: payload.uid ? `${String(payload.uid).slice(0, 64)}:${deviceId}` : deviceId,
        userId: payload.uid ? String(payload.uid).slice(0, 64) : '',
      };
      if (accountApiMode) {
        const account = await accountApi.profile(auth.credential);
        if (!auth.userId || account.id !== auth.userId) throw new Error('TOKEN_PAYLOAD_INVALID');
        auth.account = account;
      }
      return auth;
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

      if (req.method === 'GET' && route === '/ready') {
        if (shuttingDown) return sendJson(res, 503, { ok: false });
        try {
          const probes = [sub2api.ready()];
          if (accountApiMode) probes.push(accountApi.ready());
          if (config.imageEnabled !== false) {
            probes.push(probeReady(config.imageGatewayBaseUrl, config.imageGatewayHealthPath || '/health')
              .then((status) => {
                if (status !== 200) throw new Error('IMAGE_GATEWAY_UNAVAILABLE');
              }));
          }
          await Promise.all(probes);
          return sendJson(res, 200, { ok: true });
        } catch {
          log({ event: 'gateway_readiness_failed', requestId, status: 503 });
          return sendJson(res, 503, { ok: false });
        }
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
        const body = await readJsonBody(req, 64 * 1024, config);
        const email = cleanLoginEmail(body.email);
        const password = String(body.password || '');
        if (!password || password.length > 200 || (accountApiMode && password.length < 12)) throw new Error('AUTH_LOGIN_INVALID');
        const sourceRate = loginSourceLimiter.check(loginSource(req));
        const accountRate = loginAccountLimiter.check(anonymizeIdentity(email, config.tokenSecret));
        if (!sourceRate.allowed || !accountRate.allowed) {
          metrics.reject('login_rate_limit');
          return reject(res, 429, Math.max(sourceRate.retryAfterSeconds, accountRate.retryAfterSeconds), '登录尝试过于频繁。');
        }
        const session = accountApiMode ? await accountApi.login(email, password) : await sub2api.login(email, password);
        return sendJson(res, 200, {
          credential: session.token,
          email: session.user?.email || session.email,
          ...(session.user ? { account: session.user } : {}),
        }, { noStore: true });
      }

      if (req.method === 'POST' && route === '/auth/register') {
        if (!accountApiMode) return sendJson(res, 404, { error: { message: '当前账户服务不提供注册接口。' } });
        const body = await readJsonBody(req, 64 * 1024, config);
        const email = cleanLoginEmail(body.email);
        const password = String(body.password || '');
        if (password.length < 12 || password.length > 200) throw new Error('AUTH_LOGIN_INVALID');
        const sourceRate = loginSourceLimiter.check(loginSource(req));
        const accountRate = loginAccountLimiter.check(anonymizeIdentity(email, config.tokenSecret));
        if (!sourceRate.allowed || !accountRate.allowed) {
          metrics.reject('register_rate_limit');
          return reject(res, 429, Math.max(sourceRate.retryAfterSeconds, accountRate.retryAfterSeconds), '注册尝试过于频繁。');
        }
        const session = await accountApi.register(email, password);
        return sendJson(res, 201, { credential: session.token, email: session.user.email, account: session.user }, { noStore: true });
      }

      if (req.method === 'POST' && route === '/auth/token') {
        const body = await readJsonBody(req, 64 * 1024, config);
        return sendJson(res, 200, await issueAccessToken(bearer(req), body.deviceId), { noStore: true });
      }

      if (req.method === 'POST' && route === '/auth/logout') {
        const credential = bearer(req);
        if (accountApiMode && credential) await accountApi.logout(credential);
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === 'GET' && route === '/catalog') {
        const auth = await authorize(req);
        identity = auth.identity;
        return sendJson(res, 200, {
          baseUrl: `${config.publicBaseUrl}/v1`,
          tiers: modelCatalog.catalog.tiers,
          defaultTiers: modelCatalog.catalog.defaultTiers,
          imageEnabled: Boolean(config.imageEnabled),
          topUpEnabled: config.sub2api.topUpEnabled === true,
          maxImagesPerStage: Number(config.maxImagesPerStage) || 0,
        });
      }

      if (req.method === 'GET' && route === '/account') {
        const auth = await authorize(req);
        identity = auth.identity;
        return sendJson(res, 200, accountApiMode ? auth.account : await sub2api.profile(auth.credential));
      }

      if (req.method === 'GET' && route === '/topup') {
        const auth = await authorize(req);
        identity = auth.identity;
        if (accountApiMode || config.sub2api.topUpEnabled !== true) {
          return sendJson(res, 409, { error: { message: '在线充值暂未开放。' } });
        }
        return sendJson(res, 200, { url: `${config.portal}${config.sub2api.topUpPath}` });
      }

      if (req.method === 'POST' && route === '/billing') {
        const body = await readJsonBody(req, 64 * 1024, config);
        const auth = await authorize(req);
        identity = auth.identity;
        const requestIds = Array.isArray(body.requestIds) ? body.requestIds : [];
        if (!requestIds.length || requestIds.length > 72) {
          return sendJson(res, 400, { error: { message: 'requestIds 参数无效。' } });
        }
        const rate = billingLimiter.check(identity);
        if (!rate.allowed) {
          metrics.reject('billing_rate_limit');
          return reject(res, 429, rate.retryAfterSeconds, 'billing requests are too frequent');
        }
        const accountRate = billingAccountLimiter.check(accountRateKey(auth));
        if (!accountRate.allowed) {
          metrics.reject('billing_account_rate_limit');
          return reject(res, 429, accountRate.retryAfterSeconds, 'billing requests are too frequent');
        }
        const controller = new AbortController();
        req.once('aborted', () => controller.abort());
        let lease;
        try {
          lease = await billingAdmission.acquire({ signal: controller.signal });
        } catch (error) {
          const reason = String(error?.code || error?.message || 'billing_admission').replace('ADMISSION_', '').toLowerCase();
          metrics.reject(`billing_${reason}`);
          if (String(error?.code || '') === 'ADMISSION_CLOSED') {
            return reject(res, 503, error.retryAfterSeconds, 'service is shutting down');
          }
          return reject(res, 429, error.retryAfterSeconds, 'billing capacity is busy');
        }
        try {
          if (accountApiMode) {
            const pipelineId = cleanPipelineId(body.pipelineId);
            const usage = await sub2api.serviceRequestCosts(requestIds);
            const account = usage.requestCosts.length
              ? await accountApi.settleUsage(auth.userId, pipelineId, usage.requestCosts)
              : auth.account;
            return sendJson(res, 200, {
              actualCost: usage.requestCosts.length ? account.actualCost : 0,
              balance: account.balance,
              currency: account.currency,
              complete: usage.complete,
              missingRequestIds: usage.missingRequestIds,
            });
          }
          return sendJson(res, 200, await sub2api.billing(auth.credential, requestIds));
        } finally {
          lease.release();
        }
      }

      if (req.method === 'POST' && FORWARD_PATHS.has(route)) {
        const auth = await authorize(req);
        identity = auth.identity;
        if (route === IMAGE_GENERATIONS_PATH && config.imageEnabled === false) {
          req.resume();
          return sendJson(res, 404, { error: { message: 'image generation is disabled' } });
        }
        const rate = limiter.check(identity);
        if (!rate.allowed) {
          metrics.reject('rate_limit');
          return reject(res, 429, rate.retryAfterSeconds, '请求过于频繁。');
        }
        const accountRate = accountLimiter.check(accountRateKey(auth));
        if (!accountRate.allowed) {
          metrics.reject('account_rate_limit');
          return reject(res, 429, accountRate.retryAfterSeconds, '请求过于频繁。');
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
        let pipelineId = '';
        if (accountApiMode && (route === CHAT_COMPLETIONS_PATH || route === IMAGE_GENERATIONS_PATH)) {
          try {
            pipelineId = cleanPipelineId(req.headers['x-pipeline-id']);
            await accountApi.startRun(auth.userId, pipelineId);
          } catch (error) {
            lease.release();
            throw error;
          }
        }
        const forward = {
          req,
          res,
          config,
          gatewayRequestId: requestId,
          onComplete: () => lease.release(),
          onUpstream: (value) => metrics.observeUpstream(value),
          registerActive: (stream) => {
            activeStreams.add(stream);
            return () => activeStreams.delete(stream);
          },
        };
        if (route === IMAGE_GENERATIONS_PATH) {
          return forwardImage({
            ...forward,
            resolveModel: modelCatalog.resolve,
            onRequestId: accountApiMode
              ? (upstreamRequestId) => {
                if (!upstreamRequestId) throw Object.assign(new Error('UPSTREAM_REQUEST_ID_MISSING'), { status: 502 });
                return accountApi.claimRequest(auth.userId, pipelineId, upstreamRequestId);
              }
              : null,
          });
        }
        return forwardStream({
          ...forward,
          apiKey: auth.apiKey,
          resolveModel: modelCatalog.resolve,
          onRequestId: accountApiMode
            ? (upstreamRequestId) => {
              if (!upstreamRequestId) throw Object.assign(new Error('UPSTREAM_REQUEST_ID_MISSING'), { status: 502 });
              return accountApi.claimRequest(auth.userId, pipelineId, upstreamRequestId);
            }
            : null,
          expanded: ({ stage, readOnly }) => playbooks.expandPlaybook({ stage, readOnly }),
        });
      }

      return sendJson(res, 404, { error: { message: '未知接口。' } });
    } catch (error) {
      if (res.writableEnded || res.destroyed) return undefined;
      const message = String(error?.message || '');
      if (message === 'TOKEN_RATE_LIMIT') {
        metrics.reject('token_account_rate_limit');
        return reject(res, 429, error?.retryAfterSeconds, 'token requests are too frequent');
      }
      if (message.startsWith('TOKEN_')) return sendJson(res, 401, { error: { message: '访问令牌无效或已过期。' } });
      if (message === 'AUTH_LOGIN_INVALID') return sendJson(res, 400, { error: { message: '账户或密码格式无效。' } });
      if (message === 'SUB2API_LOGIN_FAILED' || message === 'ACCOUNT_API_AUTH_FAILED') return sendJson(res, 401, { error: { message: '账户或密码不正确，或账户已被停用。' } });
      if (message === 'ACCOUNT_API_CONFLICT') {
        return sendJson(res, 409, { error: { message: route === '/auth/register' ? '该邮箱已注册。' : '计费请求归属冲突。' } });
      }
      if (message === 'BILLING_PIPELINE_INVALID') return sendJson(res, 400, { error: { message: 'pipelineId 参数无效。' } });
      if (message === 'BODY_TOO_LARGE') return sendJson(res, 413, { error: { message: '请求体过大。' } });
      if (message === 'BODY_TIMEOUT') return sendJson(res, 408, { error: { message: 'request body timeout' } });
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
    billingAdmission.close();
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
      const [modelIdle, billingIdle] = await Promise.all([
        admission.waitForIdle(grace),
        billingAdmission.waitForIdle(grace),
      ]);
      if (modelIdle && billingIdle) {
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
  const host = assertLoopbackBindHost(config.host);
  server.listen(config.port || 8788, host, () => {
    process.stdout.write(`gateway listening on ${host}:${config.port || 8788}\n`);
  });
}

module.exports = { assertLoopbackBindHost, assertSecureServiceUrl, createGateway, createModelResolver, normalizeCatalog, spliceHead };
