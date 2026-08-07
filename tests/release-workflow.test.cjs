const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const yaml = require('yaml');

const projectRoot = path.resolve(__dirname, '..');
const workflow = yaml.parse(fs.readFileSync(path.join(projectRoot, '.github', 'workflows', 'release.yml'), 'utf8'));

function job(name) {
  return workflow.jobs[name];
}

function steps(name) {
  return job(name).steps || [];
}

function findStep(jobName, predicate) {
  return steps(jobName).find(predicate);
}

function findRunStep(jobName, pattern) {
  return findStep(jobName, (step) => typeof step.run === 'string' && pattern.test(step.run));
}

function stepIndex(jobName, predicate) {
  return steps(jobName).findIndex(predicate);
}

test('release workflow audits production dependencies and verifies the runtime contract', () => {
  const contractSteps = steps('contract');

  assert.ok(findRunStep('contract', /npm audit --audit-level=high/));
  assert.equal(findRunStep('contract', /npm audit --omit=dev/), undefined);
  assert.equal(stepIndex('contract', (step) => typeof step.run === 'string' && step.run.includes('npm run verify:runtime')), -1);
  assert.ok(contractSteps.some((step) => step.run === 'node scripts/release-contract.cjs --mode staging'));
});

test('packaging jobs explicitly repair Electron after clean npm ci', () => {
  assert.equal(findRunStep('contract', /npm run ensure:electron/), undefined, 'browser-only contract must not download Electron');
  for (const jobName of ['staging-artifact', 'signed-release']) {
    const ensureIndex = stepIndex(jobName, (step) => step.name === 'Ensure Electron runtime');
    const installIndex = stepIndex(jobName, (step) => step.run === 'npm ci');
    assert.ok(ensureIndex > installIndex, `${jobName} repairs Electron after npm ci`);
    assert.equal(steps(jobName)[ensureIndex].run, 'npm run ensure:electron');
  }
});

test('staging and signed release jobs generate hosted endpoints from secrets before packaging', () => {
  for (const jobName of ['staging-artifact', 'signed-release']) {
    const endpointStep = findStep(jobName, (step) => step.name === 'Generate hosted endpoint config');
    assert.ok(endpointStep, `${jobName} is missing endpoint generation`);
    assert.deepEqual(Object.keys(endpointStep.env).sort(), [
      'MODELING_HOSTED_GATEWAY',
      'MODELING_HOSTED_GATEWAY_CERTIFICATE_FINGERPRINT256',
      'MODELING_HOSTED_PORTAL',
    ]);
    assert.match(endpointStep.run, /Hosted endpoint secrets are required/);
    assert.match(endpointStep.run, /hostedEndpoints\(process\.env\)/);
    assert.match(endpointStep.run, /endpoints\.json/);
    assert.match(endpointStep.run, /MODELING_HOSTED_GATEWAY must use HTTPS/);
    assert.match(endpointStep.run, /MODELING_HOSTED_PORTAL must use HTTPS/);
    assert.match(endpointStep.run, /must end in \/agent/);
    assert.match(endpointStep.run, /gatewayCertificateFingerprint256/);
    assert.match(endpointStep.run, /must be a SHA-256 fingerprint/);
  }
});

test('signed release validates and bakes the production signer contract before packaging', () => {
  const bakeStep = findStep('signed-release', (step) => step.name === 'Bake production signing publisher contract');
  assert.ok(bakeStep);
  assert.deepEqual(Object.keys(bakeStep.env).sort(), [
    'GITHUB_REPOSITORY',
    'WINDOWS_SIGNING_PUBLISHER_NAME',
    'WINDOWS_SIGNING_PUBLISHER_SHA256',
  ]);
  assert.match(bakeStep.run, /GITHUB_REPOSITORY is invalid/);
  assert.match(bakeStep.run, /must not be a placeholder/);
  assert.match(bakeStep.run, /64-character SHA-256 digest/);
  assert.match(bakeStep.run, /releaseUpdate\.publisherNames =/);
  assert.match(bakeStep.run, /releaseUpdate\.publisherThumbprints =/);
  assert.match(bakeStep.run, /releaseUpdate\.apiUrl must target/);

  const contractIndex = stepIndex('signed-release', (step) => step.name === 'Validate signed release contract');
  const bakeIndex = stepIndex('signed-release', (step) => step.name === 'Bake production signing publisher contract');
  const importIndex = stepIndex('signed-release', (step) => step.name === 'Import Windows signing certificate');
  const buildIndex = stepIndex('signed-release', (step) => step.name === 'Build and verify signed modular installer');
  assert.ok(bakeIndex < contractIndex);
  assert.ok(contractIndex < importIndex);
  assert.ok(importIndex < buildIndex);

  const contractStep = steps('signed-release')[contractIndex];
  assert.equal(contractStep.env.GITHUB_REPOSITORY, '${{ github.repository }}');
  const importStep = steps('signed-release')[importIndex];
  assert.match(importStep.run, /Subject does not exactly match/);
  assert.match(importStep.run, /SHA-256 thumbprint does not exactly match/);
  assert.match(importStep.run, /publisherThumbprints/);
});

test('staging release remains unsigned and does not receive production signer inputs', () => {
  assert.match(job('staging-artifact').if, /inputs\.mode == 'staging'/);
  const stagingRuns = steps('staging-artifact').filter((step) => typeof step.run === 'string').map((step) => step.run).join('\n');
  assert.doesNotMatch(stagingRuns, /WINDOWS_SIGNING_PUBLISHER|Import Windows signing certificate|CSC_LINK/);
  assert.ok(findStep('staging-artifact', (step) => step.name === 'Build unsigned staging installer'));
});

test('staging and signed release jobs reject traversal before expanding the runtime zip', () => {
  for (const jobName of ['staging-artifact', 'signed-release']) {
    const bundleStep = findStep(jobName, (step) => step.name === 'Acquire digest-pinned runtime bundle');
    assert.ok(bundleStep, `${jobName} is missing runtime acquisition`);
    assert.match(bundleStep.run, /System\.IO\.Compression\.FileSystem/);
    assert.match(bundleStep.run, /Test-ZipEntryPath/);
    assert.match(bundleStep.run, /Runtime bundle archive path invalid/);
    assert.match(bundleStep.run, /Get-FileHash/);
    assert.match(bundleStep.run, /Expand-Archive/);
    const bundleIndex = stepIndex(jobName, (step) => step.name === 'Acquire digest-pinned runtime bundle');
    const verifyIndex = stepIndex(jobName, (step) => typeof step.run === 'string' && step.run.includes('npm run verify:runtime'));
    const buildIndex = jobName === 'staging-artifact'
      ? stepIndex(jobName, (step) => step.name === 'Build unsigned staging installer')
      : stepIndex(jobName, (step) => step.name === 'Build and verify signed modular installer');

    assert.ok(bundleIndex < verifyIndex, `${jobName} verifies runtime before packaging`);
    assert.ok(verifyIndex < buildIndex, `${jobName} packages only after runtime verification`);
  }
});

test('signed release verifies the immutable GitHub asset digest after upload', () => {
  const createIndex = stepIndex('signed-release', (step) => step.name === 'Create release ZIP');
  const publishStep = findStep('signed-release', (step) => step.name === 'Publish immutable GitHub Release asset');
  assert.ok(publishStep);
  assert.ok(createIndex >= 0);
  assert.match(steps('signed-release')[createIndex].run, /RELEASE_ASSET_SHA256/);
  assert.match(steps('signed-release')[createIndex].run, /Get-FileHash/);
  assert.match(publishStep.run, /gh api/);
  assert.match(publishStep.run, /releases\/tags/);
  assert.match(publishStep.run, /--draft --verify-tag/);
  assert.match(publishStep.run, /releases\/\$\(\$release\.id\)\/assets/);
  assert.match(publishStep.run, /Published release must contain exactly one/);
  assert.match(publishStep.run, /published\[0\]\.digest/);
  assert.match(publishStep.run, /gh release edit .*--draft=false/);
  assert.match(publishStep.run, /GitHub release remained a draft after publication/);
  const createIndexInStep = publishStep.run.indexOf('gh release create');
  const assetIndexInStep = publishStep.run.indexOf('$assetsJson = gh api');
  const publishIndexInStep = publishStep.run.indexOf('gh release edit');
  const finalCheckIndexInStep = publishStep.run.indexOf('$publishedReleaseJson = gh api');
  assert.ok(createIndexInStep >= 0 && createIndexInStep < assetIndexInStep);
  assert.ok(assetIndexInStep < publishIndexInStep);
  assert.ok(publishIndexInStep < finalCheckIndexInStep);
  assert.deepEqual(Object.keys(publishStep.env).sort(), ['GH_TOKEN', 'GITHUB_REPOSITORY', 'RELEASE_TAG']);
});
