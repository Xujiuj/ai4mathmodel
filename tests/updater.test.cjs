const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const {
  cleanupStaleUpdateFiles,
  compareSemver,
  createAutoUpdaterBridge,
  defaultLaunchInstaller,
  defaultPrepareInstaller,
  defaultVerifyAuthenticode,
  downloadRelease,
  expectedSetupName,
  fetchGithub,
  powershellUtf8Expression,
  parseAuthenticodeResult,
  selectRelease,
  validateArchiveEntryPath,
  validateInstallerKit,
} = require('../electron/updater.cjs');

function response(bytes, { stream = false, status = 200 } = {}) {
  const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(JSON.stringify(bytes), 'utf8');
  let offset = 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => name.toLowerCase() === 'content-length' ? String(body.length) : null },
    arrayBuffer: async () => body,
    body: stream ? {
      getReader: () => ({
        read: async () => {
          if (offset >= body.length) return { done: true };
          const chunk = body.subarray(offset, offset += Math.min(3, body.length - offset));
          return { done: false, value: chunk };
        },
      }),
    } : null,
  };
}

function releaseFor(bytes, overrides = {}) {
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  return {
    tag_name: 'v1.2.3',
    draft: false,
    prerelease: false,
    body: 'notes',
    assets: [{
      name: 'MathModelingWorkbench-1.2.3-Installer.zip',
      browser_download_url: 'https://github.com/Xujiuj/ai4mathmodel/releases/download/v1.2.3/MathModelingWorkbench-1.2.3-Installer.zip',
      digest: `sha256:${digest}`,
      size: bytes.length,
      ...overrides,
    }],
  };
}

test('release selection requires a GitHub sha256 digest and rejects older versions', () => {
  const bytes = Buffer.from('installer');
  assert.throws(() => selectRelease(releaseFor(bytes, { digest: '' }), '1.0.0'), /digest missing/);
  assert.equal(selectRelease(releaseFor(bytes), '2.0.0'), null);
  assert.equal(compareSemver('1.0.0-alpha.10', '1.0.0-alpha.2') > 0, true);
  assert.equal(compareSemver('01.0.0', '1.0.0'), null);
  assert.equal(compareSemver('1.0.0-alpha..1', '1.0.0-alpha.1'), null);
  assert.equal(compareSemver('1.0.0+build.1', '1.0.0'), 0);
  assert.equal(compareSemver('9007199254740992.0.0', '1.0.0'), null);
  assert.equal(compareSemver('1.0.0-alpha.9007199254740993', '1.0.0-alpha.9007199254740992'), 1);
  assert.throws(() => selectRelease(releaseFor(bytes, {
    browser_download_url: 'https://github.com/other/project/releases/download/v1.2.3/MathModelingWorkbench-1.2.3-Installer.zip',
  }), '1.0.0'), /asset URL invalid/);
});

test('installer paths use the versioned setup contract and reject archive traversal', () => {
  assert.equal(expectedSetupName('1.2.3'), 'MathModelingWorkbench-1.2.3-Setup.exe');
  assert.equal(validateArchiveEntryPath('payloads/core.7z'), 'payloads/core.7z');
  for (const invalid of ['../outside.exe', 'payloads/../../outside.exe', '/absolute.exe', 'C:\\outside.exe', '\\\\server\\share\\outside.exe']) {
    assert.throws(() => validateArchiveEntryPath(invalid), /archive path invalid/);
  }
  const hostile = 'C:\\tmp\\$(Write-Output INTERPOLATED)\\installer.zip';
  const expression = powershellUtf8Expression(hostile);
  assert.doesNotMatch(expression, /Write-Output|INTERPOLATED|\$\(/);
  assert.match(expression, /^\[Text\.Encoding\]::UTF8\.GetString/);
});

test('installer kit validation requires the exact manifest and digest-pinned component set', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mmw-installer-kit-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const version = '1.2.3';
  await fs.mkdir(path.join(root, 'packages'));
  await fs.writeFile(path.join(root, expectedSetupName(version)), 'signed-setup-placeholder');
  const packages = [];
  for (const id of ['core', 'python', 'tectonic']) {
    const bytes = Buffer.from(`${id}-payload`);
    const file = `MathModelingWorkbench-${version}-${id}.7z`;
    await fs.writeFile(path.join(root, 'packages', file), bytes);
    packages.push({ id, file, required: id === 'core', sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, installedBytes: bytes.length });
  }
  await fs.writeFile(path.join(root, 'payload-manifest.json'), JSON.stringify({
    schemaVersion: 1,
    product: 'math-modeling-workbench',
    version,
    architecture: 'x64',
    packages,
  }));

  assert.equal(await validateInstallerKit(root, version), path.join(root, expectedSetupName(version)));
  await fs.writeFile(path.join(root, 'unexpected.txt'), 'unexpected');
  await assert.rejects(() => validateInstallerKit(root, version), /archive contents invalid/);
  await fs.rm(path.join(root, 'unexpected.txt'));
  await fs.writeFile(path.join(root, 'packages', packages[0].file), 'tampered');
  await assert.rejects(() => validateInstallerKit(root, version), /size mismatch|digest mismatch/);
});

test('PowerShell extraction accepts a valid bounded installer kit', { skip: process.platform !== 'win32' }, async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mmw-installer-archive-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const destination = path.join(root, 'destination');
  const archive = path.join(root, 'installer.zip');
  const version = '1.2.3';
  await fs.mkdir(path.join(source, 'packages'), { recursive: true });
  await fs.writeFile(path.join(source, expectedSetupName(version)), 'signed-setup-placeholder');
  const packages = [];
  for (const id of ['core', 'python', 'tectonic']) {
    const bytes = Buffer.from(`${id}-payload`);
    const file = `MathModelingWorkbench-${version}-${id}.7z`;
    await fs.writeFile(path.join(source, 'packages', file), bytes);
    packages.push({ id, file, required: id === 'core', sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, installedBytes: bytes.length });
  }
  await fs.writeFile(path.join(source, 'payload-manifest.json'), JSON.stringify({
    schemaVersion: 1,
    product: 'math-modeling-workbench',
    version,
    architecture: 'x64',
    packages,
  }));

  const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; $source=${powershellUtf8Expression(source)}; $archive=${powershellUtf8Expression(archive)}; [IO.Compression.ZipFile]::CreateFromDirectory($source,$archive)`;
  await execFileAsync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]);
  await fs.mkdir(destination);
  assert.equal(await defaultPrepareInstaller(archive, destination, version), path.join(destination, expectedSetupName(version)));
});

test('installer launch waits for process creation and rejects asynchronous spawn errors', async () => {
  let unrefCalled = false;
  const launched = new EventEmitter();
  launched.unref = () => { unrefCalled = true; };
  const success = defaultLaunchInstaller('installer.exe', () => launched);
  launched.emit('spawn');
  assert.equal(await success, true);
  assert.equal(unrefCalled, true);

  const failed = new EventEmitter();
  failed.unref = () => {};
  const failure = defaultLaunchInstaller('installer.exe', () => failed);
  failed.emit('error', new Error('spawn denied'));
  await assert.rejects(failure, /spawn denied/);
});

test('Authenticode verification requires the exact Subject and normalized SHA-256 thumbprint', async () => {
  const subject = 'CN=Release Signer, O=Example Corp, C=US';
  const thumbprint = 'ab'.repeat(32);
  let encodedCommand = '';
  const execStub = async (_command, args) => {
    encodedCommand = args.at(-1);
    return { stdout: JSON.stringify({ status: 'Valid', subject, thumbprint: thumbprint.match(/../g).join(':') }) };
  };
  await defaultVerifyAuthenticode('setup.exe', [subject], [thumbprint.match(/../g).join(' ')], execStub);
  const script = Buffer.from(encodedCommand, 'base64').toString('utf16le');
  assert.match(script, /SHA256/);
  assert.match(script, /SignerCertificate\.RawData/);
  assert.doesNotMatch(script, /SignerCertificate\.Thumbprint/);
  await assert.rejects(
    () => defaultVerifyAuthenticode('setup.exe', [subject], ['cd'.repeat(32)], execStub),
    /thumbprint mismatch/,
  );
  await assert.rejects(
    () => defaultVerifyAuthenticode('setup.exe', [subject], [], execStub),
    /thumbprint is not configured/,
  );
  assert.deepEqual(parseAuthenticodeResult(JSON.stringify({ status: 'Valid', subject, thumbprint: 'ab:cd' })), {
    status: 'Valid',
    subject,
    thumbprint: 'ABCD',
  });
});

test('network body timeouts abort requests and cancel slow streams', async (context) => {
  let metadataSignal;
  await assert.rejects(() => fetchGithub(async (_url, options) => {
    metadataSignal = options.signal;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      arrayBuffer: () => new Promise(() => {}),
    };
  }, 'https://api.github.com/repos/Xujiuj/ai4mathmodel/releases/latest', {
    api: true,
    maxBytes: 1024,
    timeoutMs: 15,
  }), /timed out/);
  assert.equal(metadataSignal.aborted, true);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mmw-updater-timeout-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  let cancelled = false;
  let offset = 0;
  const bytes = Buffer.from('slow');
  const release = {
    url: 'https://github.com/Xujiuj/ai4mathmodel/releases/download/v1.2.3/MathModelingWorkbench-1.2.3-Installer.zip',
    size: bytes.length,
    digest: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
  await assert.rejects(() => downloadRelease({
    release,
    target: path.join(root, 'slow.zip'),
    timeoutMs: 25,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: (name) => name.toLowerCase() === 'content-length' ? String(bytes.length) : null },
      body: {
        getReader: () => ({
          read: async () => {
            await new Promise((resolve) => setTimeout(resolve, 18));
            return offset < bytes.length ? { done: false, value: bytes.subarray(offset, ++offset) } : { done: true };
          },
          cancel: async () => { cancelled = true; },
        }),
      },
    }),
  }), /timed out/);
  assert.equal(cancelled, true);
  assert.deepEqual(await fs.readdir(root), []);
});

test('stale updater files are bounded to the dedicated update directory', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mmw-updater-cleanup-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const oldZip = path.join(root, 'old.zip');
  const currentZip = path.join(root, 'current.zip');
  const staleWork = path.join(root, 'mmw-installer-old');
  const unrelated = path.join(root, 'keep.txt');
  await Promise.all([fs.writeFile(oldZip, 'old'), fs.writeFile(currentZip, 'current'), fs.mkdir(staleWork), fs.writeFile(unrelated, 'keep')]);
  const oldDate = new Date(Date.now() - 48 * 60 * 60_000);
  await Promise.all([fs.utimes(oldZip, oldDate, oldDate), fs.utimes(staleWork, oldDate, oldDate)]);
  assert.equal(await cleanupStaleUpdateFiles(root), 2);
  assert.deepEqual((await fs.readdir(root)).sort(), ['current.zip', 'keep.txt']);
});

test('downloads release assets as a stream and atomically renames the verified file', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mmw-updater-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from('streamed-installer');
  const release = selectRelease(releaseFor(bytes), '1.0.0');
  const target = path.join(root, 'installer.zip');
  const result = await downloadRelease({
    release,
    target,
    fetchImpl: async () => response(bytes, { stream: true }),
  });
  assert.equal(result, target);
  assert.deepEqual(await fs.readFile(target), bytes);
  const files = await fs.readdir(root);
  assert.deepEqual(files, ['installer.zip']);
});

test('digest failures remove the temporary download', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mmw-updater-bad-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from('tampered-installer');
  const release = selectRelease(releaseFor(bytes, { digest: `sha256:${'0'.repeat(64)}` }), '1.0.0');
  const target = path.join(root, 'installer.zip');
  await assert.rejects(() => downloadRelease({ release, target, fetchImpl: async () => response(bytes, { stream: true }) }), /digest mismatch/);
  assert.deepEqual(await fs.readdir(root), []);
});

test('asset redirects stay on approved GitHub CDN hosts', async () => {
  const bytes = Buffer.from('redirected-installer');
  const release = selectRelease(releaseFor(bytes), '1.0.0');
  let calls = 0;
  const result = await fetchGithub(async (url) => {
    calls += 1;
    if (calls === 1) return { ok: false, status: 302, headers: { get: () => 'https://release-assets.githubusercontent.com/github-production-release-asset/test' } };
    return response(bytes);
  }, release.url, { release: true, maxBytes: bytes.length, timeoutMs: 1000 });
  assert.deepEqual(result.bytes, bytes);
  await assert.rejects(() => fetchGithub(async () => ({ ok: false, status: 302, headers: { get: () => 'https://evil.example/asset' } }), release.url, { release: true, maxBytes: bytes.length, timeoutMs: 1000 }), /GitHub HTTPS/);
});

test('bridge checks, downloads, and runs injected signature/install gates', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mmw-updater-bridge-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from('bridge-installer');
  const release = releaseFor(bytes);
  const events = [];
  const calls = [];
  const fetchImpl = async (url) => url.includes('api.github.com') ? response(release) : response(bytes, { stream: true });
  const bridge = createAutoUpdaterBridge({
    platform: 'win32',
    currentVersion: '1.0.0',
    tempDir: root,
    fetchImpl,
    send: (event) => events.push(event),
    prepareInstaller: async (zip, workDir, version) => {
      calls.push(['prepare', zip, workDir, version]);
      return path.join(workDir, expectedSetupName(version));
    },
    verifyAuthenticode: async (setup, subjects) => { calls.push(['verify', setup, subjects]); },
    launchInstaller: async (setup) => { calls.push(['launch', setup]); },
    publisherNames: ['CN=MathModelingWorkbench', 'CN=MathModelingWorkbench Rotation'],
    quit: () => calls.push(['quit']),
  });

  assert.equal((await bridge.check()).available, true);
  const downloadResult = await bridge.download();
  assert.equal(downloadResult.ok, true);
  assert.equal('path' in downloadResult, false);
  assert.equal((await bridge.install()).ok, true);
  assert.deepEqual(calls.map(([name]) => name), ['prepare', 'verify', 'launch', 'quit']);
  assert.deepEqual(calls[1][2], ['CN=MathModelingWorkbench', 'CN=MathModelingWorkbench Rotation']);
  assert.equal(events.some((event) => event.type === 'available'), true);
  assert.equal(events.some((event) => event.type === 'ready'), true);
  assert.equal((await fs.readdir(root)).some((name) => name.endsWith('.zip')), false);
});

test('bridge rejects setup replacement between Authenticode verification and launch', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mmw-updater-toctou-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from('toctou-installer');
  const release = releaseFor(bytes);
  let launched = false;
  let verificationCount = 0;
  const bridge = createAutoUpdaterBridge({
    platform: 'win32',
    currentVersion: '1.0.0',
    tempDir: root,
    fetchImpl: async (url) => url.includes('api.github.com') ? response(release) : response(bytes, { stream: true }),
    prepareInstaller: async (_zip, workDir, version) => {
      const setupPath = path.join(workDir, expectedSetupName(version));
      await fs.writeFile(setupPath, 'signed-setup');
      return setupPath;
    },
    verifyAuthenticode: async (setupPath) => {
      verificationCount += 1;
      if (verificationCount === 1) await fs.writeFile(setupPath, 'replaced-setup');
    },
    launchInstaller: async () => { launched = true; },
    publisherNames: ['CN=Release Signer'],
    publisherThumbprints: ['ab'.repeat(32)],
  });

  assert.equal((await bridge.check()).available, true);
  assert.equal((await bridge.download()).ok, true);
  const result = await bridge.install();
  assert.equal(result.ok, false);
  assert.match(result.reason, /changed after verification/);
  assert.equal(verificationCount, 1);
  assert.equal(launched, false);
  assert.deepEqual(await fs.readdir(root), []);
});

test('development and non-Windows bridges safely decline updates', async () => {
  assert.equal((await createAutoUpdaterBridge({ isDev: true, platform: 'win32', latestReleaseUrl: 'invalid' }).check()).reason, 'dev-mode');
  assert.equal((await createAutoUpdaterBridge({ platform: 'linux', latestReleaseUrl: 'invalid' }).download()).reason, 'platform-unsupported');
});

test('production updater rejects an empty built-in signer allowlist', async () => {
  const bridge = createAutoUpdaterBridge({
    platform: 'win32',
    latestReleaseUrl: 'https://api.github.com/repos/Xujiuj/ai4mathmodel/releases/latest',
    publisherNames: [],
    publisherThumbprints: [],
    fetchImpl: async () => { throw new Error('network should not be reached'); },
  });
  await assert.deepEqual(await bridge.check(), {
    ok: false,
    reason: 'Installer signer allowlist is not configured',
  });
});

test('bridge serializes updater operations at the main-process boundary', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mmw-updater-busy-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  let releaseFetch;
  const entered = new Promise((resolve) => { releaseFetch = resolve; });
  let unblock;
  const blocked = new Promise((resolve) => { unblock = resolve; });
  const release = releaseFor(Buffer.from('busy-installer'));
  const bridge = createAutoUpdaterBridge({
    platform: 'win32',
    currentVersion: '1.0.0',
    tempDir: root,
    fetchImpl: async () => {
      releaseFetch();
      await blocked;
      return response(release);
    },
    publisherNames: ['CN=Test Release Signer'],
    publisherThumbprints: ['ab'.repeat(32)],
  });
  const checking = bridge.check();
  await entered;
  assert.deepEqual(await bridge.download(), { ok: false, reason: 'updater-busy', operation: 'check' });
  unblock();
  assert.equal((await checking).available, true);
});
