const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const packageInfo = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
const releaseRoot = path.join(projectRoot, 'release');
const unpackedRoot = path.join(releaseRoot, 'win-unpacked');
const kitRoot = path.join(releaseRoot, `MathModelingWorkbench-${packageInfo.version}-Installer`);
const packagesRoot = path.join(kitRoot, 'packages');
const buildRoot = path.join(kitRoot, '.build');
const runtimeRoot = path.join(projectRoot, 'runtime');
const runtimeExecutableName = 'MathModelingWorkbench.runtime.exe';

function sha256(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function directorySize(root) {
  let total = 0;
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(target);
      if (entry.isFile()) total += fs.statSync(target).size;
    }
  }
  return total;
}

function findExecutable(root, name, pathHint = '') {
  if (!fs.existsSync(root)) return null;
  const pending = [root];
  const matches = [];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(target);
      if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) matches.push(target);
    }
  }
  return matches.sort((left, right) => {
    const leftHint = left.toLowerCase().includes(pathHint.toLowerCase()) ? 0 : 1;
    const rightHint = right.toLowerCase().includes(pathHint.toLowerCase()) ? 0 : 1;
    return leftHint - rightHint || left.localeCompare(right);
  })[0] || null;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || projectRoot,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`${path.basename(command)} failed (${result.status}):\n${result.stdout || ''}\n${result.stderr || ''}`);
  }
  return result;
}

function signWindowsArtifact(target) {
  const signTool = String(process.env.WINDOWS_SIGNTOOL_PATH || '').trim();
  const thumbprint = String(process.env.WINDOWS_SIGNING_CERT_SHA1 || '').replace(/\s/g, '');
  if (!signTool && !thumbprint) return false;
  if (!signTool || !/^[a-f0-9]{40}$/i.test(thumbprint)) {
    throw new Error('Windows signing requires WINDOWS_SIGNTOOL_PATH and a SHA-1 certificate thumbprint.');
  }
  const timestampUrl = String(process.env.WINDOWS_TIMESTAMP_URL || 'http://timestamp.digicert.com').trim();
  run(signTool, ['sign', '/sha1', thumbprint, '/fd', 'SHA256', '/tr', timestampUrl, '/td', 'SHA256', target]);
  run(signTool, ['verify', '/pa', '/all', target]);
  return true;
}

function archiveComponent(sevenZip, { id, sourceRoot, sourceEntry, required = false, reuse = false }) {
  const file = `MathModelingWorkbench-${packageInfo.version}-${id}.7z`;
  const output = path.join(packagesRoot, file);
  if (!reuse || !fs.existsSync(output)) {
    fs.rmSync(output, { force: true });
    run(sevenZip, ['a', '-t7z', '-mx=7', '-mmt=on', output, sourceEntry], { cwd: sourceRoot });
  }
  const source = path.resolve(sourceRoot, sourceEntry.replace(/[\\/]\*$/, ''));
  return {
    id,
    file,
    required,
    sha256: sha256(output),
    bytes: fs.statSync(output).size,
    installedBytes: directorySize(source),
  };
}

function nsisPath(value) {
  return value.replaceAll('"', '$\\"');
}

function writeBomScript(source, target) {
  const content = fs.readFileSync(source, 'utf8').replace(/^\uFEFF/, '');
  fs.writeFileSync(target, `\uFEFF${content}`, 'utf8');
}

function main() {
  if (!fs.existsSync(path.join(unpackedRoot, `${packageInfo.build.productName}.exe`))) {
    throw new Error('Core application directory is missing. Run npm run dist:dir first.');
  }
  for (const component of ['python', 'tectonic']) {
    if (!fs.existsSync(path.join(runtimeRoot, component))) throw new Error(`Runtime source is missing: ${component}`);
  }

  const cacheRoot = path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache');
  const sevenZip = findExecutable(path.join(cacheRoot, '7zip@1.0.0'), '7za.exe', `${path.sep}bin${path.sep}`)
    || findExecutable(path.join(projectRoot, 'node_modules'), '7z.exe', 'electron-winstaller');
  const makensis = findExecutable(path.join(cacheRoot, 'nsis-3.0.4.1'), 'makensis.exe', `${path.sep}Bin${path.sep}`);
  if (!sevenZip) throw new Error('7-Zip build tool is unavailable. Run electron-builder once to seed its cache.');
  if (!makensis) throw new Error('NSIS compiler is unavailable. Run electron-builder once to seed its cache.');

  const reuse = process.argv.includes('--reuse');
  if (!reuse) fs.rmSync(kitRoot, { recursive: true, force: true });
  fs.rmSync(buildRoot, { recursive: true, force: true });
  fs.mkdirSync(packagesRoot, { recursive: true });
  const expectedPayloads = new Set(['core', 'python', 'tectonic']
    .map((id) => `MathModelingWorkbench-${packageInfo.version}-${id}.7z`));
  for (const entry of fs.readdirSync(packagesRoot, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.7z') && !expectedPayloads.has(entry.name)) {
      fs.rmSync(path.join(packagesRoot, entry.name), { force: true });
    }
  }
  fs.mkdirSync(buildRoot, { recursive: true });

  const quadVersion = `${packageInfo.version}.0`.split('.').slice(0, 4).join('.');
  const stagingRoot = path.join(releaseRoot, '.installer-core-staging');
  fs.rmSync(stagingRoot, { recursive: true, force: true });
  fs.cpSync(unpackedRoot, stagingRoot, { recursive: true, force: true });
  const electronExecutable = path.join(stagingRoot, `${packageInfo.build.productName}.exe`);
  const runtimeExecutable = path.join(stagingRoot, runtimeExecutableName);
  fs.renameSync(electronExecutable, runtimeExecutable);
  const launcherScript = path.join(buildRoot, 'launcher.nsi');
  writeBomScript(path.join(projectRoot, 'installer', 'launcher.nsi'), launcherScript);
  const launcherExecutable = path.join(stagingRoot, `${packageInfo.build.productName}.exe`);
  run(makensis, [
    '/V2',
    `/DPRODUCT_VERSION=${packageInfo.version}`,
    `/DPRODUCT_VERSION_QUAD=${quadVersion}`,
    `/DLAUNCHER_OUTPUT=${nsisPath(launcherExecutable)}`,
    `/DICON_FILE=${nsisPath(path.join(projectRoot, 'build', 'app-icon.ico'))}`,
    launcherScript,
  ]);
  signWindowsArtifact(launcherExecutable);
  const entryExecutableBytes = fs.statSync(launcherExecutable).size;
  if (entryExecutableBytes >= 1024 * 1024) throw new Error(`Application launcher is too large: ${entryExecutableBytes} bytes`);

  const packages = [
    archiveComponent(sevenZip, { id: 'core', sourceRoot: stagingRoot, sourceEntry: '.\\*', required: true, reuse: reuse && !process.argv.includes('--rebuild-core') }),
    archiveComponent(sevenZip, { id: 'python', sourceRoot: runtimeRoot, sourceEntry: 'python', reuse }),
    archiveComponent(sevenZip, { id: 'tectonic', sourceRoot: runtimeRoot, sourceEntry: 'tectonic', reuse }),
  ];
  const manifest = {
    schemaVersion: 1,
    product: packageInfo.name,
    version: packageInfo.version,
    architecture: 'x64',
    entryExecutable: {
      file: `${packageInfo.build.productName}.exe`,
      bytes: entryExecutableBytes,
      runtimeFile: runtimeExecutableName,
    },
    packages,
  };
  const manifestFile = path.join(kitRoot, 'payload-manifest.json');
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const defines = packages.map((item) => {
    const prefix = item.id.toUpperCase();
    return [
      `!define ${prefix}_FILE "${item.file}"`,
      `!define ${prefix}_SHA256 "${item.sha256}"`,
      `!define ${prefix}_SIZE_KB "${Math.ceil(item.installedBytes / 1024)}"`,
    ].join('\n');
  }).join('\n');
  const definesFile = path.join(buildRoot, 'payloads.nsh');
  fs.writeFileSync(definesFile, `${defines}\n`, 'utf8');
  const installerScript = path.join(buildRoot, 'installer.nsi');
  writeBomScript(path.join(projectRoot, 'installer', 'installer.nsi'), installerScript);

  const setupFile = path.join(kitRoot, `MathModelingWorkbench-${packageInfo.version}-Setup.exe`);
  run(makensis, [
    '/V3',
    `/DPRODUCT_VERSION=${packageInfo.version}`,
    `/DPRODUCT_VERSION_QUAD=${quadVersion}`,
    `/DOUTPUT_FILE=${nsisPath(setupFile)}`,
    `/DPAYLOAD_DEFINES=${nsisPath(definesFile)}`,
    `/DPAYLOAD_MANIFEST=${nsisPath(manifestFile)}`,
    `/DSEVEN_ZIP_EXE=${nsisPath(sevenZip)}`,
    `/DICON_FILE=${nsisPath(path.join(projectRoot, 'build', 'app-icon.ico'))}`,
    installerScript,
  ]);
  signWindowsArtifact(setupFile);

  fs.rmSync(stagingRoot, { recursive: true, force: true });
  fs.rmSync(buildRoot, { recursive: true, force: true });
  const setupMiB = (fs.statSync(setupFile).size / 1024 / 1024).toFixed(2);
  const payloadMiB = (packages.reduce((sum, item) => sum + item.bytes, 0) / 1024 / 1024).toFixed(2);
  process.stdout.write(`Modular installer built: ${setupFile} (${setupMiB} MiB entry, ${payloadMiB} MiB external payloads)\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
}
