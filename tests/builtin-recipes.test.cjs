const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  assertRecipeArguments,
  createExecutionReceipt,
  stageRecipePaths,
} = require('../electron/supervisor/builtin-recipes.cjs');

const resource = {
  id: 'mmc-computational-experiment:recipe-profile-dataset',
  sha256: 'a'.repeat(64),
  executionSha256: 'a'.repeat(64),
  argumentSchema: { type: 'array', items: { type: 'string', maxLength: 80 }, maxItems: 8 },
};

test('built-in recipe arguments allow project-relative inputs and reject path escape', () => {
  assert.deepEqual(assertRecipeArguments(resource, ['inputs/problem/data.csv', '--output', 'work/01_analysis/profile.json'], 'analysis'), [
    'inputs/problem/data.csv', '--output', 'work/01_analysis/profile.json',
  ]);
  for (const value of ['../outside.csv', 'C:\\outside.csv', '/outside.csv', '--output=..\\outside.json']) {
    assert.throws(() => assertRecipeArguments(resource, [value], 'analysis'), /BUILTIN_RECIPE_PATH_RESTRICTED/);
  }
  assert.throws(
    () => assertRecipeArguments(resource, ['inputs/problem/data.csv', '--output', 'inputs/problem/profile.json'], 'analysis'),
    /BUILTIN_RECIPE_OUTPUT_RESTRICTED/,
  );
  assert.throws(
    () => assertRecipeArguments(resource, ['--output=work/02_solving/profile.json'], 'analysis'),
    /BUILTIN_RECIPE_OUTPUT_RESTRICTED/,
  );
});

test('built-in recipe paths remain stage-local and receipts bind source, args, and output', () => {
  const paths = stageRecipePaths('solving', resource, 1234);
  assert.match(paths.script, /^work\/02_solving\/_builtin_runtime\/[a-f0-9]{64}\.py$/);
  assert.match(paths.receipt, /^work\/02_solving\/execution_receipts\//);
  const receipt = createExecutionReceipt({
    resource,
    arguments: ['inputs/problem/data.csv'],
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    result: { ok: true, output: '{"rows":10}' },
  });
  assert.equal(receipt.status, 'passed');
  assert.equal(receipt.source_sha256, resource.sha256);
  assert.match(receipt.arguments_sha256, /^[a-f0-9]{64}$/);
  assert.match(receipt.output_sha256, /^[a-f0-9]{64}$/);
});

test('modeling recipe executes representative forecasting, ranking, and leakage-safe split contracts', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mmw-modeling-recipe-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.resolve(__dirname, '..', '.agents', 'skills', 'math-modeling-workflow', 'skills',
    'mmc-computational-experiment', 'scripts', 'modeling_recipes.py');
  const contracts = [
    { operation: 'gm11_forecast', series: [10, 12, 15, 18, 22], forecast_steps: 2 },
    { operation: 'ahp_weights', pairwise: [[1, 2, 4], [0.5, 1, 2], [0.25, 0.5, 1]] },
    { operation: 'split_indices', strategy: 'spatial', coordinates: [[0, 0], [1, 1], [10, 10], [11, 11]], block_size: 5, test_fraction: 0.5 },
  ];
  const results = contracts.map((contract, index) => {
    const input = path.join(root, `input-${index}.json`);
    const output = path.join(root, `output-${index}.json`);
    fs.writeFileSync(input, JSON.stringify(contract));
    const run = spawnSync(process.env.PYTHON || 'python', [script, '--input', input, '--output', output], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    return JSON.parse(fs.readFileSync(output, 'utf8')).result;
  });
  assert.equal(results[0].forecast.length, 2);
  assert.equal(results[1].accepted, true);
  assert.equal(results[2].audit.group_overlap, false);
});
