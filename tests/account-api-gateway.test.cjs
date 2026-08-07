const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { playbookPlaceholder } = require('../electron/hosted/playbook-ref.cjs');
const { createGateway } = require('../gateway/server.cjs');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function waitFor(check, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('timed out waiting for condition');
}

test('account-api identity mode registers users and relays through the server-owned model key', async () => {
  const upstreamRequests = [];
  const imageRequests = [];
  const accountBillingRequests = [];
  const claimedRequestIds = [];
  const sequence = [];
  const userId = '11111111-1111-4111-8111-111111111111';
  let lateUsageVisible = false;
  let rejectNextRun = false;
  let disconnectNextModel = false;
  let omitNextModelRequestId = false;
  let disconnectNextImage = false;
  let imageReady = true;
  let sessionActive = true;
  let accountReady = false;
  const accountState = {
    id: userId,
    email: 'new@example.com',
    role: 'user',
    status: 'active',
    balance: 10_000,
    currency: 'PTS',
    totalSpend: 0,
  };
  const startCharges = new Set();
  const settledRequestIds = new Set();
  const account = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      if (request.method === 'GET' && request.url === '/health/ready') {
        response.writeHead(accountReady ? 200 : 503, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ ok: accountReady }));
        return;
      }
      if (request.method === 'POST' && (request.url === '/login' || request.url === '/register')) {
        assert.equal(JSON.parse(body).email, 'new@example.com');
        sessionActive = true;
        response.writeHead(request.url === '/register' ? 201 : 200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ token: 'account-token', user: accountState }));
        return;
      }
      if (request.method === 'GET' && request.url === '/me' && request.headers.authorization === 'Bearer account-token' && sessionActive) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ user: accountState }));
        return;
      }
      if (request.method === 'POST' && request.url === '/logout' && request.headers.authorization === 'Bearer account-token') {
        sessionActive = false;
        response.writeHead(204);
        response.end();
        return;
      }
      if (request.method === 'POST' && request.url.startsWith('/internal/billing/') && request.headers.authorization === 'Bearer account-service-token-long-enough-123') {
        const payload = JSON.parse(body);
        accountBillingRequests.push({ url: request.url, payload });
        if (request.url === '/internal/billing/start') {
          sequence.push('start');
          if (rejectNextRun) {
            response.writeHead(402, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ error: 'insufficient_credits' }));
            return;
          }
          assert.deepEqual(payload, { userId, pipelineId: 'pipeline-1' });
          const charged = !startCharges.has(payload.pipelineId);
          if (charged) {
            startCharges.add(payload.pipelineId);
            accountState.balance -= 2000;
            accountState.totalSpend += 2000;
          }
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({
            charged,
            fixedRunCredits: 2000,
            balance: accountState.balance,
            totalSpend: accountState.totalSpend,
            currency: accountState.currency,
          }));
          return;
        }
        if (request.url === '/internal/billing/claim') {
          sequence.push('claim');
          assert.equal(payload.userId, userId);
          assert.equal(payload.pipelineId, 'pipeline-1');
          assert.ok(['relay-request', 'image-request'].includes(payload.requestId));
          claimedRequestIds.push(payload.requestId);
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ claimed: true, requestId: payload.requestId }));
          return;
        }
        if (request.url === '/internal/billing/settle') {
          sequence.push('settle');
          const actualCost = payload.requestCosts.reduce((sum, entry) => sum + Math.ceil(entry.actualCostUsd * 7200), 0);
          for (const entry of payload.requestCosts) {
            if (!settledRequestIds.has(entry.requestId)) {
              settledRequestIds.add(entry.requestId);
              accountState.balance -= Math.ceil(entry.actualCostUsd * 7200);
              accountState.totalSpend += Math.ceil(entry.actualCostUsd * 7200);
            }
          }
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({
            actualCost,
            balance: accountState.balance,
            totalSpend: accountState.totalSpend,
            currency: accountState.currency,
          }));
          return;
        }
      }
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'unauthorized' }));
    });
  });
  const upstream = http.createServer((request, response) => {
    upstreamRequests.push({ url: request.url, authorization: request.headers.authorization || '' });
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (request.url === '/api/v1/auth/login') {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString('utf8')), { email: 'billing@example.com', password: 'billing-password' });
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ code: 0, data: { access_token: 'billing-jwt', user: { email: 'billing@example.com' } } }));
      });
      return;
    }
    if (request.url === '/api/v1/usage?request_id=relay-request&page=1&page_size=20') {
      assert.equal(request.headers.authorization, 'Bearer billing-jwt');
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ code: 0, data: { items: [{ request_id: 'relay-request', actual_cost: 0.125 }] } }));
      return;
    }
    if (request.url === '/api/v1/usage?request_id=req-late&page=1&page_size=20') {
      assert.equal(request.headers.authorization, 'Bearer billing-jwt');
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ code: 0, data: { items: lateUsageVisible ? [{ request_id: 'req-late', actual_cost: 0.25 }] : [] } }));
      return;
    }
    if (request.url === '/api/v1/usage?request_id=image-request&page=1&page_size=20') {
      assert.equal(request.headers.authorization, 'Bearer billing-jwt');
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ code: 0, data: { items: [{ request_id: 'image-request', actual_cost: 0.05 }] } }));
      return;
    }
    sequence.push('model');
    if (omitNextModelRequestId) {
      omitNextModelRequestId = false;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'missing id' } }] }));
      return;
    }
    if (disconnectNextModel) {
      disconnectNextModel = false;
      response.writeHead(200, { 'Content-Type': 'application/json', 'X-Request-Id': 'relay-disconnect' });
      response.write('{"choices":[');
      response.destroy();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json', 'X-Request-Id': 'relay-request' });
    response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
  });
  const imageGateway = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: imageReady }));
      return;
    }
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      imageRequests.push({
        url: request.url,
        authorization: request.headers.authorization || '',
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      });
      if (disconnectNextImage) {
        disconnectNextImage = false;
        response.writeHead(200, { 'Content-Type': 'application/json', 'X-Request-Id': 'image-disconnect' });
        response.write('{"data":[');
        response.destroy();
        return;
      }
      response.writeHead(200, {
        'Content-Type': 'application/json',
        ...(imageRequests.length === 1 ? { 'X-Request-Id': 'image-request' } : {}),
      });
      response.end(JSON.stringify({ data: [{ b64_json: 'cG5n' }] }));
    });
  });
  const accountBase = await listen(account);
  const upstreamBase = await listen(upstream);
  const imageGatewayBase = await listen(imageGateway);
  const gateway = createGateway({
    upstream: upstreamBase,
    portal: 'https://portal.example.com',
    publicBaseUrl: 'https://gw.example.com',
    tokenSecret: 'token-secret-long-enough-for-tests',
    keySecret: 'key-secret-long-enough-for-tests',
    serviceApiKey: 'relay-api-key',
    imageGatewayBaseUrl: imageGatewayBase,
    identityProvider: { mode: 'account-api', baseUrl: accountBase, serviceToken: 'account-service-token-long-enough-123' },
    tiers: [{ id: 'standard', label: 'Standard', models: { reasoning: 'r', coding: 'c', writing: 'w', image: 'gpt-image-2' } }],
    defaultTiers: { reasoning: 'standard', coding: 'standard', writing: 'standard', image: 'standard' },
    imageEnabled: true,
    maxImagesPerStage: 1,
    sub2api: {
      loginPath: '/api/v1/auth/login',
      profilePath: '/api/v1/user/profile',
      usagePath: '/api/v1/usage/dashboard/stats',
      usageListPath: '/api/v1/usage',
      apiKeysPath: '/api/v1/keys',
      topUpPath: '/purchase',
      topUpEnabled: false,
      billingService: { email: 'billing@example.com', password: 'billing-password' },
    },
    operations: {
      tokenRateLimit: { maxAttempts: 1 },
      billingRateLimit: { maxRequests: 2 },
    },
  }, { expandPlaybook: () => 'server playbook' });
  const gatewayBase = await listen(gateway);
  try {
    assert.equal((await fetch(`${gatewayBase}/health`)).status, 200);
    assert.equal((await fetch(`${gatewayBase}/ready`)).status, 503);
    accountReady = true;
    imageReady = false;
    assert.equal((await fetch(`${gatewayBase}/ready`)).status, 503);
    imageReady = true;
    const ready = await fetch(`${gatewayBase}/ready`);
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), { ok: true });
    const registrationResponse = await fetch(`${gatewayBase}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'new@example.com', password: 'long-password' }),
    });
    assert.equal(registrationResponse.headers.get('cache-control'), 'no-store');
    assert.equal(registrationResponse.headers.get('pragma'), 'no-cache');
    const registration = await registrationResponse.json();
    assert.equal(registration.email, 'new@example.com');
    const tokenResponse = await fetch(`${gatewayBase}/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${registration.credential}` },
      body: JSON.stringify({ deviceId: 'device-1' }),
    });
    assert.equal(tokenResponse.headers.get('cache-control'), 'no-store');
    assert.equal(tokenResponse.headers.get('pragma'), 'no-cache');
    const token = await tokenResponse.json();
    const rotatedToken = await fetch(`${gatewayBase}/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${registration.credential}` },
      body: JSON.stringify({ deviceId: 'device-2' }),
    });
    assert.equal(rotatedToken.status, 429);
    const headers = { Authorization: `Bearer ${token.accessToken}`, 'X-Device-Id': 'device-1' };
    const profile = await fetch(`${gatewayBase}/account`, { headers }).then((response) => response.json());
    assert.equal(profile.email, 'new@example.com');
    const model = await fetch(`${gatewayBase}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', 'X-Pipeline-Id': 'pipeline-1' },
      body: JSON.stringify({ messages: [{ role: 'system', content: playbookPlaceholder({ stage: 'analysis' }) }] }),
    });
    assert.equal(model.status, 200);
    assert.deepEqual(await model.json(), { choices: [{ message: { role: 'assistant', content: 'ok' } }] });
    await waitFor(() => sequence.includes('claim'));
    assert.equal(upstreamRequests.find((request) => request.url === '/v1/chat/completions').authorization, 'Bearer relay-api-key');
    const startIndex = sequence.lastIndexOf('start');
    const modelIndex = sequence.indexOf('model', startIndex);
    const claimIndex = sequence.indexOf('claim', modelIndex);
    assert.ok(startIndex >= 0 && modelIndex > startIndex && claimIndex > modelIndex);
    omitNextModelRequestId = true;
    const missingModelRequestId = await fetch(`${gatewayBase}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', 'X-Pipeline-Id': 'pipeline-1' },
      body: JSON.stringify({ messages: [{ role: 'system', content: playbookPlaceholder({ stage: 'analysis' }) }] }),
    });
    assert.equal(missingModelRequestId.status, 502);
    disconnectNextModel = true;
    const failedModel = await fetch(`${gatewayBase}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', 'X-Pipeline-Id': 'pipeline-1' },
      body: JSON.stringify({ messages: [{ role: 'system', content: playbookPlaceholder({ stage: 'analysis' }) }] }),
    });
    assert.equal(failedModel.status, 502);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(claimedRequestIds, ['relay-request']);
    const imagePayload = { model: 'gpt-image-2', prompt: '数学建模机制图', size: '1024x1024' };
    const image = await fetch(`${gatewayBase}/v1/images/generations`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', 'X-Pipeline-Id': 'pipeline-1' },
      body: JSON.stringify(imagePayload),
    });
    assert.equal(image.status, 200);
    assert.deepEqual(await image.json(), { data: [{ b64_json: 'cG5n' }] });
    assert.deepEqual(imageRequests, [{
      url: '/v1/images/generations',
      authorization: 'Bearer image-gateway',
      body: imagePayload,
    }]);
    disconnectNextImage = true;
    const failedImage = await fetch(`${gatewayBase}/v1/images/generations`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', 'X-Pipeline-Id': 'pipeline-1' },
      body: JSON.stringify(imagePayload),
    });
    assert.equal(failedImage.status, 502);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(claimedRequestIds, ['relay-request', 'image-request']);
    const unclaimedImage = await fetch(`${gatewayBase}/v1/images/generations`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', 'X-Pipeline-Id': 'pipeline-1' },
      body: JSON.stringify({ ...imagePayload, prompt: 'missing upstream request id' }),
    });
    assert.equal(unclaimedImage.status, 502);
    assert.deepEqual(claimedRequestIds, ['relay-request', 'image-request']);
    assert.equal(upstreamRequests.filter((request) => request.url === '/v1/chat/completions').length, 3);
    const billing = await fetch(`${gatewayBase}/billing`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ pipelineId: 'pipeline-1', requestIds: ['relay-request', 'image-request', 'req-late'] }),
    }).then((response) => response.json());
    assert.deepEqual(billing, { actualCost: 1260, balance: 6740, currency: 'PTS', complete: false, missingRequestIds: ['req-late'] });
    assert.deepEqual(accountBillingRequests.at(-1).payload.requestCosts, [
      { requestId: 'relay-request', actualCostUsd: 0.125 },
      { requestId: 'image-request', actualCostUsd: 0.05 },
    ]);

    lateUsageVisible = true;
    const completedBilling = await fetch(`${gatewayBase}/billing`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ pipelineId: 'pipeline-1', requestIds: ['relay-request', 'image-request', 'req-late'] }),
    }).then((response) => response.json());
    assert.equal(completedBilling.complete, true);
    assert.deepEqual(completedBilling.missingRequestIds, []);
    assert.equal(completedBilling.actualCost, 3060);
    assert.equal(completedBilling.balance, 4940);

    const rateLimitedBilling = await fetch(`${gatewayBase}/billing`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ pipelineId: 'pipeline-1', requestIds: ['relay-request'] }),
    });
    assert.equal(rateLimitedBilling.status, 429);

    rejectNextRun = true;
    const modelRequestsBeforeRejection = upstreamRequests.filter((request) => request.url === '/v1/chat/completions').length;
    const rejected = await fetch(`${gatewayBase}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', 'X-Pipeline-Id': 'pipeline-2' },
      body: JSON.stringify({ messages: [{ role: 'system', content: playbookPlaceholder({ stage: 'analysis' }) }] }),
    });
    assert.equal(rejected.status, 402);
    assert.equal(upstreamRequests.filter((request) => request.url === '/v1/chat/completions').length, modelRequestsBeforeRejection);

    const logout = await fetch(`${gatewayBase}/auth/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${registration.credential}` },
    });
    assert.equal(logout.status, 200);
    const revoked = await fetch(`${gatewayBase}/catalog`, { headers });
    assert.equal(revoked.status, 401);
  } finally {
    await close(gateway);
    await close(imageGateway);
    await close(upstream);
    await close(account);
  }
});
