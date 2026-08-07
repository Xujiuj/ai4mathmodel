const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createPendingBillingQueue } = require('../electron/hosted/billing-queue.cjs');

test('pending billing survives delayed usage visibility and settles on a later run', async () => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'pending-billing-'));
  const file = path.join(directory, 'pending-billing.json');
  const owner = { deviceId: 'device-1', email: 'user@example.com' };
  let visible = false;
  try {
    const queue = createPendingBillingQueue({ file });
    await queue.add({ owner, pipelineId: 'pipeline-late', requestIds: ['req-late'] });

    const first = await queue.flush({
      owner,
      settle: async ({ requestIds }) => visible
        ? { complete: true, missingRequestIds: [] }
        : { complete: false, missingRequestIds: requestIds },
    });
    assert.deepEqual(first, { attempted: 1, settled: 0, pending: 1 });
    assert.equal((await queue.entries()).length, 1);

    const reopened = createPendingBillingQueue({ file });
    visible = true;
    const second = await reopened.flush({
      owner,
      settle: async () => ({ complete: true, missingRequestIds: [] }),
    });
    assert.deepEqual(second, { attempted: 1, settled: 1, pending: 0 });
    assert.deepEqual(await reopened.entries(), []);
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
});

test('pending billing is isolated by hosted account ownership', async () => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'pending-billing-owner-'));
  const file = path.join(directory, 'pending-billing.json');
  try {
    const queue = createPendingBillingQueue({ file });
    await queue.add({ owner: { deviceId: 'device-1', email: 'one@example.com' }, pipelineId: 'pipeline-1', requestIds: ['req-1'] });
    const result = await queue.flush({
      owner: { deviceId: 'device-1', email: 'two@example.com' },
      settle: async () => ({ complete: true }),
    });
    assert.deepEqual(result, { attempted: 0, settled: 0, pending: 0 });
    assert.equal((await queue.entries()).length, 1);
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
});
