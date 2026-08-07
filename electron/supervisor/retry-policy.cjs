const { safeSummary } = require('./contracts.cjs');

const FAILURE_CLASSES = Object.freeze({
  AUTH: 'auth',
  RATE_LIMIT: 'rate_limit',
  TRANSPORT: 'transport',
  MODEL: 'model',
  TOOLING: 'tooling',
  ARTIFACT: 'artifact',
  PRECONDITION: 'precondition',
  CONFIGURATION: 'configuration',
  SECURITY: 'security',
  CANCELLED: 'cancelled',
  PROCESS: 'process',
  UNKNOWN: 'unknown',
});

function redactText(value, { secrets = [], projectRoot = '', userHome = '' } = {}) {
  let text = String(value || '');
  const sensitive = [...secrets, process.env.OPENAI_API_KEY, process.env.MATH_MODEL_IMAGE_API_KEY]
    .map((item) => String(item || '').trim())
    .filter((item) => item.length >= 6);
  for (const secret of sensitive) text = text.split(secret).join('[REDACTED]');
  text = text
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|token|secret)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]');
  if (projectRoot) text = text.split(projectRoot).join('<PROJECT_ROOT>');
  if (userHome) text = text.split(userHome).join('<USER_HOME>');
  return safeSummary(text, 16000);
}

function classifyFailure(result = {}) {
  if (result.cancelled) return { category: FAILURE_CLASSES.CANCELLED, retryable: false, reason: '用户已取消运行。' };
  if (result.validation && result.validation.ok === false) {
    return { category: FAILURE_CLASSES.ARTIFACT, retryable: true, reason: safeSummary(result.validation.reason || '阶段产物未通过验证。') };
  }
  if (result.timedOut) return { category: FAILURE_CLASSES.TRANSPORT, retryable: true, reason: 'Agent 超过阶段看门狗时限。' };
  const errorCode = String(result.error?.code || '');
  const errorStatus = Number(result.error?.status || 0);
  const text = `${result.error?.message || ''}\n${result.stderr || ''}\n${result.stdout || ''}`.toLowerCase();
  if (errorCode === 'MODEL_AUTH_FAILED') {
    return { category: FAILURE_CLASSES.AUTH, retryable: false, reason: '模型服务鉴权失败。' };
  }
  if (errorCode === 'MODEL_RATE_LIMITED') {
    return { category: FAILURE_CLASSES.RATE_LIMIT, retryable: true, reason: '模型服务触发限流或配额保护。' };
  }
  if (errorCode === 'MODEL_UNAVAILABLE' && errorStatus >= 500 && errorStatus < 600) {
    return { category: FAILURE_CLASSES.TRANSPORT, retryable: true, reason: '模型服务上游暂时不可用。' };
  }
  if (errorCode === 'BUDGET_EXCEEDED') {
    return { category: FAILURE_CLASSES.CONFIGURATION, retryable: false, reason: result.error?.message || '已达到本次运行的预算上限。' };
  }
  if (['MODEL_CONFIGURATION_INVALID', 'LATEX_COMPILER_MISSING'].includes(errorCode)) {
    return { category: FAILURE_CLASSES.CONFIGURATION, retryable: false, reason: '模型或本地运行环境配置不完整。' };
  }
  if (['MODEL_CONTEXT_LIMIT', 'MODEL_RESPONSE_INVALID'].includes(errorCode)) {
    return { category: FAILURE_CLASSES.MODEL, retryable: false, reason: '当前模型不可用或不兼容。' };
  }
  if (['MODEL_REQUEST_TIMEOUT', 'MODEL_NETWORK_ERROR'].includes(errorCode)) {
    return { category: FAILURE_CLASSES.TRANSPORT, retryable: true, reason: '模型服务网络连接异常。' };
  }
  if (errorCode === 'ENOENT' || /executable.*not found|command not found|not recognized|未找到.*(?:命令|可执行)/i.test(text)) {
    return { category: FAILURE_CLASSES.CONFIGURATION, retryable: false, reason: '执行器或必要命令不可用。' };
  }
  if (/越界|outside (?:the )?(?:project|workspace)|untrusted|security violation|permission denied/i.test(text)) {
    return { category: FAILURE_CLASSES.SECURITY, retryable: false, reason: '安全边界拒绝了本次操作。' };
  }
  if (/\b(?:401|403)\b|unauthori[sz]ed|forbidden|invalid api key|鉴权失败|密钥.*(?:无效|错误)/i.test(text)) {
    return { category: FAILURE_CLASSES.AUTH, retryable: false, reason: '模型服务鉴权失败。' };
  }
  if (/\b429\b|rate.?limit|too many requests|quota|限流|请求过多|配额/i.test(text)) {
    return { category: FAILURE_CLASSES.RATE_LIMIT, retryable: true, reason: '模型服务触发限流或配额保护。' };
  }
  if (/unknown model|model.*(?:not found|unavailable|unsupported)|context length|context window|上下文.*(?:过长|超限)|模型.*(?:不存在|不可用)/i.test(text)) {
    return { category: FAILURE_CLASSES.MODEL, retryable: false, reason: '当前模型不可用或不兼容。' };
  }
  if (/econn|enotfound|etimedout|socket|network|connection (?:reset|refused)|timeout|网络|连接.*(?:失败|超时|拒绝)/i.test(text)) {
    return { category: FAILURE_CLASSES.TRANSPORT, retryable: true, reason: '模型服务网络连接异常。' };
  }
  if (/inputs?.*(?:missing|not found)|missing.*(?:problem|template)|输入.*缺失|赛题.*缺失|模板.*缺失/i.test(text)) {
    return { category: FAILURE_CLASSES.PRECONDITION, retryable: false, reason: '阶段前置输入不完整。' };
  }
  if (/xelatex|tectonic|python|bash|tool.*failed|工具.*失败/i.test(text)) {
    return { category: FAILURE_CLASSES.TOOLING, retryable: true, reason: '阶段工具执行失败。' };
  }
  if (Number(result.code) !== 0 || result.signal) {
    return { category: FAILURE_CLASSES.PROCESS, retryable: true, reason: `Agent 进程异常退出${result.code == null ? '' : `（代码 ${result.code}）`}。` };
  }
  return { category: FAILURE_CLASSES.UNKNOWN, retryable: true, reason: 'Agent 返回了无法分类的异常结果。' };
}

function shouldSkipRemainingRoute(failure) {
  return [
    FAILURE_CLASSES.AUTH,
    FAILURE_CLASSES.MODEL,
    FAILURE_CLASSES.CONFIGURATION,
  ].includes(failure.category);
}

function shouldPauseImmediately(failure) {
  return [
    FAILURE_CLASSES.CANCELLED,
    FAILURE_CLASSES.PRECONDITION,
    FAILURE_CLASSES.SECURITY,
    FAILURE_CLASSES.CONFIGURATION,
  ].includes(failure.category);
}

function recoveryInstruction(failure) {
  const instructions = {
    artifact: '核对缺失或无效产物的生成链，修复根因后重新验证，不得用空文件或虚构结果绕过门禁。',
    tooling: '检查工具调用、依赖和路径，采用已安装的等价工具降级，不得删除正文或数据来规避错误。',
    transport: '缩小单次上下文并重试；若仍失败，切换到下一可用模型路由。',
    rate_limit: '等待退避窗口后重试，并优先切换到备用模型。',
    process: '读取上一尝试的脱敏错误，定位最早根因，以幂等方式继续当前阶段。',
    unknown: '重新检查阶段门禁、工具输出和产物契约，先定位根因再重试。',
  };
  return instructions[failure.category] || failure.reason;
}

module.exports = {
  FAILURE_CLASSES,
  classifyFailure,
  recoveryInstruction,
  redactText,
  shouldPauseImmediately,
  shouldSkipRemainingRoute,
};
