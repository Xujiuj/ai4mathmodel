const test = require('node:test');
const assert = require('node:assert/strict');

test('renderer run state follows the selected project and preserves concurrent runs', async () => {
  const {
    mergeActiveRuns,
    projectIsRunning,
    runtimePreflight,
    sameProjectRoot,
  } = await import('../src/runState.js');

  assert.equal(sameProjectRoot('D:\\Cases\\A\\', 'd:/cases/a'), true);
  const runs = mergeActiveRuns(
    [{ root: 'D:\\Cases\\A', stage: 'analysis' }],
    [{ root: 'D:/Cases/B', stage: 'solving' }, { root: 'd:/cases/a', stage: 'paper' }],
  );
  assert.equal(runs.length, 2);
  assert.equal(projectIsRunning(runs, 'D:/cases/a'), true);
  assert.equal(projectIsRunning(runs, 'D:/cases/b'), true);
  assert.equal(projectIsRunning(runs, 'D:/cases/c'), false);
  assert.equal(runs.find((run) => sameProjectRoot(run.root, 'D:/cases/a')).stage, 'paper');
  assert.deepEqual(runtimePreflight({ python: true, tectonic: false }, ['paper']), {
    ok: false,
    required: ['python', 'tectonic'],
    missing: ['tectonic'],
  });
});
