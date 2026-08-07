const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { assertSecureServiceUrl, createGateway } = require('../gateway/server.cjs');
const { sealKey, sign } = require('../gateway/tokens.cjs');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function token() {
  return sign({
    exp: Math.floor(Date.now() / 1000) + 60,
    dev: 'device-1',
    k: sealKey('upstream-key', 'key-secret'),
    c: sealKey('credential', 'key-secret'),
  }, 'token-secret');
}

test('gateway service URLs require HTTPS unless they are loopback', () => {
  assert.equal(assertSecureServiceUrl('https://account.example.com/api').protocol, 'https:');
  assert.equal(assertSecureServiceUrl('http://127.0.0.1:18090').hostname, '127.0.0.1');
  assert.equal(assertSecureServiceUrl('http://localhost:18090').hostname, 'localhost');
  assert.throws(() => assertSecureServiceUrl('http://account.example.com'), /HTTPS/);
  assert.throws(() => assertSecureServiceUrl('https://token:secret@account.example.com'), /HTTPS/);
});

async function startGateway({ imageEnabled = true, maxImagesPerStage = 1, responseBytes = 0, maxImageResponseBytes } = {}) {
  const imageRequests = [];
  const imageGateway = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      if (responseBytes) {
        const body = Buffer.alloc(responseBytes, 0x78);
        response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': body.length });
        response.end(body);
        return;
      }
      imageRequests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      response.writeHead(200, { 'Content-Type': 'application/json', 'X-Request-Id': 'image-policy-request' });
      response.end(JSON.stringify({ data: [{ b64_json: 'cG5n' }] }));
    });
  });
  const upstream = http.createServer((request, response) => {
    response.writeHead(404);
    response.end();
  });
  const imageBase = await listen(imageGateway);
  const upstreamBase = await listen(upstream);
  const gateway = createGateway({
    upstream: upstreamBase,
    imageGatewayBaseUrl: imageBase,
    portal: 'https://portal.example.com',
    publicBaseUrl: 'https://gw.example.com',
    tokenSecret: 'token-secret',
    keySecret: 'key-secret',
    imageEnabled,
    maxImagesPerStage,
    tiers: [{ id: 'standard', models: { image: 'image-model' } }],
    defaultTiers: { image: 'standard' },
    ...(maxImageResponseBytes ? { maxImageResponseBytes } : {}),
    sub2api: {
      loginPath: '/login',
      profilePath: '/profile',
      usagePath: '/usage',
      usageListPath: '/usage/list',
      apiKeysPath: '/keys',
      topUpEnabled: false,
    },
  }, { expandPlaybook: () => 'playbook' });
  const gatewayBase = await listen(gateway);
  return {
    gateway,
    imageGateway,
    upstream,
    gatewayBase,
    imageRequests,
  };
}

async function requestImage(gatewayBase, payload) {
  return fetch(`${gatewayBase}/v1/images/generations`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token()}`,
      'X-Device-Id': 'device-1',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
}

test('gateway enforces image availability and per-request count before relaying', async () => {
  const disabled = await startGateway({ imageEnabled: false });
  try {
    const response = await requestImage(disabled.gatewayBase, { model: 'image-model', prompt: 'disabled' });
    assert.equal(response.status, 404);
    assert.equal(disabled.imageRequests.length, 0);
  } finally {
    await close(disabled.gateway);
    await close(disabled.imageGateway);
    await close(disabled.upstream);
  }

  const enabled = await startGateway({ maxImagesPerStage: 2 });
  try {
    const tooMany = await requestImage(enabled.gatewayBase, { model: 'image-model', prompt: 'too many', n: 3 });
    assert.equal(tooMany.status, 400);
    assert.equal(enabled.imageRequests.length, 0);

    const malformed = await requestImage(enabled.gatewayBase, { model: 'image-model', prompt: 'malformed', n: '2' });
    assert.equal(malformed.status, 400);
    assert.equal(enabled.imageRequests.length, 0);

    const legitimate = await requestImage(enabled.gatewayBase, { model: 'image-model', prompt: 'two images', n: 2 });
    assert.equal(legitimate.status, 200);
    assert.deepEqual(enabled.imageRequests, [{ model: 'image-model', prompt: 'two images', n: 2 }]);
  } finally {
    await close(enabled.gateway);
    await close(enabled.imageGateway);
    await close(enabled.upstream);
  }
});

test('gateway rejects oversized upstream image responses before relaying', async () => {
  const fixture = await startGateway({ responseBytes: 65, maxImageResponseBytes: 64 });
  try {
    const response = await requestImage(fixture.gatewayBase, { model: 'image-model', prompt: 'oversized' });
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: { message: 'image response exceeds gateway limit' } });
    assert.equal(fixture.imageRequests.length, 0);
  } finally {
    await close(fixture.gateway);
    await close(fixture.imageGateway);
    await close(fixture.upstream);
  }
});

test('gateway aborts image forwarding when the client disconnects and releases its lease once', async () => {
  let imageRequestCount = 0;
  let imageStartedResolve;
  let imageClosedResolve;
  const imageStarted = new Promise((resolve) => { imageStartedResolve = resolve; });
  const imageClosed = new Promise((resolve) => { imageClosedResolve = resolve; });
  const imageGateway = http.createServer((request, response) => {
    const requestNumber = ++imageRequestCount;
    request.on('error', () => {});
    response.on('error', () => {});
    request.once('close', () => {
      if (requestNumber === 1) imageClosedResolve();
    });
    request.resume();
    request.once('end', () => {
      if (requestNumber === 1) {
        imageStartedResolve();
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json', 'X-Request-Id': 'image-retry' });
      response.end(JSON.stringify({ data: [{ b64_json: 'cG5n' }] }));
    });
  });
  const upstream = http.createServer((request, response) => {
    response.writeHead(404);
    response.end();
  });
  const imageBase = await listen(imageGateway);
  const upstreamBase = await listen(upstream);
  const gateway = createGateway({
    upstream: upstreamBase,
    imageGatewayBaseUrl: imageBase,
    portal: 'https://portal.example.com',
    publicBaseUrl: 'https://gw.example.com',
    tokenSecret: 'token-secret',
    keySecret: 'key-secret',
    imageEnabled: true,
    tiers: [{ id: 'standard', models: { image: 'image-model' } }],
    defaultTiers: { image: 'standard' },
    operations: { admission: { maxConcurrent: 1, maxQueued: 1 } },
    sub2api: {
      loginPath: '/login',
      profilePath: '/profile',
      usagePath: '/usage',
      usageListPath: '/usage/list',
      apiKeysPath: '/keys',
      topUpEnabled: false,
    },
  }, { expandPlaybook: () => 'playbook' });
  const gatewayBase = await listen(gateway);
  const imageBody = JSON.stringify({ model: 'image-model', prompt: 'disconnect' });

  try {
    const client = http.request(`${gatewayBase}/v1/images/generations`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token()}`,
        'X-Device-Id': 'device-1',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(imageBody),
      },
    });
    client.on('error', () => {});
    client.end(imageBody);
    await imageStarted;
    client.destroy();
    await imageClosed;

    const retry = await requestImage(gatewayBase, { model: 'image-model', prompt: 'retry' });
    assert.equal(retry.status, 200);
    assert.deepEqual(await retry.json(), { data: [{ b64_json: 'cG5n' }] });
    assert.equal(imageRequestCount, 2);
  } finally {
    await close(gateway);
    await close(imageGateway);
    await close(upstream);
  }
});
