const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const fsp = require('node:fs/promises');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');

const packageInfo = require('../package.json');
const DEFAULT_COMPONENT_UPDATE_BASE_URL = String(packageInfo.componentUpdate?.baseUrl || '').replace(/\/+$/, '');
const MANIFEST_PUBLIC_KEY = Buffer.from(String(packageInfo.componentUpdate?.manifestPublicKey || '').trim(), 'base64');
const INSTALLABLE_COMPONENTS = Object.freeze(new Set(['python', 'tectonic']));
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_COMPONENT_BYTES = 2 * 1024 * 1024 * 1024;
const MANIFEST_FETCH_TIMEOUT_MS = 30_000;
const COMPONENT_FETCH_TIMEOUT_MS = 120_000;
const execFileAsync = promisify(execFile);

async function withTimeout(operation, timeoutMs, message, onTimeout, { awaitOperationOnTimeout = false } = {}) {
  let timer;
  let timedOut = false;
  const operationPromise = Promise.resolve().then(operation);
  try {
    return await Promise.race([
      operationPromise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          try {
            onTimeout?.();
          } finally {
            reject(new Error(message));
          }
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    if (timedOut && awaitOperationOnTimeout) await operationPromise.catch(() => {});
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs, message, { controller = new AbortController() } = {}) {
  return withTimeout(
    () => fetchImpl(url, { ...options, signal: controller.signal }),
    timeoutMs,
    message,
    () => controller.abort(),
  ).catch((error) => {
    controller.abort();
    throw error;
  });
}

function abortError() {
  const error = new Error('Component download aborted');
  error.name = 'AbortError';
  return error;
}

function raceWithAbort(operation, signal) {
  if (!signal) return Promise.resolve().then(operation);
  if (signal.aborted) return Promise.reject(abortError());
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([Promise.resolve().then(operation), aborted]).finally(() => {
    signal.removeEventListener('abort', onAbort);
  });
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function manifestSigningPayload(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('invalid manifest');
  const { signature, allowUnsignedDev, ...content } = payload;
  return Buffer.from(canonicalJson(content), 'utf8');
}

function createManifestPublicKey(publicKey = MANIFEST_PUBLIC_KEY) {
  if (publicKey instanceof crypto.KeyObject) {
    return publicKey.type === 'public' ? publicKey : crypto.createPublicKey(publicKey);
  }
  if (typeof publicKey === 'string' && publicKey.includes('BEGIN PUBLIC KEY')) {
    return crypto.createPublicKey(publicKey);
  }
  const key = Buffer.isBuffer(publicKey)
    ? publicKey
    : Buffer.from(String(publicKey || '').trim(), 'base64');
  return crypto.createPublicKey({ key, format: 'der', type: 'spki' });
}

function loadPrivateKey(privateKeySource) {
  const fromEnv = process.env.MMW_MANIFEST_PRIVATE_KEY;
  if (fromEnv) return crypto.createPrivateKey(fromEnv);
  const filePath = privateKeySource
    || process.env.MMW_MANIFEST_PRIVATE_KEY_PATH
    || path.join(__dirname, '..', 'secrets', 'manifest-ed25519-private.pem');
  return crypto.createPrivateKey(fs.readFileSync(filePath, 'utf8'));
}

function signManifest(content, privateKeySource) {
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    throw new Error('manifest content must be an object');
  }
  if ('signature' in content) throw new Error('manifest content must not include signature');
  const privateKey = loadPrivateKey(privateKeySource);
  const signature = crypto.sign(null, Buffer.from(canonicalJson(content), 'utf8'), privateKey).toString('base64');
  return { ...content, signature };
}

function verifyManifestSignature(payload, { allowUnsignedDev = false, publicKey = MANIFEST_PUBLIC_KEY } = {}) {
  if (!payload || typeof payload !== 'object') return false;
  if (!payload.signature) return Boolean(allowUnsignedDev && payload.allowUnsignedDev === true);
  try {
    return crypto.verify(
      null,
      manifestSigningPayload(payload),
      createManifestPublicKey(publicKey),
      Buffer.from(String(payload.signature), 'base64'),
    );
  } catch {
    return false;
  }
}

function installedComponentsFile(runtimeRootPath) {
  return path.join(runtimeRootPath, 'installed-components.json');
}

async function readInstalledComponents(runtimeRootPath) {
  try {
    return JSON.parse(await fsp.readFile(installedComponentsFile(runtimeRootPath), 'utf8'));
  } catch {
    return {};
  }
}

async function writeInstalledComponents(runtimeRootPath, data) {
  await fsp.mkdir(path.dirname(installedComponentsFile(runtimeRootPath)), { recursive: true });
  const target = installedComponentsFile(runtimeRootPath);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(temporary, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  await fsp.rename(temporary, target).catch(async (error) => {
    if (!['EEXIST', 'EPERM'].includes(error.code)) throw error;
    await fsp.rm(target, { force: true });
    await fsp.rename(temporary, target);
  });
}

async function fetchRuntimeManifest({
  channel = 'stable',
  fetchImpl = globalThis.fetch,
  baseUrl = DEFAULT_COMPONENT_UPDATE_BASE_URL,
  publicKey = MANIFEST_PUBLIC_KEY,
  allowUnsignedDev = false,
  timeoutMs = MANIFEST_FETCH_TIMEOUT_MS,
} = {}) {
  const appMajor = packageInfo.version.split('.')[0];
  const source = String(baseUrl || DEFAULT_COMPONENT_UPDATE_BASE_URL).replace(/\/+$/, '');
  const url = `${source}/manifest-${appMajor}-${channel}.json`;
  if (typeof fetchImpl !== 'function') throw new Error('fetch unavailable');
  const response = await fetchWithTimeout(
    fetchImpl,
    url,
    { method: 'GET', redirect: 'error', headers: { Accept: 'application/json' } },
    timeoutMs,
    'Manifest fetch timed out',
  );
  if (!response.ok) throw new Error(`Manifest fetch failed: ${response.status}`);
  const declared = Number(response.headers?.get?.('content-length') || 0);
  if (declared > MAX_MANIFEST_BYTES) throw new Error('Manifest response too large');
  const bytes = Buffer.from(await withTimeout(
    () => response.arrayBuffer(),
    timeoutMs,
    'Manifest response timed out',
  ));
  if (bytes.length > MAX_MANIFEST_BYTES) throw new Error('Manifest response too large');
  let payload;
  try {
    payload = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('Manifest response invalid');
  }
  if (!verifyManifestSignature(payload, { allowUnsignedDev, publicKey })) {
    throw new Error('Manifest signature invalid');
  }
  return payload;
}

async function listComponentUpdates({ runtimeRootPath, channel = 'stable', fetchImpl, baseUrl, publicKey } = {}) {
  const installed = await readInstalledComponents(runtimeRootPath);
  let manifest;
  try {
    manifest = await fetchRuntimeManifest({ channel, fetchImpl, baseUrl, publicKey });
  } catch (error) {
    return { ok: false, reason: error.message, updates: [] };
  }
  const updates = [];
  for (const [name, info] of Object.entries(manifest.components || {})) {
    const current = installed[name]?.version || null;
    if (current !== info.version) {
      updates.push({
        name,
        from: current,
        to: info.version,
        sha256: info.sha256 || null,
        url: info.url || null,
        bytes: Number(info.bytes) || null,
      });
    }
  }
  return { ok: true, updates, manifestVersion: manifest.version || null };
}

async function recordInstalledComponent(runtimeRootPath, name, info = {}) {
  const installed = await readInstalledComponents(runtimeRootPath);
  installed[name] = {
    version: String(info.version || ''),
    sha256: info.sha256 || null,
    installedAt: new Date().toISOString(),
  };
  await writeInstalledComponents(runtimeRootPath, installed);
  return installed[name];
}

async function restoreInstalledMetadata(runtimeRootPath, snapshot) {
  const target = installedComponentsFile(runtimeRootPath);
  if (snapshot == null) {
    await fsp.rm(target, { force: true }).catch(() => {});
    return;
  }
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, snapshot, { encoding: 'utf8', mode: 0o600 });
}

function normalizeComponentInfo(name, info = {}) {
  const component = String(name || '').trim().toLowerCase();
  if (!INSTALLABLE_COMPONENTS.has(component)) throw new Error('Component is not installable');
  const version = String(info.version || '').trim();
  const sha256 = String(info.sha256 || '').trim().toLowerCase();
  let url;
  try {
    url = new URL(String(info.url || ''));
  } catch {
    throw new Error('Component URL invalid');
  }
  const bytes = Number(info.bytes || 0);
  if (!version || version.length > 80 || !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(version)) throw new Error('Component version invalid');
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Component checksum invalid');
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Component URL invalid');
  if (bytes && (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_COMPONENT_BYTES)) throw new Error('Component size invalid');
  return { name: component, version, sha256, url: url.toString(), bytes };
}

function validateArchiveEntries(entries, component) {
  const prefix = `${component}/`;
  const normalized = String(entries || '').split(/\r?\n/).map((entry) => entry.trim().replaceAll('\\', '/')).filter(Boolean);
  if (!normalized.length) throw new Error('Component archive is empty');
  for (const entry of normalized) {
    if (entry.startsWith('/') || /^[A-Za-z]:\//.test(entry)) throw new Error('Component archive path invalid');
    const segments = entry.split('/').filter((segment) => segment && segment !== '.');
    if (segments.includes('..') || (entry !== component && !entry.startsWith(prefix))) {
      throw new Error('Component archive path invalid');
    }
  }
  return normalized;
}

function validateArchiveTypes(listing, component) {
  const lines = String(listing || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    // tar -tvf emits the entry type as the first mode character. Reject links
    // before extraction; post-extraction scans remain a defense in depth.
    if (/^[lh]/i.test(line) || /\s(?:->|link to)\s/i.test(line)) {
      throw new Error('Component archive links are not allowed');
    }
  }
  return true;
}

async function assertSafeExtractedTree(root) {
  const rootStat = await fsp.lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('Component archive links are not allowed');
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    const entries = await fsp.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new Error('Component archive links are not allowed');
      if (entry.isDirectory()) pending.push(path.join(current, entry.name));
    }
  }
}

async function extractComponentArchive({ archivePath, stagingPath, component, execFileImpl = execFileAsync } = {}) {
  const tar = process.platform === 'win32' && process.env.SystemRoot
    ? path.join(process.env.SystemRoot, 'System32', 'tar.exe')
    : 'tar';
  const listed = await execFileImpl(tar, ['-tf', archivePath], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  validateArchiveEntries(listed.stdout, component);
  const detailed = await execFileImpl(tar, ['-tvf', archivePath], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  validateArchiveTypes(detailed.stdout, component);
  await fsp.mkdir(stagingPath, { recursive: true });
  await execFileImpl(tar, ['-xf', archivePath, '-C', stagingPath], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  const extracted = path.join(stagingPath, component);
  const stat = await fsp.lstat(extracted).catch(() => null);
  if (!stat?.isDirectory()) throw new Error('Component archive root missing');
  await assertSafeExtractedTree(extracted);
  return extracted;
}

async function downloadComponentArchive(response, target, info, progress = () => {}, { signal } = {}) {
  if (!response?.ok) throw new Error(`Component fetch failed: ${response?.status || 0}`);
  const declared = Number(response.headers?.get?.('content-length') || 0);
  if (declared > MAX_COMPONENT_BYTES || (info.bytes && declared && declared !== info.bytes)) throw new Error('Component size mismatch');
  const file = await fsp.open(target, 'wx', 0o600);
  const hash = crypto.createHash('sha256');
  let received = 0;
  let reader = null;
  let cancelStarted = false;
  let cancelPromise = null;
  let abortListener = null;
  const cancelReader = () => {
    if (!reader) return null;
    if (cancelStarted) return cancelPromise;
    cancelStarted = true;
    cancelPromise = Promise.resolve(reader.cancel?.()).catch(() => {});
    return cancelPromise;
  };
  let readerCompleted = false;
  try {
    reader = response.body?.getReader?.() || null;
    if (reader && signal) {
      abortListener = () => cancelReader();
      if (signal.aborted) cancelReader();
      else signal.addEventListener('abort', abortListener, { once: true });
    }
    if (reader) {
      for (;;) {
        const chunk = await raceWithAbort(() => reader.read(), signal);
        if (chunk.done) {
          readerCompleted = true;
          break;
        }
        const bytes = Buffer.from(chunk.value || []);
        received += bytes.length;
        if (received > MAX_COMPONENT_BYTES || (info.bytes && received > info.bytes)) throw new Error('Component size mismatch');
        hash.update(bytes);
        await file.write(bytes);
        progress({ received, total: info.bytes || declared || null });
      }
    } else {
      const bytes = Buffer.from(await raceWithAbort(() => response.arrayBuffer(), signal));
      received = bytes.length;
      if (received > MAX_COMPONENT_BYTES || (info.bytes && received !== info.bytes)) throw new Error('Component size mismatch');
      hash.update(bytes);
      await file.write(bytes);
      progress({ received, total: info.bytes || declared || null });
    }
  } finally {
    const pendingCancel = reader && !readerCompleted ? cancelReader() : null;
    if (pendingCancel) {
      let cancelTimer;
      await Promise.race([
        pendingCancel,
        new Promise((resolve) => {
          cancelTimer = setTimeout(resolve, 1_000);
        }),
      ]);
      if (cancelTimer) clearTimeout(cancelTimer);
    }
    if (signal && abortListener) signal.removeEventListener('abort', abortListener);
    try { reader?.releaseLock?.(); } catch {}
    await file.close();
  }
  if (info.bytes && received !== info.bytes) throw new Error('Component size mismatch');
  if (hash.digest('hex') !== info.sha256) throw new Error('Component checksum mismatch');
  return { bytes: received };
}

async function installComponentUpdate({
  runtimeRootPath,
  name,
  channel = 'stable',
  fetchImpl = globalThis.fetch,
  baseUrl,
  publicKey,
  extractImpl = extractComponentArchive,
  progress = () => {},
  fetchTimeoutMs = COMPONENT_FETCH_TIMEOUT_MS,
} = {}) {
  const manifest = await fetchRuntimeManifest({ channel, fetchImpl, baseUrl, publicKey, timeoutMs: fetchTimeoutMs });
  const info = normalizeComponentInfo(name, manifest.components?.[name]);
  const installed = await readInstalledComponents(runtimeRootPath);
  if (installed[info.name]?.version === info.version) return { ok: true, current: true, component: info.name, version: info.version };

  await fsp.mkdir(runtimeRootPath, { recursive: true });
  const updatesRoot = path.join(runtimeRootPath, '.updates');
  await fsp.mkdir(updatesRoot, { recursive: true });
  const temporary = await fsp.mkdtemp(path.join(updatesRoot, `${info.name}-`));
  const archivePath = path.join(temporary, 'component.archive');
  const extractionPath = path.join(temporary, 'extracted');
  const target = path.join(runtimeRootPath, info.name);
  const backup = path.join(updatesRoot, `${info.name}.backup-${process.pid}-${Date.now()}`);
  const targetOriginallyExisted = fs.existsSync(target);
  const metadataSnapshot = await fsp.readFile(installedComponentsFile(runtimeRootPath), 'utf8').catch(() => null);
  let backedUp = false;
  const componentController = new AbortController();
  try {
    progress({ phase: 'download', received: 0, total: info.bytes || null });
    const response = await fetchWithTimeout(
      fetchImpl,
      info.url,
      { method: 'GET', redirect: 'error', headers: { Accept: 'application/octet-stream' } },
      fetchTimeoutMs,
      'Component fetch timed out',
      { controller: componentController },
    );
    const downloaded = await withTimeout(
      () => downloadComponentArchive(
        response,
        archivePath,
        info,
        (value) => progress({ phase: 'download', ...value }),
        { signal: componentController.signal },
      ),
      fetchTimeoutMs,
      'Component response timed out',
      () => componentController.abort(),
      { awaitOperationOnTimeout: true },
    );
    progress({ phase: 'extract', received: downloaded.bytes, total: downloaded.bytes });
    const extracted = await extractImpl({ archivePath, stagingPath: extractionPath, component: info.name });
    if (fs.existsSync(target)) {
      await fsp.rename(target, backup);
      backedUp = true;
    }
    await fsp.rename(extracted, target);
    await recordInstalledComponent(runtimeRootPath, info.name, info);
    if (backedUp) await fsp.rm(backup, { recursive: true, force: true });
    progress({ phase: 'complete', received: downloaded.bytes, total: downloaded.bytes });
    return { ok: true, component: info.name, version: info.version, bytes: downloaded.bytes };
  } catch (error) {
    if (backedUp) {
      await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
      await fsp.rename(backup, target).catch(() => {});
    } else if (!targetOriginallyExisted) {
      await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
    }
    await restoreInstalledMetadata(runtimeRootPath, metadataSnapshot).catch(() => {});
    throw error;
  } finally {
    await fsp.rm(temporary, { recursive: true, force: true }).catch(() => {});
  }
}

function seedInstalledComponentsSync(runtimeRootPath, packageVersion) {
  const file = installedComponentsFile(runtimeRootPath);
  if (fs.existsSync(file)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    core: { version: packageVersion, installedAt: new Date().toISOString() },
  }, null, 2), 'utf8');
}

module.exports = {
  MANIFEST_PUBLIC_KEY,
  DEFAULT_COMPONENT_UPDATE_BASE_URL,
  canonicalJson,
  signManifest,
  verifyManifestSignature,
  installedComponentsFile,
  readInstalledComponents,
  writeInstalledComponents,
  fetchRuntimeManifest,
  installComponentUpdate,
  extractComponentArchive,
  normalizeComponentInfo,
  validateArchiveEntries,
  validateArchiveTypes,
  downloadComponentArchive,
  listComponentUpdates,
  recordInstalledComponent,
  seedInstalledComponentsSync,
};
