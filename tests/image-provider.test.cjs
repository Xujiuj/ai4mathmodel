const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const {
  extractImageRequests,
  generateRequestedImages,
} = require('../electron/supervisor/image-provider.cjs');

const ONE_PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

test('extracts bounded image requests from structured model output', () => {
  const output = JSON.stringify({
    item: {
      text: '<figure_requests>{"requests":[{"path":"work/03_paper/figures/overview.png","prompt":"中文科学示意图","size":"1536x1024"}]}</figure_requests>',
    },
  });

  assert.deepEqual(extractImageRequests(output), [{
    path: 'work/03_paper/figures/overview.png',
    prompt: '中文科学示意图',
    size: '1536x1024',
  }]);
});

test('calls a custom OpenAI-compatible image endpoint and writes only inside the stage figure directory', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modeling-image-provider-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  let received;
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      received = {
        url: request.url,
        authorization: request.headers.authorization,
        headers: request.headers,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      };
      response.writeHead(200, { 'Content-Type': 'application/json', 'X-Request-Id': 'image-request' });
      response.end(JSON.stringify({ data: [{ b64_json: ONE_PIXEL_PNG }] }));
    });
  });
  const port = await listen(server);
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const output = '<figure_requests>{"requests":[{"path":"work/03_paper/figures/overview.png","prompt":"面向数学建模论文的中文机制示意图","size":"1024x1024"},{"path":"../escape.png","prompt":"越界","size":"1024x1024"}]}</figure_requests>';
  const result = await generateRequestedImages({
    root,
    stage: 'paper',
    output,
    connection: { baseUrl: `http://127.0.0.1:${port}/v1`, protocol: 'openai', model: 'image-model' },
    apiKey: 'test-secret-key',
    pipelineId: 'pipeline-1',
    allowInsecureRemote: true,
  });

  assert.equal(result.requested, 2);
  assert.equal(result.generated, 1);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.requestIds, ['image-request']);
  assert.equal(received.url, '/v1/images/generations');
  assert.equal(received.authorization, 'Bearer test-secret-key');
  assert.equal(received.headers['x-pipeline-id'], 'pipeline-1');
  assert.equal(received.body.model, 'image-model');
  assert.equal(received.body.prompt.includes('数学建模'), true);
  const generated = await fs.readFile(path.join(root, 'work', '03_paper', 'figures', 'overview.png'));
  assert.equal(generated.subarray(1, 4).toString('ascii'), 'PNG');
  await assert.rejects(fs.access(path.join(root, '..', 'escape.png')));
});

test('requests base64 first and falls back to same-origin URLs when the provider rejects the format', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modeling-image-format-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const formats = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      formats.push(body.response_format);
      if (body.response_format === 'b64_json') {
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'response_format not supported' } }));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: [{ b64_json: ONE_PIXEL_PNG }] }));
    });
  });
  const port = await listen(server);
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const output = '<figure_requests>{"requests":[{"path":"work/03_paper/figures/a.png","prompt":"中文机制示意图","size":"1024x1024"},{"path":"work/03_paper/figures/b.png","prompt":"第二幅中文示意图","size":"1024x1024"}]}</figure_requests>';
  const result = await generateRequestedImages({
    root,
    stage: 'paper',
    output,
    connection: { baseUrl: `http://127.0.0.1:${port}/v1`, protocol: 'openai', model: 'image-model' },
    apiKey: 'test-secret-key',
    allowInsecureRemote: true,
  });

  assert.equal(result.generated, 2);
  assert.deepEqual(formats, ['b64_json', 'url', 'url']);
});

test('rejects cross-origin image asset URLs without fetching them', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modeling-image-origin-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const requested = [];
  const result = await generateRequestedImages({
    root,
    stage: 'paper',
    output: '<figure_requests>{"requests":[{"path":"work/03_paper/figures/rejected.png","prompt":"mechanism","size":"1024x1024"}]}</figure_requests>',
    connection: { baseUrl: 'https://gateway.example/v1', protocol: 'openai', model: 'image-model' },
    apiKey: 'test-secret-key',
    fetchImpl: async (url) => {
      requested.push(String(url));
      return new Response(JSON.stringify({ data: [{ url: 'https://internal.example/private.png' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  assert.equal(result.generated, 0);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.errors, [{ path: 'work/03_paper/figures/rejected.png', code: 'IMAGE_ASSET_URL_REJECTED' }]);
  assert.deepEqual(requested, ['https://gateway.example/v1/images/generations']);
});

test('writes generated images through the active stage resolver', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modeling-image-staging-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const stagedPaper = path.join(root, 'work', '.staging', 'run-image', '03_paper');
  const result = await generateRequestedImages({
    root,
    stage: 'paper',
    output: '<figure_requests>{"requests":[{"path":"work/03_paper/figures/staged.png","prompt":"mechanism","size":"1024x1024"}]}</figure_requests>',
    connection: { baseUrl: 'https://gateway.example/v1', protocol: 'openai', model: 'image-model' },
    apiKey: 'test-secret-key',
    resolvePath: (relative) => path.join(stagedPaper, relative.slice('work/03_paper/'.length)),
    fetchImpl: async () => new Response(JSON.stringify({ data: [{ b64_json: ONE_PIXEL_PNG }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  });

  assert.equal(result.generated, 1);
  assert.equal((await fs.readFile(path.join(stagedPaper, 'figures', 'staged.png'))).subarray(1, 4).toString('ascii'), 'PNG');
  await assert.rejects(fs.access(path.join(root, 'work', '03_paper', 'figures', 'staged.png')));
});

test('honours a hosted per-stage image cap', () => {
  const output = '<figure_requests>{"requests":[{"path":"work/03_paper/figures/a.png","prompt":"图一","size":"1024x1024"},{"path":"work/03_paper/figures/b.png","prompt":"图二","size":"1024x1024"}]}</figure_requests>';
  assert.equal(extractImageRequests(output, 1).length, 1);
  assert.equal(extractImageRequests(output, 0).length, 0);
});
