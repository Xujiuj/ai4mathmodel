const PREFIX = '@@PB1|';
const SUFFIX = '|@@';
const STAGE_WIDTH = 12;
const PAD = '.';

function playbookPlaceholder({ stage, readOnly = false } = {}) {
  const name = String(stage || '').replace(/[^a-z]/gi, '').slice(0, STAGE_WIDTH).padEnd(STAGE_WIDTH, PAD);
  return `${PREFIX}${name}|${readOnly ? 'ro' : 'rw'}${SUFFIX}`;
}

const PLACEHOLDER_LENGTH = playbookPlaceholder({ stage: 'analysis' }).length;

function parsePlaceholder(value) {
  const text = String(value || '');
  if (text.length !== PLACEHOLDER_LENGTH || !text.startsWith(PREFIX) || !text.endsWith(SUFFIX)) return null;
  const body = text.slice(PREFIX.length, -SUFFIX.length);
  const [name, mode] = body.split('|');
  if (!name || !['ro', 'rw'].includes(mode)) return null;
  const stage = name.replace(new RegExp(`\\${PAD}+$`), '');
  if (!stage) return null;
  return { stage, readOnly: mode === 'ro' };
}

module.exports = { PLACEHOLDER_LENGTH, PREFIX, SUFFIX, parsePlaceholder, playbookPlaceholder };
