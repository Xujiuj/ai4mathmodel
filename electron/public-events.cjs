const PUBLIC_STAGES = new Set(['analysis', 'solving', 'paper', 'review', 'compile']);

function stageOf(event) {
  const candidate = event?.payload?.stage || event?.taskId || null;
  return PUBLIC_STAGES.has(candidate) ? candidate : null;
}

function publicEvent(type, status, stage, message, timestamp) {
  return {
    type,
    status,
    stage,
    message,
    at: Number.isFinite(Date.parse(timestamp)) ? Date.parse(timestamp) : Date.now(),
  };
}

function toPublicPipelineEvent(event) {
  const stage = stageOf(event);
  switch (event?.type) {
    case 'run.started':
      return publicEvent('pipeline-progress', 'running', stage || 'analysis', '完整流程已启动', event.createdAt);
    case 'run.resumed':
      return publicEvent('pipeline-progress', 'recovering', stage || 'analysis', '正在继续未完成的流程', event.createdAt);
    case 'supervisor.planning':
      return publicEvent('pipeline-progress', 'preparing', stage || 'analysis', '正在准备求解任务', event.createdAt);
    case 'task.dispatched':
    case 'attempt.started':
      return publicEvent('stage-progress', 'running', stage, '当前阶段正在处理', event.createdAt);
    case 'attempt.failed':
    case 'attempt.retry_scheduled':
    case 'route.degraded':
    case 'supervisor.degraded':
      return publicEvent('stage-progress', 'recovering', stage, '当前阶段遇到问题，正在自动恢复', event.createdAt);
    case 'task.succeeded':
      return publicEvent('stage-progress', 'completed', stage, '当前阶段已完成并通过检查', event.createdAt);
    case 'task.cleaned':
      return publicEvent('stage-progress', 'organizing', stage, '正在整理阶段结果', event.createdAt);
    case 'run.completed':
      return publicEvent('pipeline-complete', 'completed', null, '完整求解已完成', event.createdAt);
    case 'run.cancelled':
      return publicEvent('pipeline-complete', 'cancelled', stage, '完整流程已停止', event.createdAt);
    case 'run.paused':
      return publicEvent('pipeline-complete', 'paused', stage, '流程暂时无法继续，请检查模型连接后重试', event.createdAt);
    default:
      return null;
  }
}

module.exports = {
  PUBLIC_STAGES,
  toPublicPipelineEvent,
};
