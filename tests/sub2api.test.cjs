const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createSub2apiAdapter } = require('../gateway/sub2api.cjs');
const gatewayConfig = require('../gateway/config.example.json');

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

test('sub2api adapter rejects a successful HTTP response with the wrong envelope', async () => {
  await withJsonServer({
    [PATHS.loginPath]: { code: 0, message: 'success', data: { token: 'legacy-token' } },
  }, async (base) => {
    const adapter = createSub2apiAdapter({ base, paths: PATHS });
    await assert.rejects(adapter.login('user@example.com', 'password'), /SUB2API_LOGIN_SHAPE/);
  });
});

test('sub2api adapter rejects incomplete endpoint configuration at startup', () => {
  assert.throws(
    () => createSub2apiAdapter({ base: 'http://127.0.0.1:18080', paths: { ...PATHS, usagePath: '' } }),
    /SUB2API_CONFIG_INVALID:usagePath/,
  );
});

test('hosted reasoning catalog uses the current GPT-5.6-SOL route', () => {
  assert.equal(gatewayConfig.tiers[0].models.reasoning, 'gpt-5.6-sol');
  assert.equal(gatewayConfig.tiers[0].models.writing, 'gpt-5.6-sol');
  assert.equal(gatewayConfig.tiers[0].models.image, 'gpt-image-2');
  assert.equal(gatewayConfig.sub2api.topUpPath, '/purchase');
  assert.equal(gatewayConfig.sub2api.topUpEnabled, false);
});
