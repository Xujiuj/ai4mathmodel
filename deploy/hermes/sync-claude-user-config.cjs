const fs = require('node:fs');
const path = require('node:path');

const [configPath, payloadPath] = process.argv.slice(2);
if (!configPath || !payloadPath) throw new Error('usage: sync-claude-user-config <config> <payload>');

const current = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
if (!payload?.env?.ANTHROPIC_BASE_URL || !payload?.env?.ANTHROPIC_AUTH_TOKEN) {
  throw new Error('payload is missing Anthropic connection settings');
}

current.model = 'sonnet';
current.env = {
  ...(current.env || {}),
  ANTHROPIC_BASE_URL: payload.env.ANTHROPIC_BASE_URL,
  ANTHROPIC_AUTH_TOKEN: payload.env.ANTHROPIC_AUTH_TOKEN,
  ANTHROPIC_MODEL: 'claude-sonnet-5',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-5',
};

const temporary = path.join(path.dirname(configPath), `.settings.${process.pid}.tmp`);
fs.writeFileSync(temporary, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(temporary, configPath);
fs.chmodSync(configPath, 0o600);
console.log(JSON.stringify({
  model: current.model,
  synced: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN'],
  configuredModel: current.env.ANTHROPIC_MODEL,
  configuredSonnet: current.env.ANTHROPIC_DEFAULT_SONNET_MODEL,
}));
