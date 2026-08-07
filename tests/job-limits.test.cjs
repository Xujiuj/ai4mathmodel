const test = require('node:test');
const assert = require('node:assert/strict');

const { applyJobLimits, jobLimitScript, normalizeLimits } = require('../electron/job-limits.cjs');

test('job-limit helper retains its Job Object handle until the restricted process exits', () => {
  const limits = normalizeLimits({ memoryMB: 512, cpuMinutes: 2, maxProcesses: 3 });
  const script = jobLimitScript(4242, limits);

  assert.match(script, /KILL_ON_CLOSE/);
  assert.match(script, /GetProcessById\(4242\)\.WaitForExit\(\)/);
  assert.match(script, /CloseHandle\(\$job\)/);
  assert.match(script, /\[uint64\]536870912/);
});

test('job-limit helper is disposed only after the tracked process finishes', () => {
  const calls = [];
  const helper = {
    exitCode: null,
    killed: false,
    on: () => helper,
    unref: () => { calls.push('unref'); },
    kill: () => { calls.push('kill'); helper.killed = true; },
  };
  const controller = applyJobLimits({ pid: 4242 }, {}, {
    platform: 'win32',
    spawnImpl: (...args) => {
      calls.push(args);
      return helper;
    },
  });

  assert.ok(controller);
  assert.equal(calls[0][0], 'powershell.exe');
  assert.equal(calls.includes('unref'), true);
  controller.dispose();
  assert.deepEqual(calls.filter((entry) => entry === 'kill'), ['kill']);
  controller.dispose();
  assert.deepEqual(calls.filter((entry) => entry === 'kill'), ['kill']);
});

test('job limits do not launch a helper on non-Windows platforms', () => {
  let spawned = false;
  const controller = applyJobLimits({ pid: 4242 }, {}, {
    platform: 'linux',
    spawnImpl: () => { spawned = true; },
  });
  assert.equal(controller, null);
  assert.equal(spawned, false);
});
