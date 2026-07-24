const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..');
const packageInfo = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));

test('ships a modular installer instead of a self-extracting application archive', () => {
  const script = packageInfo.scripts?.['dist:win'] || '';
  assert.equal(packageInfo.build?.win?.target, undefined);
  assert.equal(packageInfo.build?.win?.artifactName, undefined);
  assert.doesNotMatch(script, /\bportable\b|--win zip/i);
  assert.match(script, /build:installer/);
  assert.match(script, /verify:installer/);
});
