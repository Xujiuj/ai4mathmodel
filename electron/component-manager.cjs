const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_PUBLIC_KEY_PATH = path.join(__dirname, 'keys', 'manifest-ed25519.spki.b64');

function loadManifestPublicKeyDer() {
  if (process.env.MMW_MANIFEST_PUBLIC_KEY) {
    return Buffer.from(String(process.env.MMW_MANIFEST_PUBLIC_KEY).trim(), 'base64');
  }
  const file = process.env.MMW_MANIFEST_PUBLIC_KEY_PATH || DEFAULT_PUBLIC_KEY_PATH;
  const raw = fs.readFileSync(file, 'utf8').trim();
  if (raw.includes('BEGIN PUBLIC KEY')) {
    return crypto.createPublicKey(raw).export({ type: 'spki', format: 'der' });
  }
  return Buffer.from(raw, 'base64');
}

const MANIFEST_PUBLIC_KEY = loadManifestPublicKeyDer();

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

function createManifestPublicKey() {
  return crypto.createPublicKey({ key: MANIFEST_PUBLIC_KEY, format: 'der', type: 'spki' });
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

function verifyManifestSignature(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (!payload.signature) return Boolean(payload.allowUnsignedDev);
  try {
    return crypto.verify(
      null,
      manifestSigningPayload(payload),
      createManifestPublicKey(),
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
  await fsp.writeFile(installedComponentsFile(runtimeRootPath), JSON.stringify(data, null, 2), 'utf8');
}

async function fetchRuntimeManifest({ channel = 'stable', fetchImpl = globalThis.fetch, baseUrl = '' } = {}) {
  const appMajor = require('../package.json').version.split('.')[0];
  const url = `${baseUrl || 'https://dl.example.com/mmw/runtime'}/manifest-${appMajor}-${channel}.json`;
  if (typeof fetchImpl !== 'function') throw new Error('fetch unavailable');
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`Manifest fetch failed: ${response.status}`);
  const payload = await response.json();
  if (!verifyManifestSignature(payload)) {
    throw new Error('Manifest signature invalid');
  }
  return payload;
}

async function listComponentUpdates({ runtimeRootPath, channel = 'stable', fetchImpl, baseUrl } = {}) {
  const installed = await readInstalledComponents(runtimeRootPath);
  let manifest;
  try {
    manifest = await fetchRuntimeManifest({ channel, fetchImpl, baseUrl });
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
  DEFAULT_PUBLIC_KEY_PATH,
  canonicalJson,
  signManifest,
  verifyManifestSignature,
  installedComponentsFile,
  readInstalledComponents,
  writeInstalledComponents,
  fetchRuntimeManifest,
  listComponentUpdates,
  recordInstalledComponent,
  seedInstalledComponentsSync,
};
