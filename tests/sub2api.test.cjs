const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const { createSub2apiAdapter } = require('../gateway/sub2api.cjs');
const gatewayConfig = require('../gateway/config.example.json');
const {
  SAME_ACCOUNT_RETRY_COUNT,
  SAME_ACCOUNT_RETRY_STATUS_CODES,
  accountCredentials,
  buildSyncSql,
} = require('../deploy/hermes/sub2api/sync-upstream-accounts.cjs');

const PATHS = {
  loginPath: '/api/v1/auth/login',
  profilePath: '/api/v1/user/profile',
  usagePath: '/api/v1/usage/dashboard/stats',
  usageListPath: '/api/v1/usage',
  apiKeysPath: '/api/v1/keys',
};

async function withJsonServer(responses, run) {
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization || '',
        body: body ? JSON.parse(body) : null,
      });
      const payload = responses[request.url];
      response.writeHead(payload ? 200 : 404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(payload || { code: 404, message: 'not found' }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    return await run(`http://127.0.0.1:${address.port}`, requests);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

test('sub2api adapter maps the current login envelope exactly', async () => {
  await withJsonServer({
    [PATHS.loginPath]: {
      code: 0,
      message: 'success',
      data: { access_token: 'jwt-token', user: { email: 'user@example.com' } },
    },
  }, async (base, requests) => {
    const adapter = createSub2apiAdapter({ base, paths: PATHS });
    assert.deepEqual(await adapter.login('user@example.com', 'password'), {
      token: 'jwt-token',
      email: 'user@example.com',
    });
    assert.deepEqual(requests, [{
      method: 'POST',
      url: PATHS.loginPath,
      authorization: '',
      body: { email: 'user@example.com', password: 'password' },
    }]);
  });
});

test('sub2api adapter combines profile balance with dashboard actual spend', async () => {
  await withJsonServer({
    [PATHS.profilePath]: {
      code: 0,
      message: 'success',
      data: { email: 'user@example.com', balance: 12.5 },
    },
    [PATHS.usagePath]: {
      code: 0,
      message: 'success',
      data: { total_actual_cost: 4.75, total_cost: 5.25 },
    },
  }, async (base, requests) => {
    const adapter = createSub2apiAdapter({ base, paths: PATHS });
    assert.deepEqual(await adapter.profile('jwt-token'), {
      email: 'user@example.com',
      balance: 12.5,
      totalSpend: 4.75,
      currency: 'USD',
    });
    assert.deepEqual(requests.map(({ url }) => url).sort(), [PATHS.profilePath, PATHS.usagePath].sort());
    assert.equal(requests.every(({ authorization }) => authorization === 'Bearer jwt-token'), true);
  });
});

test('sub2api adapter selects only active keys from the current paginated envelope', async () => {
  await withJsonServer({
    [PATHS.apiKeysPath]: {
      code: 0,
      message: 'success',
      data: {
        items: [
          { key: 'sk-inactive', status: 'inactive' },
          { key: 'sk-active', status: 'active' },
        ],
        total: 2,
        page: 1,
        page_size: 20,
        pages: 1,
      },
    },
  }, async (base, requests) => {
    const adapter = createSub2apiAdapter({ base, paths: PATHS });
    assert.equal(await adapter.primaryApiKey('jwt-token'), 'sk-active');
    assert.equal(requests[0].url, '/api/v1/keys');
    assert.equal(requests[0].authorization, 'Bearer jwt-token');
  });
});

test('sub2api adapter sums actual costs by request id and returns the latest balance', async () => {
  await withJsonServer({
    [PATHS.profilePath]: {
      code: 0,
      message: 'success',
      data: { email: 'user@example.com', balance: 8.25 },
    },
    [`${PATHS.usageListPath}?request_id=req-1&page=1&page_size=20`]: {
      code: 0,
      message: 'success',
      data: { items: [{ request_id: 'req-1', actual_cost: '0.125' }] },
    },
    [`${PATHS.usageListPath}?request_id=req-2&page=1&page_size=20`]: {
      code: 0,
      message: 'success',
      data: { items: [{ request_id: 'req-2', actual_cost: 0.375 }] },
    },
  }, async (base, requests) => {
    const adapter = createSub2apiAdapter({ base, paths: PATHS });
    assert.deepEqual(await adapter.billing('jwt-token', ['req-1', 'req-2', 'req-1']), {
      actualCost: 0.5,
      balance: 8.25,
      currency: 'USD',
      complete: true,
      missingRequestIds: [],
    });
    assert.equal(requests.length, 3);
    assert.equal(requests.every(({ authorization }) => authorization === 'Bearer jwt-token'), true);
  });
});

test('sub2api billing reports request ids that are not visible yet', async () => {
  await withJsonServer({
    [PATHS.profilePath]: { code: 0, message: 'success', data: { balance: 5 } },
    [`${PATHS.usageListPath}?request_id=req-late&page=1&page_size=20`]: {
      code: 0,
      message: 'success',
      data: { items: [] },
    },
  }, async (base) => {
    const adapter = createSub2apiAdapter({ base, paths: PATHS });
    const result = await adapter.billing('jwt-token', ['req-late']);
    assert.equal(result.complete, false);
    assert.deepEqual(result.missingRequestIds, ['req-late']);
  });
});

test('sub2api service billing uses server credentials and returns per-request costs', async () => {
  await withJsonServer({
    [PATHS.loginPath]: {
      code: 0,
      message: 'success',
      data: { access_token: 'service-jwt', user: { email: 'billing@example.com' } },
    },
    [`${PATHS.usageListPath}?request_id=req-visible&page=1&page_size=20`]: {
      code: 0,
      message: 'success',
      data: { items: [{ request_id: 'req-visible', actual_cost: '0.125' }] },
    },
    [`${PATHS.usageListPath}?request_id=req-pending&page=1&page_size=20`]: {
      code: 0,
      message: 'success',
      data: { items: [] },
    },
  }, async (base, requests) => {
    const adapter = createSub2apiAdapter({
      base,
      paths: PATHS,
      billingService: { email: 'billing@example.com', password: 'billing-password' },
    });
    assert.deepEqual(await adapter.serviceRequestCosts(['req-visible', 'req-pending']), {
      requestCosts: [{ requestId: 'req-visible', actualCostUsd: 0.125 }],
      complete: false,
      missingRequestIds: ['req-pending'],
    });
    await adapter.serviceRequestCosts(['req-visible']);
    assert.equal(requests.filter((request) => request.url === PATHS.loginPath).length, 1);
    assert.equal(requests.filter((request) => request.url.startsWith(PATHS.usageListPath))
      .every((request) => request.authorization === 'Bearer service-jwt'), true);
  });
});

test('sub2api adapter rejects a successful HTTP response with the wrong envelope', async () => {
  await withJsonServer({
    [PATHS.loginPath]: { code: 0, message: 'success', data: { token: 'legacy-token' } },
  }, async (base) => {
    const adapter = createSub2apiAdapter({ base, paths: PATHS });
    await assert.rejects(adapter.login('user@example.com', 'password'), /SUB2API_LOGIN_SHAPE/);
  });
});

test('sub2api readiness requires an explicit ok true JSON response', async () => {
  await withJsonServer({ '/health': { ok: false } }, async (base) => {
    const adapter = createSub2apiAdapter({ base, paths: { ...PATHS, healthPath: '/health' } });
    await assert.rejects(adapter.ready(), /SUB2API_UNAVAILABLE/);
  });
});

test('sub2api billing bounds concurrent usage lookups', async () => {
  let active = 0;
  let peak = 0;
  const server = http.createServer((request, response) => {
    if (!request.url.startsWith(PATHS.usageListPath)) {
      response.writeHead(404);
      response.end();
      return;
    }
    active += 1;
    peak = Math.max(peak, active);
    setTimeout(() => {
      active -= 1;
      const requestId = new URL(request.url, 'http://127.0.0.1').searchParams.get('request_id');
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ code: 0, data: { items: [{ request_id: requestId, actual_cost: 0.01 }] } }));
    }, 10);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const adapter = createSub2apiAdapter({ base, paths: PATHS, billingConcurrency: 3 });
    const result = await adapter.requestCosts('jwt-token', Array.from({ length: 72 }, (_, index) => `req-${index}`));
    assert.equal(result.requestCosts.length, 72);
    assert.equal(peak, 3);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('sub2api adapter rejects incomplete endpoint configuration at startup', () => {
  assert.throws(
    () => createSub2apiAdapter({ base: 'http://127.0.0.1:18080', paths: { ...PATHS, usagePath: '' } }),
    /SUB2API_CONFIG_INVALID:usagePath/,
  );
});

test('hosted catalog fixes the approved model roles', () => {
  assert.equal(gatewayConfig.tiers[0].models.reasoning, 'gpt-5.6-sol');
  assert.equal(gatewayConfig.tiers[0].models.coding, 'gpt-5.6-terra');
  assert.equal(gatewayConfig.tiers[0].models.writing, 'claude-sonnet-5');
  assert.equal(gatewayConfig.tiers[0].models.image, 'gpt-image-2');
  assert.equal(gatewayConfig.sub2api.topUpPath, '/purchase');
  assert.equal(gatewayConfig.sub2api.topUpEnabled, false);
});

test('Hermes upstream accounts retry a Quya 502 five times before pool failover', () => {
  const credentials = accountCredentials({
    token: 'test-quya-token-at-least-twelve-characters',
    modelMapping: { 'gpt-5.6-sol': 'gpt-5.6-sol' },
  });
  assert.equal(credentials.pool_mode, true);
  assert.equal(credentials.pool_mode_retry_count, 5);
  assert.deepEqual(credentials.pool_mode_retry_status_codes, [502]);
  assert.equal(SAME_ACCOUNT_RETRY_COUNT, 5);
  assert.deepEqual(SAME_ACCOUNT_RETRY_STATUS_CODES, [502]);

  const sql = buildSyncSql({
    baseUrl: 'https://api.quya.org/v1',
    groupId: 1,
    groupName: 'standard-group',
    gptToken: 'test-gpt-token-at-least-twelve-characters',
    claudeToken: 'test-claude-token-at-least-twelve-characters',
  });
  // Each of the three accounts is represented in both the update and insert branches.
  assert.equal((sql.match(/"pool_mode":true/g) || []).length, 6);
  assert.equal((sql.match(/"pool_mode_retry_count":5/g) || []).length, 6);
  assert.equal((sql.match(/"pool_mode_retry_status_codes":\[502\]/g) || []).length, 6);
});

test('Sub2API hardening does not trust fixed container names or placeholder Redis secrets', () => {
  const harden = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'hermes', 'sub2api', 'harden.sh'), 'utf8');
  assert.match(harden, /umask 077/);
  assert.match(harden, /REDIS_PASSWORD=\[\^\[:space:\]\]\{32,\}/);
  assert.match(harden, /compose .* ps -q redis/);
  assert.match(harden, /compose .* ps -q sub2api/);
  assert.doesNotMatch(harden, /docker exec sub2api-redis/);
  assert.doesNotMatch(harden, /docker inspect sub2api /);
});
