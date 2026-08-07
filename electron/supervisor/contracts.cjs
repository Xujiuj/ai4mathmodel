const crypto = require('node:crypto');

const SCHEMA_VERSION = 1;
const ARTIFACT_CONTRACT_VERSION = 1;
const PIPELINE_STAGES = Object.freeze(['analysis', 'solving', 'paper', 'review']);
const STAGE_ROLES = Object.freeze({
  analysis: 'analyst',
  solving: 'solver',
  paper: 'writer',
  review: 'reviewer',
});

const DEFAULT_AGENT_POLICY = Object.freeze({
  enabled: true,
  supervisorPlanning: true,
  autoResume: true,
  sourceProtection: true,
  crossRoleFallback: false,
  // A streamed upstream 502 can arrive after the relay has committed HTTP 200.
  // Keep reconnecting long enough for the upstream account pool to rotate.
  maxAttemptsPerModel: 5,
  maxAttemptsPerRun: 12,
  retryBackoffSeconds: 3,
  stageTimeoutMinutes: 90,
});

const DEFAULT_BUDGET = Object.freeze({
  enabled: true,
  currency: 'CNY',
  maxCostPerRun: 30,
  maxTokensPerRun: 3_000_000,
  warnAtPercent: 70,
  onExceed: 'pause',
});

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function normalizeBudget(raw = {}) {
  const pricingOverrides = {};
  if (raw.pricingOverrides && typeof raw.pricingOverrides === 'object') {
    for (const [key, value] of Object.entries(raw.pricingOverrides)) {
      if (!Array.isArray(value) || typeof value[0] !== 'number' || typeof value[1] !== 'number') continue;
      pricingOverrides[String(key).slice(0, 160)] = [
        Number(value[0]),
        Number(value[1]),
        typeof value[2] === 'number' ? Number(value[2]) : 0,
      ];
    }
  }
  return {
    enabled: raw.enabled !== false,
    currency: String(raw.currency || DEFAULT_BUDGET.currency).toUpperCase().slice(0, 3),
    maxCostPerRun: Math.max(0, Number(raw.maxCostPerRun) || DEFAULT_BUDGET.maxCostPerRun),
    maxTokensPerRun: boundedInteger(raw.maxTokensPerRun, DEFAULT_BUDGET.maxTokensPerRun, 100_000, 50_000_000),
    warnAtPercent: boundedInteger(raw.warnAtPercent, DEFAULT_BUDGET.warnAtPercent, 50, 95),
    onExceed: ['pause', 'stop'].includes(raw.onExceed) ? raw.onExceed : DEFAULT_BUDGET.onExceed,
    pricingOverrides,
  };
}

function normalizeAgentPolicy(raw = {}) {
  return {
    enabled: raw.enabled !== false,
    supervisorPlanning: raw.supervisorPlanning !== false,
    autoResume: raw.autoResume !== false,
    sourceProtection: raw.sourceProtection !== false,
    crossRoleFallback: raw.crossRoleFallback === true,
    maxAttemptsPerModel: boundedInteger(raw.maxAttemptsPerModel, DEFAULT_AGENT_POLICY.maxAttemptsPerModel, 1, 5),
    maxAttemptsPerRun: boundedInteger(raw.maxAttemptsPerRun, DEFAULT_AGENT_POLICY.maxAttemptsPerRun, 4, 24),
    retryBackoffSeconds: boundedInteger(raw.retryBackoffSeconds, DEFAULT_AGENT_POLICY.retryBackoffSeconds, 0, 60),
    stageTimeoutMinutes: boundedInteger(raw.stageTimeoutMinutes, DEFAULT_AGENT_POLICY.stageTimeoutMinutes, 5, 240),
    budget: normalizeBudget(raw.budget),
  };
}

function stageRole(stage) {
  const role = STAGE_ROLES[stage];
  if (!role) throw new Error(`不支持的 Agent 阶段：${stage}`);
  return role;
}

function safeSummary(value, limit = 1200) {
  return String(value || '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
    .slice(0, limit);
}

function createRunState({ runId = crypto.randomUUID(), stages = PIPELINE_STAGES, policy, now = Date.now() } = {}) {
  const normalizedStages = stages.map((stage) => {
    stageRole(stage);
    return stage;
  });
  const timestamp = new Date(now).toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    runId,
    status: 'created',
    approvalMode: 'unattended',
    unattendedAuthorizedAt: timestamp,
    startedAt: timestamp,
    updatedAt: timestamp,
    completedAt: null,
    currentStage: normalizedStages[0] || null,
    lastSeq: 0,
    policy: normalizeAgentPolicy(policy),
    plan: null,
    cancelRequested: false,
    tasks: Object.fromEntries(normalizedStages.map((stage) => [stage, {
      stage,
      role: stageRole(stage),
      status: 'pending',
      attemptCount: 0,
      recoveryAttemptCount: 0,
      attempts: [],
      artifactRefs: [],
      lastError: null,
      completedAt: null,
    }])),
    messages: [],
    spend: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cost: 0,
      pricingUnknown: false,
      authoritative: false,
      balance: null,
      currency: 'CNY',
      byStage: {},
    },
  };
}

function appendMessage(state, message, now = Date.now()) {
  const normalized = {
    schemaVersion: SCHEMA_VERSION,
    messageId: message.messageId || crypto.randomUUID(),
    runId: state.runId,
    taskId: message.taskId || state.currentStage || 'pipeline',
    attemptId: message.attemptId || null,
    type: safeSummary(message.type, 80),
    from: safeSummary(message.from, 40),
    to: safeSummary(message.to, 40),
    createdAt: new Date(now).toISOString(),
    summary: safeSummary(message.summary),
    artifactRefs: Array.isArray(message.artifactRefs)
      ? message.artifactRefs.map((item) => safeSummary(item, 260)).slice(0, 30)
      : [],
  };
  state.messages = [...state.messages.slice(-119), normalized];
  return normalized;
}

function createEvent(state, type, payload = {}, now = Date.now()) {
  const seq = state.lastSeq + 1;
  return {
    schemaVersion: SCHEMA_VERSION,
    eventId: crypto.randomUUID(),
    runId: state.runId,
    seq,
    type,
    createdAt: new Date(now).toISOString(),
    taskId: payload.taskId || state.currentStage || null,
    attemptId: payload.attemptId || null,
    payload,
  };
}

function isTerminalStatus(status) {
  return ['completed', 'cancelled'].includes(status);
}

function resumeOptionsForState(state, policy = state?.policy) {
  if (!state || typeof state !== 'object') return null;
  if (['created', 'running', 'retrying'].includes(state.status)) {
    return { resume: true, forceResume: false };
  }
  if (state.status === 'paused' && normalizeAgentPolicy(policy).autoResume) {
    return { resume: true, forceResume: true };
  }
  return null;
}

module.exports = {
  ARTIFACT_CONTRACT_VERSION,
  DEFAULT_AGENT_POLICY,
  DEFAULT_BUDGET,
  PIPELINE_STAGES,
  SCHEMA_VERSION,
  STAGE_ROLES,
  appendMessage,
  createEvent,
  createRunState,
  isTerminalStatus,
  normalizeAgentPolicy,
  normalizeBudget,
  resumeOptionsForState,
  safeSummary,
  stageRole,
};
