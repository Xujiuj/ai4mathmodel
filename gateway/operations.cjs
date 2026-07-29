const crypto = require('node:crypto');

const HISTOGRAM_BUCKETS_MS = Object.freeze([50, 100, 250, 500, 1_000, 2_500, 5_000, 15_000, 60_000, 300_000, 600_000]);

function boundedNumber(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.floor(number), minimum), maximum);
}

function normalizeOperations(raw = {}) {
  const rateLimit = raw.rateLimit || {};
  const loginRateLimit = raw.loginRateLimit || {};
  const admission = raw.admission || {};
  const metrics = raw.metrics || {};
  const metricsPath = String(metrics.path || '/metrics').trim();
  return {
    rateLimit: {
      windowMs: boundedNumber(rateLimit.windowMs, 60_000, 1_000, 3_600_000),
      maxRequests: boundedNumber(rateLimit.maxRequests, 30, 1, 10_000),
      maxTrackedDevices: boundedNumber(rateLimit.maxTrackedDevices, 10_000, 100, 1_000_000),
    },
    loginRateLimit: {
      windowMs: boundedNumber(loginRateLimit.windowMs, 900_000, 60_000, 3_600_000),
      maxAttempts: boundedNumber(loginRateLimit.maxAttempts, 8, 1, 100),
      maxTrackedIdentities: boundedNumber(loginRateLimit.maxTrackedIdentities, 10_000, 100, 1_000_000),
      trustProxy: loginRateLimit.trustProxy === true,
    },
    admission: {
      maxConcurrent: boundedNumber(admission.maxConcurrent, 4, 1, 128),
      maxQueued: boundedNumber(admission.maxQueued, 24, 0, 10_000),
      queueTimeoutMs: boundedNumber(admission.queueTimeoutMs, 300_000, 1_000, 900_000),
    },
    shutdownGraceMs: boundedNumber(raw.shutdownGraceMs, 30_000, 1_000, 900_000),
    metrics: {
      enabled: metrics.enabled === true,
      path: /^\/[A-Za-z0-9._/-]{1,120}$/.test(metricsPath) ? metricsPath : '/metrics',
      token: String(metrics.token || '').trim().slice(0, 512),
    },
  };
}

function admissionError(code, retryAfterSeconds = 1) {
  const error = new Error(code);
  error.code = code;
  error.retryAfterSeconds = Math.max(1, Math.ceil(Number(retryAfterSeconds) || 1));
  return error;
}

function createRateLimiter({ windowMs = 60_000, maxRequests = 30, maxTrackedDevices = 10_000, now = () => Date.now() } = {}) {
  const entries = new Map();

  function compact(key, timestamps, current) {
    const cutoff = current - windowMs;
    while (timestamps.length && timestamps[0] <= cutoff) timestamps.shift();
    if (!timestamps.length) entries.delete(key);
  }

  function check(identity) {
    const key = String(identity || 'anonymous').slice(0, 160);
    const current = now();
    const timestamps = entries.get(key) || [];
    compact(key, timestamps, current);
    if (timestamps.length >= maxRequests) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((timestamps[0] + windowMs - current) / 1_000)),
      };
    }
    if (!entries.has(key) && entries.size >= maxTrackedDevices) {
      const oldestKey = entries.keys().next().value;
      if (oldestKey) entries.delete(oldestKey);
    }
    timestamps.push(current);
    entries.delete(key);
    entries.set(key, timestamps);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  return { check, size: () => entries.size };
}

function createAdmissionQueue({ maxConcurrent = 4, maxQueued = 24, queueTimeoutMs = 300_000 } = {}) {
  let active = 0;
  let closing = false;
  const queue = [];
  const idleWaiters = new Set();

  function notifyIdle() {
    if (active || queue.length) return;
    for (const resolve of idleWaiters) resolve(true);
    idleWaiters.clear();
  }

  function remove(entry) {
    const index = queue.indexOf(entry);
    if (index >= 0) queue.splice(index, 1);
    clearTimeout(entry.timer);
    entry.signal?.removeEventListener?.('abort', entry.onAbort);
  }

  function lease() {
    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        active = Math.max(0, active - 1);
        drain();
        notifyIdle();
      },
    };
  }

  function start(entry) {
    remove(entry);
    active += 1;
    entry.resolve(lease());
  }

  function drain() {
    while (!closing && active < maxConcurrent && queue.length) start(queue[0]);
  }

  function acquire({ signal } = {}) {
    if (closing) return Promise.reject(admissionError('ADMISSION_CLOSED', 1));
    if (signal?.aborted) return Promise.reject(admissionError('ADMISSION_CANCELLED', 1));
    if (active < maxConcurrent) {
      active += 1;
      return Promise.resolve(lease());
    }
    if (queue.length >= maxQueued) return Promise.reject(admissionError('ADMISSION_QUEUE_FULL', queueTimeoutMs / 1_000));
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, signal, timer: null, onAbort: null };
      entry.onAbort = () => {
        remove(entry);
        reject(admissionError('ADMISSION_CANCELLED', 1));
        notifyIdle();
      };
      entry.timer = setTimeout(() => {
        remove(entry);
        reject(admissionError('ADMISSION_QUEUE_TIMEOUT', queueTimeoutMs / 1_000));
        notifyIdle();
      }, queueTimeoutMs);
      signal?.addEventListener?.('abort', entry.onAbort, { once: true });
      queue.push(entry);
    });
  }

  function close() {
    if (closing) return;
    closing = true;
    for (const entry of queue.splice(0)) {
      clearTimeout(entry.timer);
      entry.signal?.removeEventListener?.('abort', entry.onAbort);
      entry.reject(admissionError('ADMISSION_CLOSED', 1));
    }
    notifyIdle();
  }

  function waitForIdle(timeoutMs) {
    if (!active && !queue.length) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        idleWaiters.delete(done);
        resolve(false);
      }, Math.max(1, Number(timeoutMs) || 1));
      timer.unref?.();
      const done = () => {
        clearTimeout(timer);
        resolve(true);
      };
      idleWaiters.add(done);
    });
  }

  return {
    acquire,
    close,
    snapshot: () => ({ active, queued: queue.length, closing }),
    waitForIdle,
  };
}

function statusClass(status) {
  const value = Number(status) || 500;
  return `${Math.floor(value / 100)}xx`;
}

function escapeLabel(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function labels(values) {
  const entries = Object.entries(values || {});
  if (!entries.length) return '';
  return `{${entries.map(([key, value]) => `${key}="${escapeLabel(value)}"`).join(',')}}`;
}

function histogram(map, durationMs, labelValues) {
  const key = JSON.stringify(labelValues);
  let item = map.get(key);
  if (!item) {
    item = { labels: labelValues, count: 0, sum: 0, buckets: HISTOGRAM_BUCKETS_MS.map(() => 0) };
    map.set(key, item);
  }
  item.count += 1;
  item.sum += Math.max(0, Number(durationMs) || 0);
  HISTOGRAM_BUCKETS_MS.forEach((bucket, index) => {
    if (durationMs <= bucket) item.buckets[index] += 1;
  });
}

function renderHistogram(lines, name, help, map) {
  lines.push(`# HELP ${name} ${help}`);
  lines.push(`# TYPE ${name} histogram`);
  for (const item of map.values()) {
    HISTOGRAM_BUCKETS_MS.forEach((bucket, index) => {
      lines.push(`${name}_bucket${labels({ ...item.labels, le: bucket })} ${item.buckets[index]}`);
    });
    lines.push(`${name}_bucket${labels({ ...item.labels, le: '+Inf' })} ${item.count}`);
    lines.push(`${name}_sum${labels(item.labels)} ${item.sum}`);
    lines.push(`${name}_count${labels(item.labels)} ${item.count}`);
  }
}

function createGatewayMetrics() {
  const requests = new Map();
  const requestDurations = new Map();
  const upstream = new Map();
  const upstreamDurations = new Map();
  const rejections = new Map();

  function increment(map, labelValues) {
    const key = JSON.stringify(labelValues);
    const item = map.get(key) || { labels: labelValues, value: 0 };
    item.value += 1;
    map.set(key, item);
  }

  return {
    observeRequest({ route, status, durationMs }) {
      const labelValues = { route, status_class: statusClass(status) };
      increment(requests, labelValues);
      histogram(requestDurations, durationMs, { route });
    },
    observeUpstream({ status, durationMs }) {
      const labelValues = { status_class: statusClass(status) };
      increment(upstream, labelValues);
      histogram(upstreamDurations, durationMs, {});
    },
    reject(reason) {
      increment(rejections, { reason: String(reason || 'unknown').slice(0, 40) });
    },
    render(admission) {
      const lines = [];
      lines.push('# HELP gateway_http_requests_total HTTP requests completed by route and status class.');
      lines.push('# TYPE gateway_http_requests_total counter');
      for (const item of requests.values()) lines.push(`gateway_http_requests_total${labels(item.labels)} ${item.value}`);
      renderHistogram(lines, 'gateway_http_request_duration_milliseconds', 'HTTP request duration in milliseconds.', requestDurations);
      lines.push('# HELP gateway_upstream_requests_total Upstream requests completed by status class.');
      lines.push('# TYPE gateway_upstream_requests_total counter');
      for (const item of upstream.values()) lines.push(`gateway_upstream_requests_total${labels(item.labels)} ${item.value}`);
      renderHistogram(lines, 'gateway_upstream_request_duration_milliseconds', 'Upstream request duration in milliseconds.', upstreamDurations);
      lines.push('# HELP gateway_admission_rejections_total Requests rejected by admission control.');
      lines.push('# TYPE gateway_admission_rejections_total counter');
      for (const item of rejections.values()) lines.push(`gateway_admission_rejections_total${labels(item.labels)} ${item.value}`);
      lines.push('# HELP gateway_admission_active Active upstream admissions.');
      lines.push('# TYPE gateway_admission_active gauge');
      lines.push(`gateway_admission_active ${admission.active}`);
      lines.push('# HELP gateway_admission_queued Requests waiting for upstream admission.');
      lines.push('# TYPE gateway_admission_queued gauge');
      lines.push(`gateway_admission_queued ${admission.queued}`);
      return `${lines.join('\n')}\n`;
    },
  };
}

function createRequestId() {
  return crypto.randomUUID();
}

function anonymizeIdentity(identity, secret) {
  return crypto.createHmac('sha256', String(secret || 'gateway')).update(String(identity || '')).digest('hex').slice(0, 16);
}

module.exports = {
  anonymizeIdentity,
  createAdmissionQueue,
  createGatewayMetrics,
  createRateLimiter,
  createRequestId,
  normalizeOperations,
};
