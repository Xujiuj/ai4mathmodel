const test = require('node:test');
const assert = require('node:assert/strict');

const { createRunState, resumeOptionsForState } = require('../electron/supervisor/contracts.cjs');
const { createAgentSupervisor } = require('../electron/supervisor/supervisor.cjs');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('resuming an interrupted attempt schedules a replacement on the same route', async () => {
  const previous = createRunState({
    runId: 'resume-interrupted-attempt',
    stages: ['analysis'],
    policy: { maxAttemptsPerModel: 1, supervisorPlanning: false },
  });
  previous.status = 'running';
  previous.tasks.analysis.status = 'running';
  previous.tasks.analysis.attemptCount = 1;
  previous.tasks.analysis.attempts = [{
    attemptId: 'interrupted-attempt',
    cycle: 0,
    number: 1,
    routeId: 'reasoning:gpt-5.6-sol',
    status: 'running',
    startedAt: new Date().toISOString(),
    endedAt: null,
  }];

  const events = [];
  let dispatched = 0;
  let validations = 0;
  const supervisor = createAgentSupervisor({
    root: 'C:\\workspace',
    settings: {
      connections: {
        reasoning: { baseUrl: 'https://gateway.example/v1', model: 'gpt-5.6-sol' },
      },
    },
    runtimePolicy: { maxAttemptsPerModel: 1, supervisorPlanning: false },
    stages: ['analysis'],
    store: {
      load: async () => clone(previous),
      save: async (state) => state,
      append: async (event) => events.push(event),
    },
    prepareWorkspace: async () => ({ ok: true }),
    evaluateGate: async () => ({ ok: true, dependency: null }),
    validateStage: async () => {
      validations += 1;
      return validations === 1
        ? { ok: false, reason: 'no completed staged artifacts' }
        : { ok: true, artifactRefs: [], summary: 'validated' };
    },
    confirmStage: async () => {},
    cleanupStage: async () => ({ removedCount: 0 }),
    runAgent: async () => {
      dispatched += 1;
      return { code: 0, stdout: '' };
    },
    basePrompt: () => '',
  });

  const result = await supervisor.execute({ resume: true, forceResume: true });
  assert.equal(result.status, 'completed');
  assert.equal(dispatched, 1);
  assert.equal(events.some((event) => event.type === 'task.succeeded'), true);
});

test('paused pipelines resume only when the persisted policy allows it', () => {
  const paused = createRunState({ stages: ['analysis'] });
  paused.status = 'paused';

  assert.deepEqual(resumeOptionsForState(paused), { resume: true, forceResume: true });
  paused.policy.autoResume = false;
  assert.equal(resumeOptionsForState(paused), null);
  assert.deepEqual(
    resumeOptionsForState(paused, { autoResume: true }),
    { resume: true, forceResume: true },
  );
});

test('forced resume opens a fresh bounded retry window after a transport cap', async () => {
  const previous = createRunState({
    runId: 'resume-after-transport-cap',
    stages: ['analysis'],
    policy: { maxAttemptsPerModel: 1, maxAttemptsPerRun: 4, supervisorPlanning: false },
  });
  previous.status = 'paused';
  previous.currentStage = 'analysis';
  previous.tasks.analysis.status = 'paused';
  previous.tasks.analysis.attemptCount = 4;
  previous.tasks.analysis.attempts = Array.from({ length: 4 }, (_, index) => ({
    attemptId: `transport-failure-${index + 1}`,
    cycle: 0,
    number: index + 1,
    routeId: 'reasoning:gpt-5.6-sol',
    status: 'failed',
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
  }));

  let validations = 0;
  let dispatched = 0;
  let saved = null;
  const supervisor = createAgentSupervisor({
    root: 'C:\\workspace',
    settings: {
      connections: {
        reasoning: { baseUrl: 'https://gateway.example/v1', model: 'gpt-5.6-sol' },
      },
    },
    runtimePolicy: { maxAttemptsPerModel: 1, maxAttemptsPerRun: 4, supervisorPlanning: false },
    stages: ['analysis'],
    store: {
      load: async () => clone(previous),
      save: async (state) => {
        saved = clone(state);
        return state;
      },
      append: async () => {},
    },
    prepareWorkspace: async () => ({ ok: true }),
    evaluateGate: async () => ({ ok: true, dependency: null }),
    validateStage: async () => {
      validations += 1;
      return validations === 1
        ? { ok: false, reason: 'no completed staged artifacts' }
        : { ok: true, artifactRefs: [], summary: 'validated' };
    },
    confirmStage: async () => {},
    cleanupStage: async () => ({ removedCount: 0 }),
    runAgent: async () => {
      dispatched += 1;
      return { code: 0, stdout: '' };
    },
    basePrompt: () => '',
  });

  const result = await supervisor.execute({ resume: true, forceResume: true });

  assert.equal(result.status, 'completed');
  assert.equal(dispatched, 1);
  assert.equal(saved.tasks.analysis.attemptCount, 5);
  assert.equal(saved.tasks.analysis.recoveryAttemptCount, 1);
  assert.equal(saved.tasks.analysis.recoveryCycle, 1);
});

test('resume commits complete staged artifacts before dispatching another model request', async () => {
  const previous = createRunState({
    runId: 'resume-staged-artifacts',
    stages: ['analysis'],
    policy: { maxAttemptsPerModel: 1, supervisorPlanning: false },
  });
  previous.status = 'paused';
  previous.currentStage = 'analysis';
  previous.tasks.analysis.status = 'paused';
  previous.tasks.analysis.attemptCount = 1;
  previous.tasks.analysis.attempts = [{
    attemptId: 'failed-response',
    cycle: 0,
    number: 1,
    routeId: 'reasoning:gpt-5.6-sol',
    status: 'failed',
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
  }];

  const events = [];
  let dispatched = 0;
  let committed = 0;
  const supervisor = createAgentSupervisor({
    root: 'C:\\workspace',
    settings: {
      connections: {
        reasoning: { baseUrl: 'https://gateway.example/v1', model: 'gpt-5.6-sol' },
      },
    },
    runtimePolicy: { maxAttemptsPerModel: 1, supervisorPlanning: false },
    stages: ['analysis'],
    store: {
      load: async () => clone(previous),
      save: async (state) => state,
      append: async (event) => events.push(event),
    },
    prepareWorkspace: async () => ({ ok: true }),
    evaluateGate: async () => ({ ok: true, dependency: null }),
    validateStage: async () => ({ ok: true, artifactRefs: ['work/01_analysis/analysis.md'], summary: 'validated staged analysis' }),
    confirmStage: async () => {
      committed += 1;
    },
    cleanupStage: async () => ({ removedCount: 0 }),
    runAgent: async () => {
      dispatched += 1;
      return { code: 0, stdout: '' };
    },
    basePrompt: () => '',
  });

  const result = await supervisor.execute({ resume: true, forceResume: true });

  assert.equal(result.status, 'completed');
  assert.equal(committed, 1);
  assert.equal(dispatched, 0);
  assert.equal(events.some((event) => event.type === 'task.staged_artifacts_recovered'), true);
});

test('transport recovery carries an incomplete staged-artifact reason into the next attempt', async () => {
  const prompts = [];
  let validations = 0;
  const supervisor = createAgentSupervisor({
    root: 'C:\\workspace',
    settings: {
      connections: {
        reasoning: { baseUrl: 'https://gateway.example/v1', model: 'gpt-5.6-sol' },
      },
    },
    runtimePolicy: { maxAttemptsPerModel: 2, retryBackoffSeconds: 0, supervisorPlanning: false },
    stages: ['analysis'],
    store: {
      load: async () => null,
      save: async (state) => state,
      append: async () => {},
    },
    prepareWorkspace: async () => ({ ok: true }),
    evaluateGate: async () => ({ ok: true, dependency: null }),
    validateStage: async () => {
      validations += 1;
      return validations === 1
        ? { ok: false, reason: 'analysis lacks required validation headings' }
        : { ok: true, artifactRefs: [], summary: 'validated' };
    },
    confirmStage: async () => {},
    cleanupStage: async () => ({ removedCount: 0 }),
    runAgent: async ({ prompt }) => {
      prompts.push(prompt);
      if (prompts.length === 1) {
        const error = new Error('connection reset');
        error.code = 'MODEL_NETWORK_ERROR';
        return { code: 1, error };
      }
      return { code: 0, stdout: '' };
    },
    basePrompt: () => 'base prompt',
  });

  const result = await supervisor.execute();

  assert.equal(result.status, 'completed');
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /暂存产物未通过门禁：analysis lacks required validation headings/);
});
