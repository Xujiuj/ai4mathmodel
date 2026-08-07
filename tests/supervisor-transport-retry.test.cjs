const test = require('node:test');
const assert = require('node:assert/strict');

const { DEFAULT_AGENT_POLICY, normalizeAgentPolicy } = require('../electron/supervisor/contracts.cjs');
const { createAgentSupervisor } = require('../electron/supervisor/supervisor.cjs');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('allows five retryable upstream 502 attempts on the selected route', async () => {
  const events = [];
  let state = null;
  let dispatched = 0;
  const supervisor = createAgentSupervisor({
    root: 'C:\\workspace',
    settings: {
      connections: {
        reasoning: { baseUrl: 'https://gateway.example/v1', model: 'gpt-5.6-sol' },
      },
    },
    runtimePolicy: {
      maxAttemptsPerModel: 5,
      maxAttemptsPerRun: 5,
      retryBackoffSeconds: 0,
      supervisorPlanning: false,
    },
    stages: ['analysis'],
    store: {
      load: async () => state && clone(state),
      save: async (next) => {
        state = clone(next);
        return state;
      },
      append: async (event) => events.push(event),
    },
    prepareWorkspace: async () => ({ ok: true }),
    evaluateGate: async () => ({ ok: true, dependency: null }),
    validateStage: async () => ({ ok: false, reason: 'no completed staged artifacts' }),
    confirmStage: async () => {},
    cleanupStage: async () => ({ removedCount: 0 }),
    runAgent: async () => {
      dispatched += 1;
      const error = new Error('upstream 502');
      error.code = 'MODEL_UNAVAILABLE';
      error.status = 502;
      return { code: 1, error };
    },
    basePrompt: () => '',
  });

  const result = await supervisor.execute({ forceResume: true });

  assert.equal(DEFAULT_AGENT_POLICY.maxAttemptsPerModel, 5);
  assert.equal(normalizeAgentPolicy({ maxAttemptsPerModel: 99 }).maxAttemptsPerModel, 5);
  assert.equal(result.status, 'paused');
  assert.equal(dispatched, 5);
  assert.equal(events.filter((event) => event.type === 'attempt.retry_scheduled').length, 4);
});

test('continues transient failures into a fresh route cycle until the run-wide limit', async () => {
  let state = null;
  let dispatched = 0;
  const supervisor = createAgentSupervisor({
    root: 'C:\\workspace',
    settings: {
      connections: {
        reasoning: { baseUrl: 'https://gateway.example/v1', model: 'gpt-5.6-sol' },
      },
    },
    runtimePolicy: {
      maxAttemptsPerModel: 5,
      maxAttemptsPerRun: 7,
      retryBackoffSeconds: 0,
      supervisorPlanning: false,
    },
    stages: ['analysis'],
    store: {
      load: async () => state && clone(state),
      save: async (next) => {
        state = clone(next);
        return state;
      },
      append: async () => {},
    },
    prepareWorkspace: async () => ({ ok: true }),
    evaluateGate: async () => ({ ok: true, dependency: null }),
    validateStage: async () => ({ ok: false, reason: 'no completed staged artifacts' }),
    confirmStage: async () => {},
    cleanupStage: async () => ({ removedCount: 0 }),
    runAgent: async () => {
      dispatched += 1;
      const error = new Error('upstream 502');
      error.code = 'MODEL_UNAVAILABLE';
      error.status = 502;
      return { code: 1, error };
    },
    basePrompt: () => '',
  });

  const result = await supervisor.execute({ forceResume: true });

  assert.equal(result.status, 'paused');
  assert.equal(result.category, 'transport');
  assert.equal(dispatched, 7);
  assert.equal(state.tasks.analysis.attemptCount, 7);
  assert.equal(state.tasks.analysis.recoveryCycle, 1);
});

test('commits complete staged artifacts when the gateway loses the final response', async () => {
  const events = [];
  let state = null;
  let dispatched = 0;
  let committed = 0;
  const supervisor = createAgentSupervisor({
    root: 'C:\\workspace',
    settings: {
      connections: {
        reasoning: { baseUrl: 'https://gateway.example/v1', model: 'gpt-5.6-sol' },
      },
    },
    runtimePolicy: {
      maxAttemptsPerModel: 5,
      retryBackoffSeconds: 0,
      supervisorPlanning: false,
    },
    stages: ['analysis'],
    store: {
      load: async () => state && clone(state),
      save: async (next) => {
        state = clone(next);
        return state;
      },
      append: async (event) => events.push(event),
    },
    prepareWorkspace: async () => ({ ok: true }),
    evaluateGate: async () => ({ ok: true, dependency: null }),
    validateStage: async () => ({
      ok: true,
      artifactRefs: ['work/01_analysis/analysis.md', 'work/01_analysis/problem_text.md'],
      summary: 'validated staged analysis',
    }),
    confirmStage: async () => {
      committed += 1;
    },
    cleanupStage: async () => ({ removedCount: 0 }),
    runAgent: async () => {
      dispatched += 1;
      const error = new Error('upstream 502 after tool calls');
      error.code = 'MODEL_UNAVAILABLE';
      error.status = 502;
      return { code: 1, error };
    },
    basePrompt: () => '',
  });

  const result = await supervisor.execute({ forceResume: true });

  assert.equal(result.status, 'completed');
  assert.equal(dispatched, 1);
  assert.equal(committed, 1);
  assert.equal(events.some((event) => event.type === 'task.artifacts_recovered'), true);
  assert.equal(events.some((event) => event.type === 'task.succeeded'), true);
});
