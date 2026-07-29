const test = require('node:test');
const assert = require('node:assert/strict');
const { computeCost, resolvePricing } = require('../electron/pricing.cjs');
const { normalizeBudget, DEFAULT_BUDGET, createRunState } = require('../electron/supervisor/contracts.cjs');
const { classifyFailure, shouldPauseImmediately, FAILURE_CLASSES } = require('../electron/supervisor/retry-policy.cjs');
const { accumulateSpend, assertBudget } = require('../electron/supervisor/supervisor.cjs');
const { toPublicPipelineEvent } = require('../electron/public-events.cjs');

test('computeCost calculates correct CNY cost for Anthropic Claude', () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 200_000 };
  const { cost, pricingUnknown } = computeCost(usage, 'anthropic', 'claude-opus-4');
  assert.ok(!pricingUnknown);
  assert.ok(cost > 380 && cost < 390);
});

test('resolvePricing returns null for unknown models', () => {
  assert.equal(resolvePricing('openai', 'gpt-99-ultra'), null);
});

test('normalizeBudget clamps maxTokensPerRun to safe range', () => {
  const budget = normalizeBudget({ maxTokensPerRun: 999_999_999 });
  assert.equal(budget.maxTokensPerRun, 50_000_000);
  assert.equal(DEFAULT_BUDGET.maxCostPerRun, 30);
});

test('BUDGET_EXCEEDED pauses immediately as configuration failure', () => {
  const failure = classifyFailure({ error: { code: 'BUDGET_EXCEEDED', message: '已达到本次运行的预算上限。' } });
  assert.equal(failure.category, FAILURE_CLASSES.CONFIGURATION);
  assert.equal(failure.retryable, false);
  assert.ok(shouldPauseImmediately(failure));
});

test('assertBudget throws when cost exceeds maxCostPerRun', () => {
  const state = createRunState();
  state.policy.budget.enabled = true;
  state.policy.budget.maxCostPerRun = 1;
  state.spend.cost = 1.5;
  assert.throws(() => assertBudget(state), (error) => error.code === 'BUDGET_EXCEEDED');
});

test('assertBudget does not compare authoritative USD cost with a CNY limit', () => {
  const state = createRunState();
  state.policy.budget.enabled = true;
  state.policy.budget.maxCostPerRun = 1;
  state.spend.cost = 5;
  state.spend.authoritative = true;
  state.spend.currency = 'USD';
  assert.doesNotThrow(() => assertBudget(state));
});

test('accumulateSpend updates totals and byStage', () => {
  const state = createRunState({ stages: ['analysis'] });
  state.currentStage = 'analysis';
  const snapshot = accumulateSpend(state, {
    usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0 },
    provider: 'ollama',
    model: 'llama3',
  });
  assert.equal(state.spend.inputTokens, 1000);
  assert.equal(state.spend.outputTokens, 500);
  assert.equal(state.spend.cost, 0);
  assert.equal(state.spend.byStage.analysis.inputTokens, 1000);
  assert.equal(snapshot.tokens, 1500);
});

test('accumulateSpend prefers authoritative hosted cost and balance', () => {
  const state = createRunState({ stages: ['analysis'] });
  state.currentStage = 'analysis';
  const snapshot = accumulateSpend(state, {
    usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0 },
    provider: 'openai',
    model: 'gpt-5.6-sol',
    authoritativeCost: 0.42,
    authoritativeBalance: 9.58,
    authoritativeCurrency: 'USD',
  });
  assert.equal(state.spend.cost, 0.42);
  assert.equal(snapshot.authoritative, true);
  assert.equal(snapshot.balance, 9.58);
  assert.equal(snapshot.currency, 'USD');
  assert.equal(snapshot.pricingUnknown, false);
});

test('toPublicPipelineEvent maps usage.updated to usage-progress', () => {
  const event = toPublicPipelineEvent({
    type: 'usage.updated',
    createdAt: new Date().toISOString(),
    payload: { stage: 'analysis', tokens: 1500, cost: 1.25, pricingUnknown: false },
  });
  assert.equal(event.type, 'usage-progress');
  assert.equal(event.tokens, 1500);
  assert.equal(event.cost, 1.25);
  assert.match(event.message, /¥1\.25/);
});

test('toPublicPipelineEvent labels authoritative hosted cost and balance', () => {
  const event = toPublicPipelineEvent({
    type: 'usage.updated',
    createdAt: new Date().toISOString(),
    payload: {
      stage: 'analysis',
      tokens: 1500,
      cost: 0.42,
      pricingUnknown: false,
      authoritative: true,
      balance: 9.58,
      currency: 'USD',
    },
  });
  assert.equal(event.authoritative, true);
  assert.equal(event.balance, 9.58);
  assert.match(event.message, /USD 0\.42/);
  assert.match(event.message, /余额 USD 9\.58/);
  assert.doesNotMatch(event.message, /约/);
});
