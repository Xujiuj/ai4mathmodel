#!/usr/bin/env node

const { spawnSync } = require('node:child_process');

const SAME_ACCOUNT_RETRY_COUNT = 5;
const SAME_ACCOUNT_RETRY_STATUS_CODES = Object.freeze([502]);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function readPayload() {
  const chunks = [];
  process.stdin.on('data', (chunk) => chunks.push(chunk));
  process.stdin.on('end', () => {
    try {
      sync(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } catch (error) {
      fail(error?.message || 'Unable to sync upstream accounts.');
    }
  });
}

function requiredText(value, label) {
  const text = String(value || '').trim();
  if (text.length < 12) throw new Error(`${label} is missing or too short.`);
  return text;
}

function safeUrl(value) {
  const url = new URL(requiredText(value, 'baseUrl'));
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('baseUrl must be a credential-free HTTPS URL.');
  }
  return url.toString().replace(/\/$/, '');
}

function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function accountCredentials({ token, modelMapping }) {
  return {
    api_key: token,
    base_url: 'https://api.quya.org/v1',
    model_mapping: modelMapping,
    // A transient Quya 502 is retried on this credential before pool failover.
    pool_mode: true,
    pool_mode_retry_count: SAME_ACCOUNT_RETRY_COUNT,
    pool_mode_retry_status_codes: SAME_ACCOUNT_RETRY_STATUS_CODES,
  };
}

function accountStatement({ name, token, priority, groupId, modelMapping }) {
  const credentials = JSON.stringify(accountCredentials({ token, modelMapping }));
  const safeName = sqlLiteral(name);
  const safeCredentials = sqlLiteral(credentials);
  return [
    'WITH existing AS (',
    `  SELECT id FROM accounts WHERE name = ${safeName} AND deleted_at IS NULL ORDER BY id LIMIT 1`,
    '), updated AS (',
    '  UPDATE accounts SET',
    "    platform = 'openai', type = 'apikey',",
    `    credentials = ${safeCredentials}::jsonb, extra = '{}'::jsonb,`,
    `    concurrency = 2, priority = ${priority}, status = 'active', schedulable = true,`,
    '    error_message = NULL, rate_limited_at = NULL, rate_limit_reset_at = NULL,',
    '    overload_until = NULL, temp_unschedulable_until = NULL, temp_unschedulable_reason = NULL,',
    '    updated_at = now()',
    '  WHERE id = (SELECT id FROM existing)',
    '  RETURNING id',
    '), inserted AS (',
    '  INSERT INTO accounts (name, platform, type, credentials, extra, concurrency, priority, status, schedulable)',
    `  SELECT ${safeName}, 'openai', 'apikey', ${safeCredentials}::jsonb, '{}'::jsonb, 2, ${priority}, 'active', true`,
    '  WHERE NOT EXISTS (SELECT 1 FROM updated)',
    '  RETURNING id',
    '), target AS (',
    '  SELECT id FROM updated UNION ALL SELECT id FROM inserted',
    ')',
    'INSERT INTO account_groups (account_id, group_id, priority)',
    `SELECT id, ${groupId}, ${priority} FROM target`,
    'ON CONFLICT (account_id, group_id) DO UPDATE SET priority = EXCLUDED.priority;',
  ].join('\n');
}

function buildSyncSql(raw) {
  const baseUrl = safeUrl(raw.baseUrl);
  if (baseUrl !== 'https://api.quya.org/v1') throw new Error('Unexpected upstream base URL.');
  const groupId = Number(raw.groupId);
  const groupName = requiredText(raw.groupName, 'groupName');
  if (!Number.isInteger(groupId) || groupId < 1) throw new Error('groupId must be a positive integer.');
  const gptToken = requiredText(raw.gptToken, 'gptToken');
  const claudeToken = requiredText(raw.claudeToken, 'claudeToken');
  const quotedGroupName = sqlLiteral(groupName);
  return [
    'BEGIN;',
    'DO $guard$',
    'BEGIN',
    `  IF NOT EXISTS (SELECT 1 FROM groups WHERE id = ${groupId} AND name = ${quotedGroupName} AND status = 'active') THEN`,
    "    RAISE EXCEPTION 'target group is missing or inactive';",
    '  END IF;',
    'END',
    '$guard$;',
    accountStatement({
      name: 'hermes-quya-gpt',
      token: gptToken,
      priority: 1,
      groupId,
      modelMapping: {
        'gpt-5.6-sol': 'gpt-5.6-sol',
        'gpt-5.6-terra': 'gpt-5.6-terra',
      },
    }),
    accountStatement({
      name: 'hermes-quya-gpt-retry',
      token: gptToken,
      priority: 10,
      groupId,
      modelMapping: {
        'gpt-5.6-sol': 'gpt-5.6-sol',
        'gpt-5.6-terra': 'gpt-5.6-terra',
      },
    }),
    accountStatement({
      name: 'hermes-quya-claude',
      token: claudeToken,
      priority: 2,
      groupId,
      modelMapping: { 'claude-sonnet-5': 'claude-sonnet-5' },
    }),
    "UPDATE accounts SET priority = 50, status = 'disabled', schedulable = false, error_message = 'Disabled for the Hermes Quya-only workflow.', updated_at = now() WHERE name IN ('rightcode-gpt-image', '0029-gpt-image') AND deleted_at IS NULL;",
    `UPDATE account_groups SET priority = 50 WHERE group_id = ${groupId} AND account_id IN (SELECT id FROM accounts WHERE name IN ('rightcode-gpt-image', '0029-gpt-image') AND deleted_at IS NULL);`,
    "INSERT INTO scheduler_outbox (event_type, payload, dedup_key) VALUES ('full_rebuild', '{}'::jsonb, 'manual-hermes-quya-upstream') ON CONFLICT (dedup_key) WHERE dedup_key IS NOT NULL DO UPDATE SET event_type = EXCLUDED.event_type, payload = EXCLUDED.payload, created_at = now();",
    'COMMIT;',
    `SELECT a.id, a.name, a.platform, a.status, a.schedulable, a.priority, ag.group_id FROM accounts a JOIN account_groups ag ON ag.account_id = a.id WHERE ag.group_id = ${groupId} AND a.name IN ('hermes-quya-gpt', 'hermes-quya-gpt-retry', 'hermes-quya-claude') ORDER BY a.priority, a.id;`,
  ].join('\n');
}

function sync(raw) {
  const sql = buildSyncSql(raw);
  const result = spawnSync('docker', [
    'exec', '-i', 'sub2api-postgres',
    'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'sub2api', '-d', 'sub2api', '-At', '-P', 'pager=off',
  ], { input: sql, encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error('Sub2API account synchronization failed.');
  const accounts = String(result.stdout || '')
    .trim()
    .split(/\r?\n/)
    .filter((line) => /^\d+\|hermes-quya-(?:gpt|gpt-retry|claude)\|/.test(line))
    .map((line) => {
      const [id, name, platform, status, schedulable, priority, mappedGroupId] = line.split('|');
      return { id: Number(id), name, platform, status, schedulable: schedulable === 't', priority: Number(priority), groupId: Number(mappedGroupId) };
    });
  if (accounts.length !== 3) throw new Error('Sub2API account synchronization did not verify all Quya upstream accounts.');
  process.stdout.write(`${JSON.stringify({ synced: accounts })}\n`);
}

if (require.main === module) readPayload();

module.exports = {
  SAME_ACCOUNT_RETRY_COUNT,
  SAME_ACCOUNT_RETRY_STATUS_CODES,
  accountCredentials,
  buildSyncSql,
};
