const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const PACKAGE_INFO = require('../package.json');
const DEFAULT_LATEST_RELEASE_URL = String(PACKAGE_INFO.releaseUpdate?.apiUrl || '').trim();
const RELEASE_ASSET_PREFIX = String(PACKAGE_INFO.releaseUpdate?.assetPrefix || '').trim();
const RELEASE_ASSET_SUFFIX = String(PACKAGE_INFO.releaseUpdate?.assetSuffix || '').trim();
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_UPDATE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 64;
const MAX_EXTRACTED_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRY_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_INSTALLED_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 200;
const MAX_REDIRECTS = 4;
const NETWORK_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 60 * 60_000;
const DOWNLOAD_IDLE_TIMEOUT_MS = 90_000;
const INSTALL_COMMAND_TIMEOUT_MS = 2 * 60_000;
const STALE_UPDATE_AGE_MS = 24 * 60 * 60_000;
const SAFE_GITHUB_HOSTS = new Set([
  'api.github.com',
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);

function normalizeSignerSubjects(value) {
  const values = Array.isArray(value) ? value : [value];
  return values.map((subject) => String(subject || '').trim()).filter(Boolean);
}

function normalizeSignerThumbprint(value) {
  return String(value || '').replace(/[\s:-]/g, '').toUpperCase();
}

function normalizeSignerThumbprints(value) {
  const values = Array.isArray(value) ? value : [value];
  return values.map(normalizeSignerThumbprint).filter(Boolean);
}

const CONFIGURED_SIGNER_SUBJECTS = normalizeSignerSubjects(PACKAGE_INFO.releaseUpdate?.publisherNames);
const CONFIGURED_SIGNER_THUMBPRINTS = normalizeSignerThumbprints(PACKAGE_INFO.releaseUpdate?.publisherThumbprints);
const INSTALLER_PACKAGE_IDS = Object.freeze(['core', 'python', 'tectonic']);

function powershellUtf8Expression(value) {
  const encoded = Buffer.from(String(value || ''), 'utf8').toString('base64');
  return `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))`;
}

function repositoryFromLatestReleaseUrl(value) {
  const url = safeGithubUrl(value, { api: true });
  const match = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/releases\/latest$/i);
  if (!match) throw new Error('Updater API repository invalid');
  return `${decodeURIComponent(match[1])}/${decodeURIComponent(match[2])}`.toLowerCase();
}

function expectedSetupName(version) {
  if (!parseSemver(version) || !RELEASE_ASSET_PREFIX) throw new Error('Updater installer version invalid');
  return `${RELEASE_ASSET_PREFIX}${version}-Setup.exe`;
}

function validateArchiveEntryPath(entryName) {
  const name = String(entryName || '').replace(/\\/g, '/');
  const segments = name.split('/');
  if (!name || name.startsWith('/') || /^[A-Za-z]:/.test(name) || segments.includes('..') || name.includes('\0')) {
    throw new Error('Installer archive path invalid');
  }
  return name;
}

function parseSemver(value) {
  const match = String(value || '').trim().replace(/^v/i, '').match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/);
  if (!match) return null;
  if (match[4]?.split('.').some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) return null;
  const [major, minor, patch] = match.slice(1, 4).map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  return { major, minor, patch, prerelease: match[4] || '' };
}

function compareNumericIdentifier(left, right) {
  if (left.length !== right.length) return left.length > right.length ? 1 : -1;
  if (left === right) return 0;
  return left > right ? 1 : -1;
}

function compareSemver(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) return null;
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  if (!a.prerelease && b.prerelease) return 1;
  if (a.prerelease && !b.prerelease) return -1;
  if (a.prerelease === b.prerelease) return 0;
  const aParts = a.prerelease.split('.');
  const bParts = b.prerelease.split('.');
  for (let index = 0; index < Math.max(aParts.length, bParts.length); index += 1) {
    if (index >= aParts.length) return -1;
    if (index >= bParts.length) return 1;
    const leftPart = aParts[index];
    const rightPart = bParts[index];
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      const compared = compareNumericIdentifier(leftPart, rightPart);
      if (compared) return compared;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    if (leftPart !== rightPart) return leftPart > rightPart ? 1 : -1;
  }
  return 0;
}

function safeGithubUrl(value, { api = false, release = false, repository = '' } = {}) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    throw new Error('Updater URL invalid');
  }
  if (url.protocol !== 'https:' || !SAFE_GITHUB_HOSTS.has(url.hostname.toLowerCase())) throw new Error('Updater URL must use GitHub HTTPS');
  if (api && url.hostname !== 'api.github.com') throw new Error('Updater API host invalid');
  if (release) {
    const releasePrefix = repository ? `/${repository.toLowerCase()}/releases/download/` : '';
    if (url.hostname !== 'github.com' || !url.pathname.toLowerCase().startsWith(releasePrefix) || !url.pathname.includes('/releases/download/')) {
      throw new Error('Updater asset URL invalid');
    }
  }
  return url;
}

async function withTimeout(operation, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchGithub(fetchImpl, value, { api = false, release = false, repository = '', maxBytes, timeoutMs, accept, readBody = true }) {
  let url = safeGithubUrl(value, { api, release, repository });
  const deadline = Date.now() + timeoutMs;
  const remaining = () => {
    const milliseconds = deadline - Date.now();
    if (milliseconds <= 0) throw new Error('Updater request timed out');
    return milliseconds;
  };
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const controller = new AbortController();
    const response = await withTimeout(
      () => fetchImpl(url.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: { Accept: accept || 'application/vnd.github+json', 'User-Agent': 'MathModelingWorkbench-Updater' },
      }),
      remaining(),
      'Updater request timed out',
    ).catch((error) => { controller.abort(); throw error; });
    if (response.status >= 300 && response.status < 400) {
      try {
        const location = response.headers?.get?.('location');
        if (!location || redirects === MAX_REDIRECTS) throw new Error('Updater redirect invalid');
        // Redirects may land on GitHub's release CDN hosts, but never outside
        // the fixed HTTPS GitHub host allowlist.
        const redirected = new URL(location, url);
        url = redirected.hostname.toLowerCase() === 'github.com' && release
          ? safeGithubUrl(redirected.toString(), { release: true, repository })
          : safeGithubUrl(redirected.toString(), { api: api && redirected.hostname.toLowerCase() === 'api.github.com' });
      } finally {
        controller.abort();
      }
      continue;
    }
    if (!response.ok) {
      controller.abort();
      throw new Error(`Updater request failed: ${response.status || 0}`);
    }
    const declared = Number(response.headers?.get?.('content-length') || 0);
    if (declared > maxBytes) {
      controller.abort();
      throw new Error('Updater response too large');
    }
    if (!readBody) return { response, bytes: null, url, controller, deadline };
    try {
      const bytes = Buffer.from(await withTimeout(() => response.arrayBuffer(), remaining(), 'Updater response timed out'));
      if (bytes.length > maxBytes) throw new Error('Updater response too large');
      return { response, bytes, url };
    } finally {
      controller.abort();
    }
  }
  throw new Error('Updater redirect limit exceeded');
}

function releaseVersion(release) {
  const candidates = [release?.tag_name, release?.name].map(parseSemver).filter(Boolean);
  return candidates[0] ? `${candidates[0].major}.${candidates[0].minor}.${candidates[0].patch}${candidates[0].prerelease ? `-${candidates[0].prerelease}` : ''}` : '';
}

function selectRelease(release, currentVersion, { repository = repositoryFromLatestReleaseUrl(DEFAULT_LATEST_RELEASE_URL) } = {}) {
  if (!release || release.draft || release.prerelease) throw new Error('Updater release unavailable');
  const version = releaseVersion(release);
  if (!version || compareSemver(version, currentVersion) === null) throw new Error('Updater release version invalid');
  if (compareSemver(version, currentVersion) <= 0) return null;
  const assetName = `${RELEASE_ASSET_PREFIX}${version}${RELEASE_ASSET_SUFFIX}`;
  const asset = (Array.isArray(release.assets) ? release.assets : []).find((item) => item?.name === assetName);
  if (!asset) throw new Error('Updater installer asset missing');
  const digest = String(asset.digest || '').trim().toLowerCase();
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error('Updater asset digest missing');
  const size = Number(asset.size);
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_UPDATE_BYTES) throw new Error('Updater asset size invalid');
  const url = safeGithubUrl(asset.browser_download_url || asset.url, { release: true, repository });
  return { version, assetName, digest: digest.slice(7), size, url: url.toString(), repository, release };
}

async function hashFile(filePath, expectedSize, timeoutMs = DOWNLOAD_TIMEOUT_MS) {
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  const stream = fs.createReadStream(filePath);
  try {
    await withTimeout(() => new Promise((resolve, reject) => {
      stream.on('data', (chunk) => { bytes += chunk.length; hash.update(chunk); });
      stream.on('end', resolve);
      stream.on('error', reject);
    }), timeoutMs, 'Updater file verification timed out');
  } catch (error) {
    stream.destroy();
    throw error;
  }
  if (bytes !== expectedSize) throw new Error('Updater file size mismatch');
  return hash.digest('hex');
}

async function validateInstallerKit(workDir, version) {
  const setupName = expectedSetupName(version);
  const expectedTopLevel = new Set([setupName.toLowerCase(), 'payload-manifest.json', 'packages']);
  const topLevel = await fsp.readdir(workDir, { withFileTypes: true });
  if (topLevel.length !== expectedTopLevel.size || topLevel.some((entry) => !expectedTopLevel.has(entry.name.toLowerCase()))) {
    throw new Error('Installer archive contents invalid');
  }

  const setupPath = path.join(workDir, setupName);
  const setupStat = await fsp.lstat(setupPath);
  if (!setupStat.isFile() || setupStat.isSymbolicLink()) throw new Error('Installer executable missing');

  const manifestPath = path.join(workDir, 'payload-manifest.json');
  const manifestStat = await fsp.lstat(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size < 2 || manifestStat.size > MAX_METADATA_BYTES) {
    throw new Error('Installer manifest invalid');
  }
  let manifest;
  try {
    manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  } catch {
    throw new Error('Installer manifest invalid');
  }
  if (manifest?.schemaVersion !== 1 || manifest?.product !== PACKAGE_INFO.name || manifest?.version !== version || manifest?.architecture !== 'x64') {
    throw new Error('Installer manifest invalid');
  }

  const packagesDir = path.join(workDir, 'packages');
  const packagesStat = await fsp.lstat(packagesDir);
  if (!packagesStat.isDirectory() || packagesStat.isSymbolicLink()) throw new Error('Installer packages invalid');
  const packageEntries = await fsp.readdir(packagesDir, { withFileTypes: true });
  const packages = Array.isArray(manifest.packages) ? manifest.packages : [];
  if (packages.length !== INSTALLER_PACKAGE_IDS.length || packageEntries.length !== INSTALLER_PACKAGE_IDS.length) {
    throw new Error('Installer packages invalid');
  }

  const packageById = new Map(packages.map((item) => [String(item?.id || ''), item]));
  let installedBytes = 0;
  for (const id of INSTALLER_PACKAGE_IDS) {
    const item = packageById.get(id);
    const expectedFile = `${RELEASE_ASSET_PREFIX}${version}-${id}.7z`;
    if (!item || item.file !== expectedFile || !/^[a-f0-9]{64}$/.test(String(item.sha256 || '')) || !Number.isSafeInteger(item.bytes) || item.bytes < 1 || item.bytes > MAX_ARCHIVE_ENTRY_BYTES
      || !Number.isSafeInteger(item.installedBytes) || item.installedBytes < item.bytes || item.installedBytes > MAX_INSTALLED_BYTES) {
      throw new Error('Installer packages invalid');
    }
    installedBytes += item.installedBytes;
    if (installedBytes > MAX_INSTALLED_BYTES) throw new Error('Installer installed size invalid');
    const entry = packageEntries.find((candidate) => candidate.name === expectedFile);
    if (!entry?.isFile() || entry.isSymbolicLink?.()) throw new Error('Installer packages invalid');
    const packagePath = path.join(packagesDir, expectedFile);
    const digest = await hashFile(packagePath, item.bytes);
    if (digest !== item.sha256) throw new Error('Installer package digest mismatch');
  }
  const fileSystem = await fsp.statfs(workDir);
  const availableBytes = Number(fileSystem.bavail) * Number(fileSystem.bsize);
  if (Number.isFinite(availableBytes) && availableBytes < installedBytes + 536_870_912) {
    throw new Error('Installer disk space insufficient');
  }
  return setupPath;
}

async function downloadRelease({ fetchImpl, release, target, progress = () => {}, timeoutMs = DOWNLOAD_TIMEOUT_MS }) {
  const temporary = `${target}.${process.pid}.${Date.now()}.part`;
  await fsp.mkdir(path.dirname(target), { recursive: true });
  try {
    const { response, controller } = await fetchGithub(fetchImpl, release.url, {
      release: true,
      repository: release.repository,
      maxBytes: MAX_UPDATE_BYTES,
      timeoutMs: Math.min(timeoutMs, NETWORK_TIMEOUT_MS),
      accept: 'application/octet-stream',
      readBody: false,
    });
    let file = null;
    let reader = null;
    let streamComplete = false;
    try {
      const declared = Number(response.headers?.get?.('content-length') || 0);
      if (declared && declared !== release.size) throw new Error('Updater asset size mismatch');
      file = await fsp.open(temporary, 'wx', 0o600);
      const hash = crypto.createHash('sha256');
      let received = 0;
      const deadline = Date.now() + timeoutMs;
      const remaining = () => {
        const milliseconds = deadline - Date.now();
        if (milliseconds <= 0) throw new Error('Updater download timed out');
        return milliseconds;
      };
      reader = response.body?.getReader?.();
      if (reader) {
        for (;;) {
          const chunk = await withTimeout(() => reader.read(), Math.min(remaining(), DOWNLOAD_IDLE_TIMEOUT_MS), 'Updater download timed out');
          if (chunk.done) { streamComplete = true; break; }
          const bytes = Buffer.from(chunk.value || []);
          received += bytes.length;
          if (received > release.size || received > MAX_UPDATE_BYTES) throw new Error('Updater asset size mismatch');
          hash.update(bytes);
          await file.write(bytes);
          progress({ percent: (received / release.size) * 100, received, total: release.size });
        }
      } else {
        const bytes = Buffer.from(await withTimeout(() => response.arrayBuffer(), remaining(), 'Updater download timed out'));
        streamComplete = true;
        received = bytes.length;
        if (received > release.size || received > MAX_UPDATE_BYTES) throw new Error('Updater asset size mismatch');
        hash.update(bytes);
        await file.write(bytes);
        progress({ percent: (received / release.size) * 100, received, total: release.size });
      }
      if (received !== release.size || hash.digest('hex') !== release.digest) throw new Error('Updater asset digest mismatch');
    } finally {
      controller.abort();
      if (!streamComplete && reader?.cancel) {
        await withTimeout(() => reader.cancel(), 1_000, 'Updater stream cancellation timed out').catch(() => {});
      }
      await file?.close?.();
    }
    await fsp.rename(temporary, target);
    return target;
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function defaultPrepareInstaller(zipPath, workDir, version) {
  const setupName = expectedSetupName(version);
  const powershell = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe';
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip=${powershellUtf8Expression(zipPath)}; $dest=${powershellUtf8Expression(workDir)}; $setup=${powershellUtf8Expression(setupName)}; $root=[IO.Path]::GetFullPath($dest)+[IO.Path]::DirectorySeparatorChar; $archive=[System.IO.Compression.ZipFile]::OpenRead($zip); try{if($archive.Entries.Count -lt 4 -or $archive.Entries.Count -gt ${MAX_ARCHIVE_ENTRIES}){throw 'Installer archive entry count invalid'}; [Int64]$total=0; $hasSetup=$false; $hasManifest=$false; $packageCount=0; foreach($entry in $archive.Entries){$name=$entry.FullName.Replace('\\','/'); $parts=$name.Split('/'); $target=[IO.Path]::GetFullPath((Join-Path $dest $name)); $unixType=(($entry.ExternalAttributes -shr 16) -band 0xF000); $windowsAttrs=($entry.ExternalAttributes -band 0xFFFF); if(-not $name -or [IO.Path]::IsPathRooted($name) -or $parts -contains '..' -or $name.Contains([char]0) -or -not $target.StartsWith($root,[StringComparison]::OrdinalIgnoreCase) -or $unixType -eq 0xA000 -or ($windowsAttrs -band 0x400) -ne 0){throw 'Installer archive path invalid'}; $isDirectory=$name.EndsWith('/'); $allowed=($name -ceq $setup) -or ($name -ceq 'payload-manifest.json') -or ($name -ceq 'packages/') -or (($parts.Count -eq 2) -and ($parts[0] -ceq 'packages') -and -not $isDirectory -and $parts[1]); if(-not $allowed){throw 'Installer archive contents invalid'}; if($name -ceq $setup){$hasSetup=$true}; if($name -ceq 'payload-manifest.json'){$hasManifest=$true}; if(($parts.Count -eq 2) -and ($parts[0] -ceq 'packages') -and -not $isDirectory){$packageCount++}; if($entry.Length -lt 0 -or $entry.Length -gt ${MAX_ARCHIVE_ENTRY_BYTES}){throw 'Installer archive entry too large'}; $total+=$entry.Length; if($total -gt ${MAX_EXTRACTED_BYTES}){throw 'Installer archive expanded size invalid'}; if($entry.Length -gt 1048576 -and $entry.CompressedLength -gt 0 -and ($entry.Length / $entry.CompressedLength) -gt ${MAX_COMPRESSION_RATIO}){throw 'Installer archive compression ratio invalid'}}; if(-not $hasSetup -or -not $hasManifest -or $packageCount -ne ${INSTALLER_PACKAGE_IDS.length}){throw 'Installer archive contents invalid'}; $drive=[IO.DriveInfo]::new([IO.Path]::GetPathRoot($dest)); if($drive.AvailableFreeSpace -lt ($total + 536870912)){throw 'Installer archive disk space insufficient'}}finally{$archive.Dispose()}; Expand-Archive -LiteralPath $zip -DestinationPath $dest -Force; $reparse=@(Get-ChildItem -LiteralPath $dest -Force -Recurse | Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 }); if($reparse.Count){throw 'Installer archive path invalid'}; 'ok'`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  await execFileAsync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true, maxBuffer: 1024 * 1024, timeout: DOWNLOAD_TIMEOUT_MS });
  return validateInstallerKit(workDir, version);
}

function parseAuthenticodeResult(stdout) {
  let result;
  try {
    result = JSON.parse(String(stdout || '').trim());
  } catch {
    throw new Error('Installer signature result invalid');
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Installer signature result invalid');
  return {
    status: String(result.status || ''),
    subject: String(result.subject || ''),
    thumbprint: normalizeSignerThumbprint(result.thumbprint),
  };
}

async function defaultVerifyAuthenticode(
  setupPath,
  publisherNames = CONFIGURED_SIGNER_SUBJECTS,
  publisherThumbprints = CONFIGURED_SIGNER_THUMBPRINTS,
  execFileImpl = execFileAsync,
) {
  const signerSubjects = normalizeSignerSubjects(publisherNames);
  const signerThumbprints = normalizeSignerThumbprints(publisherThumbprints);
  if (!signerSubjects.length) throw new Error('Installer signer subject is not configured');
  if (!signerThumbprints.length || signerThumbprints.some((thumbprint) => !/^[A-F0-9]{64}$/.test(thumbprint))) {
    throw new Error('Installer signer thumbprint is not configured');
  }
  const powershell = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe';
  const script = [
    "$ErrorActionPreference='Stop'",
    `$setup=${powershellUtf8Expression(setupPath)}`,
    '$sig=Get-AuthenticodeSignature -LiteralPath $setup',
    "$subject=if($sig.SignerCertificate){[string]$sig.SignerCertificate.Subject}else{''}",
    "$thumbprint=if($sig.SignerCertificate){$hasher=[Security.Cryptography.SHA256]::Create();try{([BitConverter]::ToString($hasher.ComputeHash($sig.SignerCertificate.RawData))).Replace('-','')}finally{$hasher.Dispose()}}else{''}",
    '[ordered]@{status=[string]$sig.Status;subject=$subject;thumbprint=$thumbprint} | ConvertTo-Json -Compress',
  ].join('; ');
  const { stdout } = await execFileImpl(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, maxBuffer: 1024 * 1024, timeout: INSTALL_COMMAND_TIMEOUT_MS });
  const result = parseAuthenticodeResult(stdout);
  if (result.status !== 'Valid') throw new Error('Installer signature invalid');
  if (!signerSubjects.includes(result.subject)) throw new Error('Installer signer subject mismatch');
  if (!signerThumbprints.includes(result.thumbprint)) throw new Error('Installer signer thumbprint mismatch');
  return true;
}

function defaultLaunchInstaller(setupPath, spawnImpl = spawn) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(setupPath, ['/S'], { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('spawn', () => {
      child.removeListener('error', reject);
      child.unref();
      resolve(true);
    });
  });
}

async function cleanupStaleUpdateFiles(tempDir, { now = Date.now(), maxAgeMs = STALE_UPDATE_AGE_MS } = {}) {
  let entries;
  try {
    entries = await fsp.readdir(tempDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
  let removed = 0;
  for (const entry of entries) {
    const removable = (entry.isDirectory() && entry.name.startsWith('mmw-installer-'))
      || (entry.isFile() && (entry.name.endsWith('.zip') || entry.name.includes('.part')));
    if (!removable) continue;
    const target = path.join(tempDir, entry.name);
    const stat = await fsp.stat(target).catch(() => null);
    if (!stat || now - stat.mtimeMs < maxAgeMs) continue;
    await fsp.rm(target, { recursive: entry.isDirectory(), force: true }).catch(() => {});
    removed += 1;
  }
  return removed;
}

async function createPrivateStagingDirectory(tempDir) {
  await fsp.mkdir(tempDir, { recursive: true, mode: 0o700 });
  await fsp.chmod(tempDir, 0o700).catch(() => {});
  const workDir = await fsp.mkdtemp(path.join(tempDir, `mmw-installer-${crypto.randomUUID()}-`));
  await fsp.chmod(workDir, 0o700).catch(() => {});
  return workDir;
}

function createAutoUpdaterBridge({
  isDev = false,
  send = () => {},
  log = console,
  fetchImpl = globalThis.fetch,
  latestReleaseUrl = DEFAULT_LATEST_RELEASE_URL,
  currentVersion = PACKAGE_INFO.version,
  tempDir = os.tmpdir(),
  platform = process.platform,
  publisherNames = CONFIGURED_SIGNER_SUBJECTS,
  publisherThumbprints = CONFIGURED_SIGNER_THUMBPRINTS,
  prepareInstaller = defaultPrepareInstaller,
  verifyAuthenticode = defaultVerifyAuthenticode,
  launchInstaller = defaultLaunchInstaller,
  quit = null,
} = {}) {
  let selected = null;
  let downloaded = '';
  let busy = '';
  let cleanupPromise = null;
  const enabled = !isDev && platform === 'win32';
  const customVerifier = verifyAuthenticode !== defaultVerifyAuthenticode;
  const signerSubjects = normalizeSignerSubjects(publisherNames);
  const signerThumbprints = normalizeSignerThumbprints(publisherThumbprints);
  let repository = '';
  const emit = (type, payload = {}) => send({ type, ...payload, at: Date.now() });
  const ensureCleanup = () => {
    cleanupPromise ||= cleanupStaleUpdateFiles(tempDir).catch((error) => {
      log?.warn?.(error);
      return 0;
    });
    return cleanupPromise;
  };
  const unsupported = () => ({ ok: false, reason: isDev ? 'dev-mode' : platform === 'win32' ? 'updater-unavailable' : 'platform-unsupported' });
  const ensureSignerAllowlist = () => {
    if (!customVerifier && (!signerSubjects.length || !signerThumbprints.length || signerThumbprints.some((thumbprint) => !/^[A-F0-9]{64}$/.test(thumbprint)))) {
      throw new Error('Installer signer allowlist is not configured');
    }
  };
  const runExclusive = async (operation, task) => {
    if (busy) return { ok: false, reason: 'updater-busy', operation: busy };
    busy = operation;
    try {
      return await task();
    } finally {
      busy = '';
    }
  };
  const checkInternal = async () => {
    if (!enabled || typeof fetchImpl !== 'function') return unsupported();
    await ensureCleanup();
    emit('checking');
    try {
      ensureSignerAllowlist();
      safeGithubUrl(latestReleaseUrl, { api: true });
      repository = repositoryFromLatestReleaseUrl(latestReleaseUrl);
      const { bytes } = await fetchGithub(fetchImpl, latestReleaseUrl, { api: true, maxBytes: MAX_METADATA_BYTES, timeoutMs: NETWORK_TIMEOUT_MS });
      const release = JSON.parse(bytes.toString('utf8'));
      selected = selectRelease(release, currentVersion, { repository });
      if (!selected) { emit('up-to-date'); return { ok: true, current: true, version: currentVersion }; }
      emit('available', { version: selected.version, releaseNotes: release.body || '' });
      return { ok: true, available: true, version: selected.version, release: selected };
    } catch (error) {
      log?.warn?.(error);
      emit('error', { message: error.message });
      return { ok: false, reason: error.message };
    }
  };
  const check = () => runExclusive('check', checkInternal);
  const download = () => runExclusive('download', async () => {
    if (!enabled) return unsupported();
    await ensureCleanup();
    try { ensureSignerAllowlist(); } catch (error) { emit('error', { message: error.message }); return { ok: false, reason: error.message }; }
    if (!selected) {
      const result = await checkInternal();
      if (!result.ok || !selected) return result.ok ? { ok: false, reason: 'no-update' } : result;
    }
    const release = selected;
    if (downloaded) await fsp.rm(downloaded, { force: true }).catch(() => {});
    downloaded = '';
    const target = path.join(tempDir, `${release.assetName}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.zip`);
    try {
      emit('download-progress', { percent: 0 });
      downloaded = await downloadRelease({ fetchImpl, release, target, progress: (event) => emit('download-progress', event) });
      emit('ready', { version: release.version });
      return { ok: true, version: release.version };
    } catch (error) {
      downloaded = '';
      emit('error', { message: error.message });
      return { ok: false, reason: error.message };
    }
  });
  const install = () => runExclusive('install', async () => {
    if (!enabled) return unsupported();
    await ensureCleanup();
    try { ensureSignerAllowlist(); } catch (error) { emit('error', { message: error.message }); return { ok: false, reason: error.message }; }
    if (!selected || !downloaded) return { ok: false, reason: 'update-not-downloaded' };
    const release = selected;
    const archivePath = downloaded;
    let workDir = '';
    let launched = false;
    try {
      const archiveDigest = await hashFile(archivePath, release.size);
      if (archiveDigest !== release.digest) throw new Error('Updater asset digest mismatch');
      workDir = await createPrivateStagingDirectory(tempDir);
      const setupPath = path.resolve(await prepareInstaller(archivePath, workDir, release.version));
      const relativeSetupPath = path.relative(workDir, setupPath);
      if (!relativeSetupPath || relativeSetupPath.startsWith('..') || path.isAbsolute(relativeSetupPath) || path.basename(setupPath).toLowerCase() !== expectedSetupName(release.version).toLowerCase()) {
        throw new Error('Installer executable path invalid');
      }
      let setupDigest = '';
      const setupStat = await fsp.lstat(setupPath).catch((error) => {
        if (customVerifier && error?.code === 'ENOENT') return null;
        throw error;
      });
      if (setupStat) {
        if (!setupStat.isFile() || setupStat.isSymbolicLink()) throw new Error('Installer executable invalid');
        setupDigest = await hashFile(setupPath, setupStat.size);
      }
      await verifyAuthenticode(setupPath, signerSubjects, signerThumbprints);
      const currentArchiveDigest = await hashFile(archivePath, release.size);
      if (currentArchiveDigest !== archiveDigest) throw new Error('Updater asset changed after verification');
      if (setupDigest) {
        const currentSetupStat = await fsp.lstat(setupPath);
        if (!currentSetupStat.isFile() || currentSetupStat.isSymbolicLink()) throw new Error('Installer executable changed after verification');
        const currentSetupDigest = await hashFile(setupPath, currentSetupStat.size);
        if (currentSetupDigest !== setupDigest) throw new Error('Installer executable changed after verification');
        await verifyAuthenticode(setupPath, signerSubjects, signerThumbprints);
      }
      await fsp.rm(archivePath, { force: true });
      downloaded = '';
      await launchInstaller(setupPath);
      launched = true;
      if (typeof quit === 'function') quit();
      else {
        try { require('electron').app.quit(); } catch { /* unit-test / non-Electron fallback */ }
      }
      return { ok: true, version: release.version };
    } catch (error) {
      downloaded = '';
      await fsp.rm(archivePath, { force: true }).catch(() => {});
      if (workDir && !launched) await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
      emit('error', { message: error.message });
      return { ok: false, reason: error.message };
    }
  });
  return { enabled, check, download, install };
}

module.exports = {
  DEFAULT_LATEST_RELEASE_URL,
  MAX_METADATA_BYTES,
  MAX_UPDATE_BYTES,
  compareSemver,
  cleanupStaleUpdateFiles,
  createPrivateStagingDirectory,
  defaultLaunchInstaller,
  defaultPrepareInstaller,
  defaultVerifyAuthenticode,
  expectedSetupName,
  parseSemver,
  repositoryFromLatestReleaseUrl,
  safeGithubUrl,
  selectRelease,
  fetchGithub,
  downloadRelease,
  hashFile,
  normalizeSignerThumbprint,
  normalizeSignerThumbprints,
  parseAuthenticodeResult,
  powershellUtf8Expression,
  validateInstallerKit,
  validateArchiveEntryPath,
  createAutoUpdaterBridge,
};
