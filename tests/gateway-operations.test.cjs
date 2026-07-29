const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { playbookPlaceholder } = require('../electron/hosted/playbook-ref.cjs');
const { createGateway } = require('../gateway/server.cjs');
const {
  createAdmissionQueue,
  createGatewayMetrics,
  createRateLimiter,
  normalizeOperations,
} = require('../gateway/operations.cjs');
const { sealKey, sign } = require('../gateway/tokens.cjs');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function waitFor(check, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await delay(5);
  }
  assert.fail('timed out waiting for condition');
}

test('operations normalize bounded defaults and protect the sliding window', () => {
  const operations = normalizeOperations({
    rateLimit: { windowMs: 1, maxRequests: 0 },
    admission: { maxConcurrent: 999 },
    metrics: { path: 'not-a-path' },
  });
  assert.equal(operations.rateLimit.windowMs, 1_000);
  assert.equal(operations.rateLimit.maxRequests, 1);
  assert.equal(operations.loginRateLimit.maxAttempts, 8);
  assert.equal(operations.admission.maxConcurrent, 128);
  assert.equal(operations.metrics.path, '/metrics');

  let current = 0;
  const limiter = createRateLimiter({ windowMs: 1_000, maxRequests: 2, now: () => current });
  assert.equal(limiter.check('device').allowed, true);
  assert.equal(limiter.check('device').allowed, true);
  const denied = limiter.check('device');
  assert.equal(denied.allowed, false);
  assert.equal(denied.retryAfterSeconds, 1);
  current = 1_001;
  assert.equal(limiter.check('device').allowed, true);
});

test('admission queue bounds, expires, closes, and drains leases', async () => {
  const queue = createAdmissionQueue({ maxConcurrent: 1, maxQueued: 1, queueTimeoutMs: 100 });
  const first = await queue.acquire();
  const second = queue.acquire();
  await assert.rejects(queue.acquire(), (error) => error.code === 'ADMISSION_QUEUE_FULL');
  first.release();
  const secondLease = await second;
  secondLease.release();
  assert.deepEqual(queue.snapshot(), { active: 0, queued: 0, closing: false });

  const expiring = createAdmissionQueue({ maxConcurrent: 1, maxQueued: 1, queueTimeoutMs: 10 });
  const held = await expiring.acquire();
  await assert.rejects(expiring.acquire(), (error) => error.code === 'ADMISSION_QUEUE_TIMEOUT');
  held.release();

  const closing = createAdmissionQueue({ maxConcurrent: 1, maxQueued: 1, queueTimeoutMs: 100 });
  const active = await closing.acquire();
  const waiting = closing.acquire();
  closing.close();
  await assert.rejects(waiting, (error) => error.code === 'ADMISSION_CLOSED');
  active.release();
  assert.equal(await closing.waitForIdle(100), true);
});

test('gateway metrics use bounded labels and omit request identity', () => {
  const metrics = createGatewayMetrics();
  metrics.observeRequest({ route: '/v1/chat/completions', status: 200, durationMs: 51 });
  metrics.observeUpstream({ status: 502, durationMs: 300 });
  metrics.reject('rate_limit');
  const output = metrics.render({ active: 1, queued: 2 });
  assert.match(output, /gateway_http_requests_total\{route="\/v1\/chat\/completions",status_class="2xx"\} 1/);
  assert.match(output, /gateway_admission_queued 2/);
  assert.equal(output.includes('device-test'), false);
  assert.equal(output.includes('request-id'), false);
});

test('gateway limits repeated login attempts before they reach Sub2API', async () => {
  let loginAttempts = 0;
  const upstream = http.createServer((request, response) => {
    if (request.url === '/api/v1/auth/login') {
      loginAttempts += 1;
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end('{"code":401,"message":"invalid"}');
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const upstreamBase = await listen(upstream);
  const gateway = createGateway({
    upstream: upstreamBase,
    portal: 'https://portal.example.com',
    publicBaseUrl: 'https://gw.example.com',
    tokenSecret: 'token-secret-long-enough-for-login-limit-tests',
    keySecret: 'key-secret-long-enough-for-login-limit-tests',
    tiers: [],
    defaultTiers: {},
    sub2api: {
      loginPath: '/api/v1/auth/login',
      profilePath: '/api/v1/user/profile',
      usagePath: '/api/v1/usage/dashboard/stats',
      usageListPath: '/api/v1/usage',
      apiKeysPath: '/api/v1/keys',
    },
    operations: { loginRateLimit: { maxAttempts: 1 } },
    logger: () => {},
  }, { expandPlaybook: () => 'server playbook' });
  const base = await listen(gateway);
  const body = JSON.stringify({ email: 'user@example.com', password: 'wrong-password' });

  try {
    const first = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    assert.equal(first.status, 401);
    const second = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    assert.equal(second.status, 429);
    assert.equal(second.headers.get('retry-after'), '900');
    assert.equal(loginAttempts, 1);
  } finally {
    await new Promise((resolve) => gateway.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test('gateway queues model traffic, protects metrics, and drains on shutdown', async () => {
  const replies = [];
  const started = [];
  const upstream = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      started.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      replies.push(response);
    });
  });
  const upstreamBase = await listen(upstream);
  const tokenSecret = 'token-secret-long-enough-for-operations-tests';
  const keySecret = 'key-secret-long-enough-for-operations-tests';
  const logEntries = [];
  const gateway = createGateway({
    upstream: upstreamBase,
    portal: 'https://portal.example.com',
    publicBaseUrl: 'https://gw.example.com',
    tokenSecret,
    keySecret,
    tiers: [],
    defaultTiers: {},
    sub2api: {
      loginPath: '/api/v1/auth/login',
      profilePath: '/api/v1/user/profile',
      usagePath: '/api/v1/usage/dashboard/stats',
      usageListPath: '/api/v1/usage',
      apiKeysPath: '/api/v1/keys',
    },
    operations: {
      rateLimit: { maxRequests: 10 },
      admission: { maxConcurrent: 1, maxQueued: 1, queueTimeoutMs: 2_000 },
      metrics: { enabled: true, token: 'metrics-test-token' },
    },
    logger: (entry) => logEntries.push(entry),
  }, { expandPlaybook: () => 'server playbook' });
  const base = await listen(gateway);
  const token = sign({
    exp: Math.floor(Date.now() / 1_000) + 60,
    dev: 'device-test',
    k: sealKey('sk-upstream', keySecret),
    c: sealKey('credential', keySecret),
  }, tokenSecret);
  const headers = {
    Authorization: `Bearer ${token}`,
    'X-Device-Id': 'device-test',
    'Content-Type': 'application/json',
  };
  const body = JSON.stringify({ messages: [{ role: 'system', content: playbookPlaceholder({ stage: 'analysis' }) }] });

  try {
    const first = fetch(`${base}/v1/chat/completions`, { method: 'POST', headers, body });
    await waitFor(() => started.length === 1);
    const second = fetch(`${base}/v1/chat/completions`, { method: 'POST', headers, body });
    await delay(25);
    const third = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers, body });
    assert.equal(third.status, 429);
    assert.equal(third.headers.get('retry-after'), '2');

    const firstReply = replies.shift();
    firstReply.writeHead(200, { 'Content-Type': 'application/json', 'X-Request-Id': 'upstream-first' });
    firstReply.end('{"ok":true}');
    const firstResponse = await first;
    assert.equal(firstResponse.status, 200);
    await firstResponse.text();
    await waitFor(() => started.length === 2);

    const unauthorizedMetrics = await fetch(`${base}/metrics`);
    assert.equal(unauthorizedMetrics.status, 401);
    const metricOutput = await fetch(`${base}/metrics`, { headers: { Authorization: 'Bearer metrics-test-token' } }).then((response) => response.text());
    assert.match(metricOutput, /gateway_admission_active 1/);
    assert.match(metricOutput, /gateway_admission_rejections_total\{reason="queue_full"\} 1/);
    assert.equal(metricOutput.includes('device-test'), false);

    const shutdown = gateway.shutdown({ graceMs: 1_000 });
    await delay(25);
    const secondReply = replies.shift();
    secondReply.writeHead(200, { 'Content-Type': 'application/json', 'X-Request-Id': 'upstream-second' });
    secondReply.end('{"ok":true}');
    const secondResponse = await second;
    assert.equal(secondResponse.status, 200);
    await secondResponse.text();
    await shutdown;
    assert.deepEqual(logEntries.find((entry) => entry.event === 'gateway_shutdown_completed'), {
      event: 'gateway_shutdown_completed',
      drained: true,
    });
  } finally {
    if (gateway.listening) await new Promise((resolve) => gateway.close(resolve));
    if (upstream.listening) await new Promise((resolve) => upstream.close(resolve));
  }
});
