#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const packageInfo = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
const APPLICATION_UPDATE_API_URL = 'https://api.github.com/repos/Xujiuj/ai4mathmodel/releases/latest';
const COMPONENT_UPDATE_BASE_URL = 'https://github.com/Xujiuj/ai4mathmodel/releases/download/runtime-v1';

function readEnv(name) {
  return String(process.env[name] || '').trim();
}

function isPlaceholderUrl(value) {
  return /(?:^|[^\w-])(example\.com|dl\.example\.com)(?:[^\w-]|$)/i.test(value)
    || /\$\{[^}]+\}/.test(value)
    || /placeholder/i.test(value);
}

function normalizeUrl(value, label, blockers) {
  if (!value) {
    blockers.push(`${label} is required for signed release`);
    return '';
  }
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') blockers.push(`${label} must use HTTPS`);
    if (isPlaceholderUrl(url.hostname) || isPlaceholderUrl(url.pathname)) {
      blockers.push(`${label} must not use an example or placeholder origin`);
    }
    return url.toString().replace(/\/$/, '');
  } catch {
    blockers.push(`${label} must be a valid HTTPS URL`);
    return '';
  }
}

function normalizeSigningCert(value, blockers) {
  const encoded = String(value || '').trim();
  if (!encoded) {
    blockers.push('WINDOWS_SIGNING_CERT_B64 is required for signed release');
    return null;
  }
  if (isPlaceholderUrl(encoded) || /replace-with-|change-me|example/i.test(encoded)) {
    blockers.push('WINDOWS_SIGNING_CERT_B64 must not be a placeholder');
    return null;
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    blockers.push('WINDOWS_SIGNING_CERT_B64 must be canonical base64');
    return null;
  }
  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.toString('base64') !== encoded) {
    blockers.push('WINDOWS_SIGNING_CERT_B64 must be canonical base64');
    return null;
  }
  if (!decoded.length || decoded.length < 1024) {
    blockers.push('WINDOWS_SIGNING_CERT_B64 is too small to be a PFX payload');
    return null;
  }
  return decoded;
}

function normalizeSha256(value, label, blockers) {
  const digest = String(value || '').trim().toLowerCase().replace(/^sha256:/, '');
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    blockers.push(`${label} must be a 64-character SHA-256 digest`);
    return '';
  }
  return digest;
}

function validateUpdateContract(blockers, { requirePublisher = false } = {}) {
  const update = packageInfo.releaseUpdate || {};
  const apiUrl = normalizeUrl(update.apiUrl, 'package.json releaseUpdate.apiUrl', blockers);
  if (apiUrl && apiUrl !== APPLICATION_UPDATE_API_URL) {
    blockers.push(`package.json releaseUpdate.apiUrl must be ${APPLICATION_UPDATE_API_URL}`);
  }
  if (!/^[A-Za-z0-9_.-]+-$/.test(String(update.assetPrefix || ''))) {
    blockers.push('package.json releaseUpdate.assetPrefix is invalid');
  }
  if (String(update.assetSuffix || '') !== '-Installer.zip') {
    blockers.push('package.json releaseUpdate.assetSuffix must be -Installer.zip');
  }
  const publishers = Array.isArray(update.publisherNames)
    ? update.publisherNames.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  if (requirePublisher && !publishers.length) {
    blockers.push('package.json releaseUpdate.publisherNames must contain the Authenticode signer subject');
  }
  const thumbprints = Array.isArray(update.publisherThumbprints)
    ? update.publisherThumbprints.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  if (requirePublisher && !thumbprints.length) {
    blockers.push('package.json releaseUpdate.publisherThumbprints must contain the signer certificate SHA-256 thumbprint');
  }
}

function readSigningCertificateIdentity() {
  if (process.platform !== 'win32') {
    throw new Error('signed release certificate validation requires Windows');
  }
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$bytes = [Convert]::FromBase64String($env:WINDOWS_SIGNING_CERT_B64)',
    '$flags = [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet',
    '$cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($bytes, $env:WINDOWS_SIGNING_CERT_PASSWORD, $flags)',
    "$identity = [ordered]@{ subject = $cert.Subject; sha256 = $cert.GetCertHashString([System.Security.Cryptography.HashAlgorithmName]::SHA256).ToLowerInvariant() }",
    '[Console]::Out.Write(($identity | ConvertTo-Json -Compress))',
  ].join('; ');
  const result = spawnSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script,
  ], {
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error('WINDOWS_SIGNING_CERT_B64 could not be opened with WINDOWS_SIGNING_CERT_PASSWORD');
  }
  const identity = JSON.parse(String(result.stdout || '').trim());
  const subject = String(identity.subject || '').trim();
  const sha256 = String(identity.sha256 || '').trim().toLowerCase();
  if (!subject || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error('WINDOWS_SIGNING_CERT_B64 did not expose a valid signing identity');
  }
  return { subject, sha256 };
}

function validateSigningPublisherContract(blockers, {
  publisherName,
  publisherSha256,
  certificateSubject,
  certificateSha256,
  publisherNames,
  publisherThumbprints,
} = {}) {
  const expectedName = String(publisherName || '').trim();
  const expectedSha256 = String(publisherSha256 || '').trim().toLowerCase();
  const names = Array.isArray(publisherNames)
    ? publisherNames.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  const thumbprints = Array.isArray(publisherThumbprints)
    ? publisherThumbprints.map((value) => String(value || '').trim()).filter(Boolean)
    : [];

  if (!expectedName) {
    blockers.push('WINDOWS_SIGNING_PUBLISHER_NAME is required for signed release');
  } else {
    if (String(certificateSubject || '').trim() && expectedName !== String(certificateSubject).trim()) {
      blockers.push('WINDOWS_SIGNING_PUBLISHER_NAME must exactly match the PFX certificate Subject');
    }
    if (names.length !== 1 || names[0] !== expectedName) {
      blockers.push('package.json releaseUpdate.publisherNames must contain only WINDOWS_SIGNING_PUBLISHER_NAME');
    }
  }

  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) {
    blockers.push('WINDOWS_SIGNING_PUBLISHER_SHA256 must be a 64-character SHA-256 digest');
  } else {
    if (String(certificateSha256 || '').trim().toLowerCase()
      && expectedSha256 !== String(certificateSha256).trim().toLowerCase()) {
      blockers.push('WINDOWS_SIGNING_PUBLISHER_SHA256 must exactly match the PFX certificate SHA-256 thumbprint');
    }
    if (thumbprints.length !== 1 || thumbprints[0] !== expectedSha256) {
      blockers.push('package.json releaseUpdate.publisherThumbprints must contain only WINDOWS_SIGNING_PUBLISHER_SHA256');
    }
  }
}

function validateComponentUpdateContract(blockers) {
  const update = packageInfo.componentUpdate || {};
  const baseUrl = normalizeUrl(update.baseUrl, 'package.json componentUpdate.baseUrl', blockers);
  if (baseUrl && baseUrl !== COMPONENT_UPDATE_BASE_URL) {
    blockers.push(`package.json componentUpdate.baseUrl must be ${COMPONENT_UPDATE_BASE_URL}`);
  }

  const encodedKey = String(update.manifestPublicKey || '').trim();
  if (!encodedKey) {
    blockers.push('package.json componentUpdate.manifestPublicKey is required');
    return;
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encodedKey) || encodedKey.length % 4 !== 0) {
    blockers.push('package.json componentUpdate.manifestPublicKey must be canonical base64');
    return;
  }
  try {
    const der = Buffer.from(encodedKey, 'base64');
    if (!der.length || der.toString('base64') !== encodedKey) {
      blockers.push('package.json componentUpdate.manifestPublicKey must be canonical base64');
      return;
    }
    const publicKey = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
    if (publicKey.asymmetricKeyType !== 'ed25519') {
      blockers.push('package.json componentUpdate.manifestPublicKey must be an Ed25519 SPKI public key');
    }
  } catch {
    blockers.push('package.json componentUpdate.manifestPublicKey must be an Ed25519 SPKI public key');
  }
}

function collectBlockers(mode) {
  const blockers = [];
  validateUpdateContract(blockers, { requirePublisher: mode === 'signed' });
  validateComponentUpdateContract(blockers);

  if (mode === 'signed') {
    const certificate = normalizeSigningCert(readEnv('WINDOWS_SIGNING_CERT_B64'), blockers);
    const password = readEnv('WINDOWS_SIGNING_CERT_PASSWORD');
    if (!password) {
      blockers.push('WINDOWS_SIGNING_CERT_PASSWORD is required for signed release');
    }
    const publisherName = readEnv('WINDOWS_SIGNING_PUBLISHER_NAME');
    const publisherSha256 = normalizeSha256(
      readEnv('WINDOWS_SIGNING_PUBLISHER_SHA256'),
      'WINDOWS_SIGNING_PUBLISHER_SHA256',
      blockers,
    );
    let certificateIdentity = {};
    if (certificate && password) {
      try {
        certificateIdentity = readSigningCertificateIdentity();
      } catch (error) {
        blockers.push(error.message);
      }
    }
    validateSigningPublisherContract(blockers, {
      publisherName,
      publisherSha256,
      certificateSubject: certificateIdentity.subject,
      certificateSha256: certificateIdentity.sha256,
      publisherNames: packageInfo.releaseUpdate?.publisherNames,
      publisherThumbprints: packageInfo.releaseUpdate?.publisherThumbprints,
    });
    normalizeUrl(readEnv('RUNTIME_BUNDLE_URL'), 'RUNTIME_BUNDLE_URL', blockers);
    normalizeSha256(readEnv('RUNTIME_BUNDLE_SHA256'), 'RUNTIME_BUNDLE_SHA256', blockers);
  }

  return blockers;
}

function parseArgs(argv) {
  const result = { mode: 'staging', json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--mode') {
      result.mode = String(argv[++index] || '').trim() || 'staging';
    } else if (arg === '--json') {
      result.json = true;
    } else if (arg === '--help' || arg === '-h') {
      result.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!['staging', 'signed'].includes(result.mode)) {
    throw new Error('mode must be staging or signed');
  }
  return result;
}

function formatReport(report) {
  const lines = [
    `Release contract: ${report.mode}`,
    `Artifact mode: ${report.artifactMode}`,
  ];
  if (report.blockers.length) {
    lines.push('External blockers:');
    for (const blocker of report.blockers) lines.push(`- ${blocker}`);
  } else {
    lines.push('External blockers: none');
  }
  return `${lines.join('\n')}\n`;
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write([
      'Usage:',
      '  node scripts/release-contract.cjs --mode staging|signed [--json]',
      '',
      'The script reports release blockers without mutating the workspace.',
    ].join('\n'));
    return 0;
  }

  const blockers = collectBlockers(args.mode);
  const report = {
    project: packageInfo.name,
    version: packageInfo.version,
    mode: args.mode,
    artifactMode: args.mode === 'signed' ? 'signed-github-modular-installer' : 'unsigned-staging',
    blockers,
    signedReady: blockers.length === 0 && args.mode === 'signed',
  };

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(formatReport(report));
  }

  if (blockers.length) return 1;
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  collectBlockers,
  main,
  normalizeSha256,
  normalizeSigningCert,
  normalizeUrl,
  parseArgs,
  readSigningCertificateIdentity,
  validateComponentUpdateContract,
  validateSigningPublisherContract,
  validateUpdateContract,
};
