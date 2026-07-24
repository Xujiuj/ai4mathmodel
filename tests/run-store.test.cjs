const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createRunStore } = require('../electron/supervisor/run-store.cjs');

function testCodec() {
  return {
    seal(value) {
      return Buffer.from(`sealed:${value}`, 'utf8').toString('base64');
    },
    open(value) {
      const decoded = Buffer.from(value, 'base64').toString('utf8');
      if (!decoded.startsWith('sealed:')) throw new Error('invalid ciphertext');
      return decoded.slice('sealed:'.length);
    },
  };
}

test('stores encrypted supervisor state under private application data', async (context) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'modeling-run-store-'));
  const projectRoot = path.join(temporary, 'project');
  const privateRoot = path.join(temporary, 'user-data');
  await fs.mkdir(projectRoot, { recursive: true });
  context.after(() => fs.rm(temporary, { recursive: true, force: true }));

  const store = createRunStore(projectRoot, { baseDirectory: privateRoot, codec: testCodec() });
  const state = {
    schemaVersion: 1,
    runId: 'run-1',
    revision: 0,
    status: 'running',
    tasks: { analysis: { status: 'running' } },
    plan: { summary: 'PRIVATE_STRATEGY_SENTINEL' },
  };
  await store.save(state);
  await store.append({ runId: 'run-1', seq: 1, type: 'private', payload: { prompt: 'PRIVATE_PROMPT_SENTINEL' } });

  assert.ok(path.resolve(store.directory).startsWith(path.resolve(privateRoot)));
  assert.ok(!path.resolve(store.directory).startsWith(path.resolve(projectRoot)));
  assert.deepEqual(await fs.readdir(projectRoot), []);

  const rawState = await fs.readFile(store.stateFile, 'utf8');
  const rawEvents = await fs.readFile(store.eventFile, 'utf8');
  assert.doesNotMatch(rawState, /PRIVATE_STRATEGY_SENTINEL/);
  assert.doesNotMatch(rawEvents, /PRIVATE_PROMPT_SENTINEL/);
  assert.equal((await store.load()).plan.summary, 'PRIVATE_STRATEGY_SENTINEL');
  assert.equal((await store.readEvents({ runId: 'run-1' }))[0].payload.prompt, 'PRIVATE_PROMPT_SENTINEL');
});
