const crypto = require('node:crypto');

const SCHEMA_VERSION = 1;
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
  crossRoleFallback: true,
  maxAttemptsPerModel: 2,
  retryBackoffSeconds: 3,
  stageTimeoutMinutes: 90,
});

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function normalizeAgentPolicy(raw = {}) {
  return {
    enabled: raw.enabled !== false,
    supervisorPlanning: raw.supervisorPlanning !== false,
    autoResume: raw.autoResume !== false,
    sourceProtection: raw.sourceProtection !== false,
    crossRoleFallback: raw.crossRoleFallback !== false,
    maxAttemptsPerModel: boundedInteger(raw.maxAttemptsPerModel, DEFAULT_AGENT_POLICY.maxAttemptsPerModel, 1, 4),
    retryBackoffSeconds: boundedInteger(raw.retryBackoffSeconds, DEFAULT_AGENT_POLICY.retryBackoffSeconds, 0, 60),
    stageTimeoutMinutes: boundedInteger(raw.stageTimeoutMinutes, DEFAULT_AGENT_POLICY.stageTimeoutMinutes, 5, 240),
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
      attempts: [],
      artifactRefs: [],
      lastError: null,
      completedAt: null,
    }])),
    messages: [],
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

module.exports = {
  DEFAULT_AGENT_POLICY,
  PIPELINE_STAGES,
  SCHEMA_VERSION,
  STAGE_ROLES,
  appendMessage,
  createEvent,
  createRunState,
  isTerminalStatus,
  normalizeAgentPolicy,
  safeSummary,
  stageRole,
};
