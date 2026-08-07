const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  DEFAULT_COMPONENT_UPDATE_BASE_URL,
  MANIFEST_PUBLIC_KEY,
  canonicalJson,
  downloadComponentArchive,
  fetchRuntimeManifest,
  installComponentUpdate,
  readInstalledComponents,
  validateArchiveTypes,
  validateArchiveEntries,
  verifyManifestSignature,
} = require('../electron/component-manager.cjs');

const projectRoot = path.resolve(__dirname, '..');
const EXPECTED_COMPONENT_UPDATE_BASE_URL = 'https://github.com/Xujiuj/ai4mathmodel/releases/download/runtime-v1';
const EXPECTED_MANIFEST_PUBLIC_KEY = 'MCowBQYDK2VwAyEAnHg0yEekg5BqRTbx3GiTQi6Bvu0j50UsS6LiO/U8ino=';
const pinnedManifest = require('../scripts/fixtures/runtime-manifest.signed.json');

function response(body, { status = 200 } = {}) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), 'utf8');
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => name.toLowerCase() === 'content-length' ? String(bytes.length) : null },
    arrayBuffer: async () => bytes,
  };
}

function signTestManifest(content) {
  const pair = crypto.generateKeyPairSync('ed25519');
  return {
    manifest: {
      ...content,
      signature: crypto.sign(null, Buffer.from(canonicalJson(content), 'utf8'), pair.privateKey).toString('base64'),
    },
    publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }),
  };
}

function probeComponentTrust(overrides) {
  const result = spawnSync(process.execPath, ['-e', [
    "const manager = require('./electron/component-manager.cjs');",
    "process.stdout.write(JSON.stringify({ baseUrl: manager.DEFAULT_COMPONENT_UPDATE_BASE_URL, publicKey: manager.MANIFEST_PUBLIC_KEY.toString('base64') }));",
  ].join('\n')], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: { ...process.env, ...overrides },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('runtime component trust defaults are embedded and ignore environment overrides', () => {
  const forgedKey = Buffer.from('attacker-controlled-key').toString('base64');
  for (const trust of [
    probeComponentTrust({
      MMW_RUNTIME_UPDATE_URL: 'https://attacker.invalid/runtime',
      MMW_MANIFEST_PUBLIC_KEY: forgedKey,
      MMW_MANIFEST_PUBLIC_KEY_PATH: 'Z:\\attacker\\manifest-key.b64',
    }),
    probeComponentTrust({
      MMW_RUNTIME_UPDATE_URL: 'https://attacker.invalid/runtime',
      MMW_MANIFEST_PUBLIC_KEY: '',
      MMW_MANIFEST_PUBLIC_KEY_PATH: 'Z:\\attacker\\manifest-key.b64',
    }),
  ]) {
    assert.equal(trust.baseUrl, EXPECTED_COMPONENT_UPDATE_BASE_URL);
    assert.equal(trust.publicKey, EXPECTED_MANIFEST_PUBLIC_KEY);
  }
  assert.equal(DEFAULT_COMPONENT_UPDATE_BASE_URL, EXPECTED_COMPONENT_UPDATE_BASE_URL);
  assert.equal(MANIFEST_PUBLIC_KEY.toString('base64'), EXPECTED_MANIFEST_PUBLIC_KEY);
});

test('default manifest fetch uses the pinned GitHub runtime release', async () => {
  let requestedUrl = '';
  await fetchRuntimeManifest({
    fetchImpl: async (url) => {
      requestedUrl = url;
      return response(pinnedManifest);
    },
  });
  assert.equal(requestedUrl, `${EXPECTED_COMPONENT_UPDATE_BASE_URL}/manifest-0-stable.json`);
});

test('manifest verification accepts the pinned key and an explicit test key only when requested', async () => {
  assert.equal(verifyManifestSignature(pinnedManifest), true);
  assert.equal(verifyManifestSignature({ ...pinnedManifest, version: 'tampered' }), false);

  const pair = crypto.generateKeyPairSync('ed25519');
  const content = { version: 'test-key', channel: 'stable', components: {} };
  const customManifest = {
    ...content,
    signature: crypto.sign(null, Buffer.from(canonicalJson(content), 'utf8'), pair.privateKey).toString('base64'),
  };
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'der' });
  assert.equal(verifyManifestSignature(customManifest), false);
  assert.equal(verifyManifestSignature(customManifest, { publicKey }), true);
  await fetchRuntimeManifest({
    baseUrl: 'https://updates.example/runtime',
    publicKey,
    fetchImpl: async () => response(customManifest),
  });
});

test('runtime manifests never accept a remote unsigned-development flag by itself', () => {
  assert.equal(verifyManifestSignature({ allowUnsignedDev: true, components: {} }), false);
  assert.equal(verifyManifestSignature({ allowUnsignedDev: true, components: {} }, { allowUnsignedDev: true }), true);
});

test('component archive entries stay inside the signed component root', () => {
  assert.deepEqual(validateArchiveEntries('python/\npython/python.exe\npython/Lib/site.py\n', 'python'), [
    'python/', 'python/python.exe', 'python/Lib/site.py',
  ]);
  assert.throws(() => validateArchiveEntries('python/../../outside.txt', 'python'), /path invalid/);
  assert.throws(() => validateArchiveEntries('tectonic/tectonic.exe', 'python'), /path invalid/);
  assert.throws(() => validateArchiveTypes('lrwxrwxrwx user/group 0 2026-08-04 python/link -> outside', 'python'), /links are not allowed/);
  assert.throws(() => validateArchiveTypes('hrw-r--r-- user/group 0 2026-08-04 python/hard', 'python'), /links are not allowed/);
});

test('manifest fetches have a bounded timeout', async () => {
  await assert.rejects(
    () => fetchRuntimeManifest({
      baseUrl: 'https://updates.example/runtime',
      timeoutMs: 10,
      fetchImpl: () => new Promise(() => {}),
    }),
    /Manifest fetch timed out/,
  );
});

test('component updater verifies bytes and hash before atomically replacing the runtime', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mmw-component-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'python'), { recursive: true });
  await fs.writeFile(path.join(root, 'python', 'python.exe'), 'old-runtime', 'utf8');

  const archive = Buffer.from('signed-component-archive');
  const sha256 = crypto.createHash('sha256').update(archive).digest('hex');
  const { manifest, publicKey } = signTestManifest({
    version: '2026.08.04',
    channel: 'stable',
    components: {
      python: {
        version: '3.12.9',
        sha256,
        bytes: archive.length,
        url: 'https://updates.example/runtime/python-3.12.9.7z',
      },
    },
  });
  const fetchImpl = async (url) => url.includes('manifest-') ? response(manifest) : response(archive);
  const phases = [];
  const result = await installComponentUpdate({
    runtimeRootPath: root,
    name: 'python',
    baseUrl: 'https://updates.example/runtime',
    publicKey,
    fetchImpl,
    progress: (event) => phases.push(event.phase),
    extractImpl: async ({ stagingPath, component }) => {
      const extracted = path.join(stagingPath, component);
      await fs.mkdir(extracted, { recursive: true });
      await fs.writeFile(path.join(extracted, 'python.exe'), 'new-runtime', 'utf8');
      return extracted;
    },
  });

  assert.equal(result.ok, true);
  assert.equal(await fs.readFile(path.join(root, 'python', 'python.exe'), 'utf8'), 'new-runtime');
  assert.equal((await readInstalledComponents(root)).python.version, '3.12.9');
  assert.equal(phases.includes('download'), true);
  assert.equal(phases.at(-1), 'complete');
});

test('component download cancels a stalled reader, aborts the fetch, and removes partial temp files', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mmw-component-timeout-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const archive = Buffer.from('stalled-component-archive');
  const { manifest, publicKey } = signTestManifest({
    version: '2026.08.04',
    channel: 'stable',
    components: {
      python: {
        version: '3.12.9',
        sha256: crypto.createHash('sha256').update(archive).digest('hex'),
        bytes: archive.length,
        url: 'https://updates.example/runtime/python-3.12.9.7z',
      },
    },
  });
  let archiveSignal;
  let cancelCount = 0;
  const fetchImpl = async (url, options = {}) => {
    if (url.includes('manifest-')) return response(manifest);
    archiveSignal = options.signal;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: {
        getReader() {
          return {
            read: () => new Promise(() => {}),
            cancel: async () => { cancelCount += 1; },
            releaseLock() {},
          };
        },
      },
    };
  };

  await assert.rejects(() => installComponentUpdate({
    runtimeRootPath: root,
    name: 'python',
    baseUrl: 'https://updates.example/runtime',
    publicKey,
    fetchImpl,
    fetchTimeoutMs: 20,
    extractImpl: async () => { throw new Error('must not extract'); },
  }), /Component response timed out|Component download aborted/);

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(archiveSignal?.aborted, true);
  assert.equal(cancelCount, 1);
  assert.deepEqual(await fs.readdir(path.join(root, '.updates')), []);
});

test('component download streams and verifies a successful reader exactly once', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mmw-component-stream-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const archive = Buffer.from('streamed-component-archive');
  const target = path.join(root, 'component.archive');
  const chunks = [archive.subarray(0, 8), archive.subarray(8)];
  let index = 0;
  let cancelCount = 0;
  const info = {
    bytes: archive.length,
    sha256: crypto.createHash('sha256').update(archive).digest('hex'),
  };
  const progress = [];
  const result = await downloadComponentArchive({
    ok: true,
    status: 200,
    headers: { get: () => String(archive.length) },
    body: {
      getReader() {
        return {
          async read() {
            if (index >= chunks.length) return { done: true, value: undefined };
            return { done: false, value: chunks[index++] };
          },
          async cancel() { cancelCount += 1; },
          releaseLock() {},
        };
      },
    },
  }, target, info, (event) => progress.push(event));

  assert.deepEqual(result, { bytes: archive.length });
  assert.deepEqual(await fs.readFile(target), archive);
  assert.equal(cancelCount, 0);
  assert.equal(progress.at(-1).received, archive.length);
});

test('component updater leaves the installed runtime untouched on checksum failure', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mmw-component-bad-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'tectonic'), { recursive: true });
  await fs.writeFile(path.join(root, 'tectonic', 'tectonic.exe'), 'known-good', 'utf8');
  const archive = Buffer.from('tampered');
  const { manifest, publicKey } = signTestManifest({
    version: '2026.08.04',
    channel: 'stable',
    components: {
      tectonic: {
        version: '0.15.1',
        sha256: '0'.repeat(64),
        bytes: archive.length,
        url: 'https://updates.example/runtime/tectonic-0.15.1.7z',
      },
    },
  });

  await assert.rejects(() => installComponentUpdate({
    runtimeRootPath: root,
    name: 'tectonic',
    baseUrl: 'https://updates.example/runtime',
    publicKey,
    fetchImpl: async (url) => url.includes('manifest-') ? response(manifest) : response(archive),
    extractImpl: async () => { throw new Error('must not extract'); },
  }), /checksum mismatch/);
  assert.equal(await fs.readFile(path.join(root, 'tectonic', 'tectonic.exe'), 'utf8'), 'known-good');
});

test('first-install failures after metadata commit remove the runtime and restore metadata', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mmw-component-first-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const archive = Buffer.from('signed-component-archive');
  const sha256 = crypto.createHash('sha256').update(archive).digest('hex');
  const { manifest, publicKey } = signTestManifest({
    version: '2026.08.04',
    channel: 'stable',
    components: {
      python: {
        version: '3.12.9',
        sha256,
        bytes: archive.length,
        url: 'https://updates.example/runtime/python-3.12.9.7z',
      },
    },
  });
  const fetchImpl = async (url) => url.includes('manifest-') ? response(manifest) : response(archive);

  await assert.rejects(() => installComponentUpdate({
    runtimeRootPath: root,
    name: 'python',
    baseUrl: 'https://updates.example/runtime',
    publicKey,
    fetchImpl,
    extractImpl: async ({ stagingPath, component }) => {
      const extracted = path.join(stagingPath, component);
      await fs.mkdir(extracted, { recursive: true });
      await fs.writeFile(path.join(extracted, 'python.exe'), 'new-runtime', 'utf8');
      return extracted;
    },
    progress: ({ phase }) => {
      if (phase === 'complete') throw new Error('post-commit observer failed');
    },
  }), /post-commit observer failed/);

  await assert.rejects(() => fs.access(path.join(root, 'python')));
  assert.deepEqual(await readInstalledComponents(root), {});
});
