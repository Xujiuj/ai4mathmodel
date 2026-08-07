const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');

test('text and image connections expose only their supported protocols', async () => {
  const config = await import(pathToFileURL(path.join(root, 'src', 'modelConfig.js')).href);

  assert.deepEqual(config.MODEL_PROTOCOLS.map(([protocol]) => protocol), [
    'openai',
    'openai-responses',
    'anthropic',
    'ollama',
  ]);
  assert.deepEqual(config.modelProtocolsForConnection('coordinator').map(([protocol]) => protocol), [
    'openai',
    'openai-responses',
    'anthropic',
    'ollama',
  ]);
  assert.deepEqual(config.modelProtocolsForConnection('image').map(([protocol]) => protocol), ['openai']);
});

test('model settings render shared protocol metadata and normalize image imports', () => {
  const modal = fs.readFileSync(path.join(root, 'src', 'components', 'Modals.jsx'), 'utf8');

  assert.match(modal, /modelProtocolsForConnection\(activeConnection\)\.map/);
  assert.equal((modal.match(/key === 'image' \? \{ protocol: 'openai' \} : \{\}/g) || []).length, 2);
  assert.doesNotMatch(modal, /<option value="anthropic"/);
  assert.doesNotMatch(modal, /<option value="ollama"/);
});
