const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..');
const packageInfo = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
const {
  normalizeSigningCert,
  parseArgs,
  validateSigningPublisherContract,
} = require('../scripts/release-contract.cjs');

test('ships a modular installer instead of a self-extracting application archive', () => {
  const script = packageInfo.scripts?.['dist:win'] || '';
  assert.equal(packageInfo.build?.win?.target, undefined);
  assert.equal(packageInfo.build?.win?.artifactName, undefined);
  assert.doesNotMatch(script, /\bportable\b|--win zip/i);
  assert.match(script, /build:installer/);
  assert.match(script, /verify:installer/);
});

test('keeps Windows signing options compatible with the installed builder schema', () => {
  assert.equal(packageInfo.build?.win?.signingHashAlgorithms, undefined);
  assert.deepEqual(packageInfo.build?.win?.signtoolOptions?.signingHashAlgorithms, ['sha256']);
});

test('keeps updater code inside the protected runtime and uses the installed Electron distribution', () => {
  assert.equal(packageInfo.dependencies?.['electron-updater'], undefined);
  assert.equal(packageInfo.devDependencies?.['electron-updater'], undefined);
  assert.equal(packageInfo.build?.publish, undefined);
  assert.equal(packageInfo.releaseUpdate?.apiUrl, 'https://api.github.com/repos/Xujiuj/ai4mathmodel/releases/latest');
  assert.equal(packageInfo.releaseUpdate?.assetPrefix, 'MathModelingWorkbench-');
  assert.equal(packageInfo.releaseUpdate?.assetSuffix, '-Installer.zip');
  assert.ok(Array.isArray(packageInfo.releaseUpdate?.publisherNames));
  assert.deepEqual(packageInfo.releaseUpdate?.publisherThumbprints, []);
  assert.match(packageInfo.scripts?.['dist:dir'] || '', /--config\.electronDist=node_modules\/electron\/dist/);
  assert.match(packageInfo.scripts?.['dist:dir'] || '', /verify:package/);
});

test('pins runtime component updates to the production GitHub release and Ed25519 trust root', () => {
  const componentUpdate = packageInfo.componentUpdate || {};
  assert.equal(componentUpdate.baseUrl, 'https://github.com/Xujiuj/ai4mathmodel/releases/download/runtime-v1');
  const baseUrl = new URL(componentUpdate.baseUrl);
  assert.equal(baseUrl.protocol, 'https:');
  assert.equal(baseUrl.hostname, 'github.com');
  assert.equal(baseUrl.pathname, '/Xujiuj/ai4mathmodel/releases/download/runtime-v1');
  assert.doesNotMatch(componentUpdate.baseUrl, /example|placeholder|\$\{/i);

  const encodedKey = String(componentUpdate.manifestPublicKey || '');
  const publicKeyDer = Buffer.from(encodedKey, 'base64');
  assert.equal(publicKeyDer.toString('base64'), encodedKey);
  const publicKey = crypto.createPublicKey({ key: publicKeyDer, type: 'spki', format: 'der' });
  assert.equal(publicKey.asymmetricKeyType, 'ed25519');
});

test('staging release contract fails closed on invalid static component trust configuration', (context) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mmw-release-contract-'));
  context.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(temporaryRoot, 'scripts'));
  fs.copyFileSync(
    path.join(projectRoot, 'scripts', 'release-contract.cjs'),
    path.join(temporaryRoot, 'scripts', 'release-contract.cjs'),
  );
  fs.writeFileSync(path.join(temporaryRoot, 'package.json'), JSON.stringify({
    name: 'release-contract-probe',
    version: '1.0.0',
    releaseUpdate: packageInfo.releaseUpdate,
    componentUpdate: {
      baseUrl: 'http://dl.example.com/runtime',
      manifestPublicKey: 'not-a-public-key',
    },
  }), 'utf8');

  const result = spawnSync(process.execPath, [
    path.join(temporaryRoot, 'scripts', 'release-contract.cjs'),
    '--mode',
    'staging',
  ], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /componentUpdate/);
});

test('release contract rejects an updater API from another repository', (context) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mmw-release-api-'));
  context.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(temporaryRoot, 'scripts'));
  fs.copyFileSync(
    path.join(projectRoot, 'scripts', 'release-contract.cjs'),
    path.join(temporaryRoot, 'scripts', 'release-contract.cjs'),
  );
  fs.writeFileSync(path.join(temporaryRoot, 'package.json'), JSON.stringify({
    name: 'release-contract-probe',
    version: '1.0.0',
    releaseUpdate: {
      ...packageInfo.releaseUpdate,
      apiUrl: 'https://api.github.com/repos/other-owner/other-app/releases/latest',
    },
    componentUpdate: packageInfo.componentUpdate,
  }), 'utf8');

  const result = spawnSync(process.execPath, [
    path.join(temporaryRoot, 'scripts', 'release-contract.cjs'),
    '--mode',
    'staging',
  ], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /releaseUpdate\.apiUrl must be https:\/\/api\.github\.com\/repos\/Xujiuj\/ai4mathmodel\/releases\/latest/);
});

test('signed release publisher must exactly match the certificate and baked allowlist', () => {
  const publisherName = 'CN=Example Release Signing, O=Example Corp, C=US';
  const publisherSha256 = 'ab'.repeat(32);
  const matchingBlockers = [];
  validateSigningPublisherContract(matchingBlockers, {
    publisherName,
    publisherSha256,
    certificateSubject: publisherName,
    certificateSha256: publisherSha256,
    publisherNames: [publisherName],
    publisherThumbprints: [publisherSha256],
  });
  assert.deepEqual(matchingBlockers, []);

  const mismatchBlockers = [];
  validateSigningPublisherContract(mismatchBlockers, {
    publisherName,
    publisherSha256,
    certificateSubject: 'CN=Different Certificate, O=Example Corp, C=US',
    certificateSha256: 'cd'.repeat(32),
    publisherNames: [publisherName, 'CN=Unexpected Rotation'],
    publisherThumbprints: [publisherSha256, 'ef'.repeat(32)],
  });
  assert.match(mismatchBlockers.join('\n'), /must exactly match the PFX certificate Subject/);
  assert.match(mismatchBlockers.join('\n'), /must contain only WINDOWS_SIGNING_PUBLISHER_NAME/);
  assert.match(mismatchBlockers.join('\n'), /must exactly match the PFX certificate SHA-256 thumbprint/);
  assert.match(mismatchBlockers.join('\n'), /must contain only WINDOWS_SIGNING_PUBLISHER_SHA256/);
});

test('release contract rejects unknown modes and non-canonical signing certificate base64', () => {
  assert.throws(() => parseArgs(['--mode', 'preview']), /mode must be staging or signed/);
  const blockers = [];
  const canonical = Buffer.alloc(1024, 1).toString('base64');
  assert.equal(normalizeSigningCert(`${canonical.slice(0, 40)}\n${canonical.slice(40)}`, blockers), null);
  assert.match(blockers.join('\n'), /canonical base64/);
});
