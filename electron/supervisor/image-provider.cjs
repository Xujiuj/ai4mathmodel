const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');

const MAX_REQUESTS = 4;
const MAX_PROMPT_LENGTH = 6_000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 120_000;
const ALLOWED_SIZES = new Set(['auto', '1024x1024', '1536x1024', '1024x1536']);
const STAGE_FIGURE_ROOTS = Object.freeze({
  analysis: 'work/01_analysis/figures',
  solving: 'work/02_solving/figures',
  paper: 'work/03_paper/figures',
  review: 'work/04_review/figures',
});

function cleanText(value, limit) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

function outputCandidates(output) {
  const candidates = [];
  for (const line of String(output || '').split(/\r?\n/).filter(Boolean)) {
    try {
      const event = JSON.parse(line);
      for (const value of [event?.item?.text, event?.message?.content, event?.text]) {
        if (typeof value === 'string') candidates.push(value);
      }
    } catch {
      candidates.push(line);
    }
  }
  candidates.push(String(output || ''));
  return candidates;
}

function extractImageRequests(output) {
  const requests = [];
  const seen = new Set();
  for (const candidate of outputCandidates(output)) {
    const blocks = candidate.matchAll(/<figure_requests>\s*([\s\S]*?)\s*<\/figure_requests>/gi);
    for (const block of blocks) {
      let value;
      try {
        value = JSON.parse(block[1]);
      } catch {
        continue;
      }
      for (const raw of Array.isArray(value?.requests) ? value.requests : []) {
        const request = {
          path: cleanText(raw?.path, 512).replaceAll('\\', '/'),
          prompt: cleanText(raw?.prompt, MAX_PROMPT_LENGTH),
          size: ALLOWED_SIZES.has(raw?.size) ? raw.size : '1536x1024',
        };
        if (!request.path || !request.prompt) continue;
        const identity = `${request.path}\n${request.prompt}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        requests.push(request);
        if (requests.length >= MAX_REQUESTS) return requests;
      }
    }
  }
  return requests;
}

function isLocalHost(hostname) {
  const normalized = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function imageEndpoint(baseUrl, allowInsecureRemote = false) {
  const endpoint = new URL(String(baseUrl || '').trim());
  if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('IMAGE_ENDPOINT_PROTOCOL');
  if (endpoint.protocol === 'http:' && !isLocalHost(endpoint.hostname) && !allowInsecureRemote) throw new Error('IMAGE_ENDPOINT_INSECURE');
  endpoint.search = '';
  endpoint.hash = '';
  const cleanPath = endpoint.pathname.replace(/\/+$/, '');
  endpoint.pathname = /\/images\/generations$/i.test(cleanPath)
    ? cleanPath
    : `${cleanPath}/images/generations`.replace(/\/{2,}/g, '/');
  return endpoint.toString();
}

function safeRelativeTarget(stage, requestedPath) {
  const allowedRoot = STAGE_FIGURE_ROOTS[stage];
  const normalized = path.posix.normalize(String(requestedPath || '').replaceAll('\\', '/'));
  if (!allowedRoot || !normalized || path.posix.isAbsolute(normalized) || normalized.includes('\0')) throw new Error('IMAGE_PATH_INVALID');
  if (normalized !== allowedRoot && !normalized.startsWith(`${allowedRoot}/`)) throw new Error('IMAGE_PATH_OUTSIDE_STAGE');
  if (path.posix.extname(normalized).toLowerCase() !== '.png') throw new Error('IMAGE_FORMAT_UNSUPPORTED');
  return normalized;
}

function decodeBase64Image(value) {
  const encoded = String(value || '').replace(/^data:image\/png;base64,/i, '').replace(/\s+/g, '');
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('IMAGE_RESPONSE_INVALID');
  const buffer = Buffer.from(encoded, 'base64');
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) throw new Error('IMAGE_RESPONSE_SIZE');
  return buffer;
}

function isPng(buffer) {
  return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

async function responseBuffer(payload, fetchImpl, timeoutMs) {
  const item = payload?.data?.[0] || payload?.images?.[0] || payload?.output?.[0] || {};
  const encoded = typeof item === 'string' ? item : item.b64_json || item.base64 || item.image_base64;
  if (encoded) return decodeBase64Image(encoded);
  const remoteUrl = item.url || payload?.url;
  if (!remoteUrl) throw new Error('IMAGE_RESPONSE_INVALID');
  const target = new URL(remoteUrl);
  if (target.protocol !== 'https:' && !(target.protocol === 'http:' && isLocalHost(target.hostname))) throw new Error('IMAGE_ASSET_URL_REJECTED');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(target, { redirect: 'error', signal: controller.signal });
    if (!response.ok) throw new Error(`IMAGE_ASSET_HTTP_${response.status}`);
    const length = Number(response.headers.get('content-length') || 0);
    if (length > MAX_IMAGE_BYTES) throw new Error('IMAGE_RESPONSE_SIZE');
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_IMAGE_BYTES) throw new Error('IMAGE_RESPONSE_SIZE');
    return buffer;
  } finally {
    clearTimeout(timeout);
  }
}

async function requestImage({ endpoint, apiKey, model, request, fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      redirect: 'error',
      signal: controller.signal,
      body: JSON.stringify({
        model,
        n: 1,
        size: request.size,
        response_format: 'b64_json',
        prompt: `生成可直接用于数学建模论文的中文科学示意图。构图由内容决定，不添加图题、图注、解释段落、水印或风格说明。图中文字仅保留必要的简洁中文标签。内容：${request.prompt}`,
      }),
    });
    if (!response.ok) throw new Error(`IMAGE_HTTP_${response.status}`);
    const length = Number(response.headers.get('content-length') || 0);
    if (length > MAX_IMAGE_BYTES * 2) throw new Error('IMAGE_RESPONSE_SIZE');
    const payload = await response.json();
    const buffer = await responseBuffer(payload, fetchImpl, timeoutMs);
    if (!isPng(buffer)) throw new Error('IMAGE_NOT_PNG');
    return buffer;
  } finally {
    clearTimeout(timeout);
  }
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function writeImage(root, relative, buffer) {
  const rootReal = await fsp.realpath(root);
  const target = path.resolve(rootReal, ...relative.split('/'));
  const parent = path.dirname(target);
  await fsp.mkdir(parent, { recursive: true });
  const parentReal = await fsp.realpath(parent);
  if (!inside(rootReal, parentReal)) throw new Error('IMAGE_PATH_SYMLINK');
  const finalTarget = path.join(parentReal, path.basename(target));
  const temporary = path.join(parentReal, `.${path.basename(target)}.${crypto.randomUUID()}.tmp`);
  try {
    await fsp.writeFile(temporary, buffer, { flag: 'wx', mode: 0o600 });
    await fsp.rename(temporary, finalTarget);
  } finally {
    await fsp.rm(temporary, { force: true }).catch(() => {});
  }
  return finalTarget;
}

function errorCode(error) {
  const value = String(error?.message || error || 'IMAGE_UNKNOWN');
  if (/^[A-Z0-9_]+$/.test(value)) return value.slice(0, 80);
  if (/abort/i.test(value)) return 'IMAGE_TIMEOUT';
  return 'IMAGE_REQUEST_FAILED';
}

async function generateRequestedImages({
  root,
  stage,
  output,
  connection = {},
  apiKey = '',
  model,
  allowInsecureRemote = false,
  fetchImpl = globalThis.fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
}) {
  const requests = extractImageRequests(output);
  const outcome = { requested: requests.length, generated: 0, failed: 0, artifactRefs: [], errors: [] };
  if (!requests.length) return outcome;
  if (connection.protocol !== 'openai' || !connection.baseUrl || !(model || connection.model) || typeof fetchImpl !== 'function') {
    return { ...outcome, failed: requests.length, errors: requests.map((request) => ({ path: request.path, code: 'IMAGE_CONNECTION_UNSUPPORTED' })) };
  }

  let endpoint;
  try {
    endpoint = imageEndpoint(connection.baseUrl, Boolean(allowInsecureRemote || connection.allowInsecureRemote));
  } catch (error) {
    return { ...outcome, failed: requests.length, errors: requests.map((request) => ({ path: request.path, code: errorCode(error) })) };
  }

  for (const request of requests) {
    try {
      const relative = safeRelativeTarget(stage, request.path);
      const buffer = await requestImage({
        endpoint,
        apiKey,
        model: model || connection.model,
        request,
        fetchImpl,
        timeoutMs: Math.max(1_000, Math.min(Number(timeoutMs) || REQUEST_TIMEOUT_MS, REQUEST_TIMEOUT_MS)),
      });
      await writeImage(root, relative, buffer);
      outcome.generated += 1;
      outcome.artifactRefs.push(relative);
    } catch (error) {
      outcome.failed += 1;
      outcome.errors.push({ path: request.path, code: errorCode(error) });
    }
  }
  return outcome;
}

module.exports = {
  extractImageRequests,
  generateRequestedImages,
  imageEndpoint,
  safeRelativeTarget,
};
