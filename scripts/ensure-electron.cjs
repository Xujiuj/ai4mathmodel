#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const PROJECT_ROOT = path.resolve(__dirname, '..');
const ELECTRON_PACKAGE_NAME = 'electron';

function fail(message) {
  throw new Error(`[ensure:electron] ${message}`);
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    fail(`unable to read ${label}: ${error.message}`);
  }
}

function effectivePlatform(environment = process.env, hostPlatform = process.platform) {
  return environment.ELECTRON_INSTALL_PLATFORM || environment.npm_config_platform || hostPlatform;
}

function platformExecutable(platform) {
  switch (platform) {
    case 'mas':
    case 'darwin':
      return path.join('Electron.app', 'Contents', 'MacOS', 'Electron');
    case 'freebsd':
    case 'openbsd':
    case 'linux':
      return 'electron';
    case 'win32':
      return 'electron.exe';
    default:
      fail(`Electron builds are not available on platform: ${platform}`);
  }
}

function versionSatisfies(spec, version) {
  if (spec === version) return true;
  const exact = /^(?:\^|~)?(\d+)\.(\d+)\.(\d+)$/.exec(spec || '');
  const actual = /^(\d+)\.(\d+)\.(\d+)$/.exec(version || '');
  if (!exact || !actual) return false;
  const requested = exact.slice(1).map(Number);
  const installed = actual.slice(1).map(Number);
  if (installed[0] !== requested[0]) return false;
  if (installed[1] < requested[1] || (installed[1] === requested[1] && installed[2] < requested[2])) return false;
  if (spec.startsWith('~')) return installed[1] === requested[1];
  return spec.startsWith('^') ? true : false;
}

function readElectronContract(projectRoot = PROJECT_ROOT) {
  const packageJsonPath = path.join(projectRoot, 'package.json');
  const lockfilePath = path.join(projectRoot, 'package-lock.json');
  const packageJson = readJson(packageJsonPath, 'package.json');
  const lockfile = readJson(lockfilePath, 'package-lock.json');
  const declaredSpec = packageJson.devDependencies && packageJson.devDependencies[ELECTRON_PACKAGE_NAME];
  if (!declaredSpec || typeof declaredSpec !== 'string') fail('package.json must declare electron as a devDependency');
  const lockEntry = lockfile.packages && lockfile.packages['node_modules/electron'];
  if (!lockEntry || typeof lockEntry.version !== 'string') fail('package-lock.json must lock node_modules/electron');

  const electronRoot = path.join(projectRoot, 'node_modules', ELECTRON_PACKAGE_NAME);
  const electronPackagePath = path.join(electronRoot, 'package.json');
  const installScript = path.join(electronRoot, 'install.js');
  const electronPackage = readJson(electronPackagePath, 'node_modules/electron/package.json');
  if (electronPackage.version !== lockEntry.version) {
    fail(`installed Electron ${electronPackage.version} does not match lockfile ${lockEntry.version}`);
  }
  if (!versionSatisfies(declaredSpec, lockEntry.version)) {
    fail(`package.json electron range ${declaredSpec} does not include locked version ${lockEntry.version}`);
  }
  if (electronPackage.bin?.['install-electron'] !== 'install.js') {
    fail('Electron install-electron entry must point to install.js');
  }
  if (!fs.existsSync(installScript) || !fs.statSync(installScript).isFile()) {
    fail(`Electron install script is missing: ${path.relative(projectRoot, installScript)}`);
  }
  return {
    projectRoot,
    version: lockEntry.version,
    electronRoot,
    electronPackage,
    installScript,
  };
}

function verifyElectronInstallation(contract, environment = process.env, hostPlatform = process.platform) {
  const platform = effectivePlatform(environment, hostPlatform);
  const platformPath = platformExecutable(platform);
  const distRoot = path.join(contract.electronRoot, 'dist');
  const versionPath = path.join(distRoot, 'version');
  const pathFile = path.join(contract.electronRoot, 'path.txt');
  const expectedExecutable = path.join(distRoot, platformPath);
  let installedVersion;
  let installedPath;
  try {
    installedVersion = fs.readFileSync(versionPath, 'utf8').trim().replace(/^v/, '');
    installedPath = fs.readFileSync(pathFile, 'utf8').trim();
  } catch (error) {
    return { ok: false, platform, platformPath, expectedExecutable, reason: `Electron metadata is missing: ${error.message}` };
  }
  if (installedVersion !== contract.version) {
    return { ok: false, platform, platformPath, expectedExecutable, reason: `Electron dist version ${installedVersion} does not match ${contract.version}` };
  }
  if (installedPath !== platformPath) {
    return { ok: false, platform, platformPath, expectedExecutable, reason: `Electron path.txt points to ${installedPath}, expected ${platformPath}` };
  }
  let stat;
  try {
    stat = fs.lstatSync(expectedExecutable);
  } catch (error) {
    return { ok: false, platform, platformPath, expectedExecutable, reason: `Electron executable is missing: ${error.message}` };
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size < 1024) {
    return { ok: false, platform, platformPath, expectedExecutable, reason: 'Electron executable is not a non-empty regular file' };
  }
  return { ok: true, platform, platformPath, expectedExecutable, version: contract.version };
}

function runInstaller(installScript, projectRoot, environment) {
  const result = require('node:child_process').spawnSync(process.execPath, [installScript], {
    cwd: projectRoot,
    env: environment,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) fail(`Electron install.js could not start: ${result.error.message}`);
  if (result.status !== 0) fail(`Electron install.js exited with status ${result.status}`);
}

function ensureElectron({ projectRoot = PROJECT_ROOT, environment = process.env, hostPlatform = process.platform, install = runInstaller } = {}) {
  const contract = readElectronContract(projectRoot);
  const current = verifyElectronInstallation(contract, environment, hostPlatform);
  if (!current.ok) {
    process.stderr.write(`${current.reason}; running the official Electron install.js\n`);
    install(contract.installScript, projectRoot, environment);
  }
  const verified = verifyElectronInstallation(contract, environment, hostPlatform);
  if (!verified.ok) fail(`Electron installation failed closed: ${verified.reason}`);
  process.stdout.write(`Electron ${verified.version} ready (${verified.platform}, ${verified.expectedExecutable})\n`);
  return verified;
}

if (require.main === module) {
  try {
    ensureElectron();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  effectivePlatform,
  platformExecutable,
  readElectronContract,
  verifyElectronInstallation,
  ensureElectron,
};
