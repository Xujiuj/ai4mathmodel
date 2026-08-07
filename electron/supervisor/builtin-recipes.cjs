const crypto = require('node:crypto');
const path = require('node:path');

const STAGE_RECIPE_DIRECTORIES = Object.freeze({
  analysis: 'work/01_analysis',
  solving: 'work/02_solving',
  paper: 'work/03_paper',
  review: 'work/04_review',
});

function recipeError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

const OUTPUT_ARGUMENTS = new Set([
  '--output', '--self-test-output', '--json-out', '--manifest-out', '--markdown-out',
]);

function assertStageOutputPath(stage, value) {
  const root = STAGE_RECIPE_DIRECTORIES[stage];
  if (!root) throw recipeError('BUILTIN_RECIPE_STAGE_INVALID');
  const normalized = path.posix.normalize(String(value || '').replaceAll('\\', '/')).replace(/^\.\//, '');
  if (normalized !== root && !normalized.startsWith(`${root}/`)) {
    throw recipeError('BUILTIN_RECIPE_OUTPUT_RESTRICTED');
  }
}

function assertRecipeArguments(resource, values, stage = '') {
  const args = values === undefined ? [] : values;
  const schema = resource?.argumentSchema || {};
  if (!Array.isArray(args) || args.length > Math.min(Number(schema.maxItems) || 32, 32)) {
    throw recipeError('BUILTIN_RECIPE_ARGUMENTS_INVALID');
  }
  const maxLength = Math.min(Number(schema.items?.maxLength) || 2048, 2048);
  const checked = args.map((value) => {
    if (typeof value !== 'string' || !value.length || value.length > maxLength || /[\u0000\r\n]/.test(value)) {
      throw recipeError('BUILTIN_RECIPE_ARGUMENTS_INVALID');
    }
    const candidate = value.startsWith('--') && value.includes('=') ? value.slice(value.indexOf('=') + 1) : value;
    if (/^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(candidate)
      || candidate.split(/[\\/]+/).includes('..')) {
      throw recipeError('BUILTIN_RECIPE_PATH_RESTRICTED');
    }
    return value;
  });
  for (let index = 0; index < checked.length; index += 1) {
    const value = checked[index];
    const equalIndex = value.indexOf('=');
    const flag = equalIndex > 0 ? value.slice(0, equalIndex) : value;
    if (!OUTPUT_ARGUMENTS.has(flag)) continue;
    const output = equalIndex > 0 ? value.slice(equalIndex + 1) : checked[index + 1];
    if (!output || (equalIndex < 0 && output.startsWith('--'))) {
      throw recipeError('BUILTIN_RECIPE_ARGUMENTS_INVALID');
    }
    assertStageOutputPath(stage, output);
  }
  return checked;
}

function stageRecipePaths(stage, resource, now = Date.now()) {
  const root = STAGE_RECIPE_DIRECTORIES[stage];
  if (!root) throw recipeError('BUILTIN_RECIPE_STAGE_INVALID');
  const slug = String(resource.id || 'recipe').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
  const nonce = `${now}-${crypto.randomBytes(4).toString('hex')}`;
  return {
    script: path.posix.join(root, '_builtin_runtime', `${resource.sha256}.py`),
    receipt: path.posix.join(root, 'execution_receipts', `${slug}-${nonce}.json`),
  };
}

function createExecutionReceipt({ resource, arguments: args, startedAt, finishedAt, result }) {
  const output = String(result?.output || '');
  return {
    schema_version: 1,
    resource_id: resource.id,
    source_sha256: resource.executionSha256,
    arguments_sha256: sha256(JSON.stringify(args)),
    started_at: startedAt,
    finished_at: finishedAt,
    status: result?.ok ? 'passed' : 'failed',
    output_sha256: sha256(output),
    output_excerpt: output.slice(-4000),
    error: result?.ok ? null : String(result?.error || 'BUILTIN_RECIPE_FAILED'),
  };
}

module.exports = {
  STAGE_RECIPE_DIRECTORIES,
  assertStageOutputPath,
  assertRecipeArguments,
  createExecutionReceipt,
  recipeError,
  sha256,
  stageRecipePaths,
};
