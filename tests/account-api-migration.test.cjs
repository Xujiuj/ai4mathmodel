const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { MIGRATION_LOCK_ID, applySchema } = require('../deploy/hermes/account-api/migrate.cjs');

function fakePool({ failSchema = false } = {}) {
  const calls = [];
  let released = false;
  const client = {
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      if (failSchema && String(sql).includes('CREATE TABLE')) throw new Error('schema failed');
      return { rows: [], rowCount: 0 };
    },
    release() {
      released = true;
    },
  };
  return {
    calls,
    get released() { return released; },
    connect: async () => client,
  };
}

test('account schema migration is serialized and committed before startup', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'account-migration-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const schemaPath = path.join(directory, 'schema.sql');
  await fs.writeFile(schemaPath, 'CREATE TABLE IF NOT EXISTS example(id BIGINT);', 'utf8');
  const pool = fakePool();

  await applySchema(pool, { schemaPath });

  assert.deepEqual(pool.calls.map((call) => call.sql), [
    'BEGIN',
    'SELECT pg_advisory_xact_lock($1)',
    'CREATE TABLE IF NOT EXISTS example(id BIGINT);',
    'COMMIT',
  ]);
  assert.deepEqual(pool.calls[1].params, [MIGRATION_LOCK_ID]);
  assert.equal(pool.released, true);
});

test('account schema migration rolls back and releases its connection on failure', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'account-migration-fail-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const schemaPath = path.join(directory, 'schema.sql');
  await fs.writeFile(schemaPath, 'CREATE TABLE broken(id BIGINT);', 'utf8');
  const pool = fakePool({ failSchema: true });

  await assert.rejects(() => applySchema(pool, { schemaPath }), /schema failed/);
  assert.equal(pool.calls.at(-1).sql, 'ROLLBACK');
  assert.equal(pool.released, true);
});
