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

function failingOnceCodec() {
  const codec = testCodec();
  let failed = false;
  return {
    ...codec,
    seal(value) {
      if (!failed) {
        failed = true;
        throw new Error('seal failed');
      }
      return codec.seal(value);
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

test('supports contiguous oldest-first event pages after a sequence cursor', async (context) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'modeling-run-store-pages-'));
  const store = createRunStore(path.join(temporary, 'project'), {
    baseDirectory: path.join(temporary, 'user-data'),
    codec: testCodec(),
  });
  context.after(() => fs.rm(temporary, { recursive: true, force: true }));

  for (let seq = 1; seq <= 5; seq += 1) await store.append({ runId: 'run-pages', seq, type: `event-${seq}` });

  assert.deepEqual(
    (await store.readEvents({ runId: 'run-pages', limit: 2, oldestFirst: true })).map((event) => event.seq),
    [1, 2],
  );
  assert.deepEqual(
    (await store.readEvents({ runId: 'run-pages', afterSeq: 2, limit: 2, oldestFirst: true })).map((event) => event.seq),
    [3, 4],
  );
});

test('lists bounded public metadata and validates encrypted per-run snapshots', async (context) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'modeling-run-store-history-'));
  const store = createRunStore(path.join(temporary, 'project'), {
    baseDirectory: path.join(temporary, 'user-data'),
    codec: testCodec(),
  });
  context.after(() => fs.rm(temporary, { recursive: true, force: true }));

  await store.save({
    schemaVersion: 1,
    runId: 'run-history-1',
    status: 'paused',
    currentStage: 'solving',
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: null,
    tasks: { solving: { status: 'paused' } },
    plan: { summary: 'PRIVATE_PLAN' },
  });
  await store.append({ runId: 'run-history-1', seq: 1, type: 'run.paused', createdAt: '2026-01-01T00:01:00.000Z', payload: { stage: 'solving' } });

  await store.save({
    schemaVersion: 1,
    runId: 'run-history-2',
    status: 'completed',
    currentStage: null,
    startedAt: '2026-01-02T00:00:00.000Z',
    completedAt: '2026-01-02T00:02:00.000Z',
    tasks: { analysis: { status: 'completed' } },
    plan: { summary: 'PRIVATE_PLAN_2' },
  });
  await store.append({ runId: 'run-history-2', seq: 1, type: 'run.completed', createdAt: '2026-01-02T00:02:00.000Z', payload: {} });

  const listed = await store.listRuns({ limit: 1 });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].runId, 'run-history-2');
  assert.equal(listed[0].status, 'completed');
  assert.equal(listed[0].stage, 'analysis');
  assert.equal(Object.hasOwn(listed[0], 'plan'), false);
  assert.equal((await store.loadRun('run-history-1')).runId, 'run-history-1');
  assert.equal(await store.loadRun('foreign-run'), null);
});

test('serializes concurrent append and journal compaction across store instances', async (context) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'modeling-run-store-concurrent-'));
  const projectRoot = path.join(temporary, 'project');
  const privateRoot = path.join(temporary, 'user-data');
  const options = { baseDirectory: privateRoot, codec: testCodec(), maxJournalBytes: 1 };
  const firstStore = createRunStore(projectRoot, options);
  const secondStore = createRunStore(projectRoot, options);
  context.after(() => fs.rm(temporary, { recursive: true, force: true }));

  const writes = [];
  for (let seq = 1; seq <= 120; seq += 1) {
    writes.push((seq % 2 ? firstStore : secondStore).append({
      runId: 'run-concurrent',
      seq,
      type: `event-${seq}`,
    }));
  }
  await Promise.all(writes);

  assert.deepEqual(
    (await firstStore.readEvents({ runId: 'run-concurrent', oldestFirst: true, limit: 200 })).map((event) => event.seq),
    Array.from({ length: 120 }, (_, index) => index + 1),
  );
});

test('releases the append queue after a failed write', async (context) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'modeling-run-store-recovery-'));
  const store = createRunStore(path.join(temporary, 'project'), {
    baseDirectory: path.join(temporary, 'user-data'),
    codec: failingOnceCodec(),
  });
  context.after(() => fs.rm(temporary, { recursive: true, force: true }));

  const failed = store.append({ runId: 'run-recovery', seq: 1, type: 'failed' });
  const recovered = store.append({ runId: 'run-recovery', seq: 2, type: 'recovered' });
  await assert.rejects(failed, /seal failed/);
  await recovered;

  assert.deepEqual(
    (await store.readEvents({ runId: 'run-recovery', oldestFirst: true })).map((event) => event.seq),
    [2],
  );
});
