const fs = require('node:fs');
const path = require('node:path');

const MIGRATION_LOCK_ID = 1296914257;

async function applySchema(pool, { schemaPath = path.join(__dirname, 'schema.sql') } = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('A PostgreSQL pool is required');
  const schema = fs.readFileSync(schemaPath, 'utf8').trim();
  if (!schema) throw new Error('Account API schema is empty');

  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;
    await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(schema);
    await client.query('COMMIT');
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the migration failure; the pool will discard an unusable connection.
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { MIGRATION_LOCK_ID, applySchema };
