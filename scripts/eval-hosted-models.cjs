#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  providerEndpoint,
  providerHeaders,
  runDirectAgent,
} = require('../electron/supervisor/direct-provider.cjs');

const TOOL_NAME = 'phase0_echo';
const TOOL_SENTINEL = 'PHASE0_TOOL_OK';
const SYSTEM_SENTINEL = 'PHASE0_SYSTEM_SENTINEL_V1';
const DEFAULT_OUTPUT = path.join('docs', 'hosted-model-matrix.md');

function parseArgs(argv = []) {
  const options = {
    config: path.join('scripts', 'hosted-eval.config.json'),
    output: DEFAULT_OUTPUT,
    checkConfig: false,
    includeExpensive: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--config') options.config = argv[++index];
    else if (arg === '--output') options.output = argv[++index];
    else if (arg === '--check-config') options.checkConfig = true;
    else if (arg === '--include-expensive') options.includeExpensive = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`未知参数：${arg}`);
  }
  if (!options.config) throw new Error('--config 需要文件路径。');
  if (!options.output) throw new Error('--output 需要文件路径。');
  return options;
}

function loadConfig(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`无法读取评测配置 ${filePath}：${error.message}`);
  }
  return validateConfig(parsed);
}

function validateConfig(raw = {}) {
  if (!Array.isArray(raw.models) || raw.models.length === 0) {
    throw new Error('评测配置至少需要一个 models 条目。');
  }
  const seen = new Set();
  const models = raw.models.map((item, index) => {
    const id = String(item?.id || '').trim();
    const protocol = String(item?.protocol || '').trim();
    const baseUrl = String(item?.baseUrl || '').replace(/\/+$/, '');
    const model = String(item?.model || '').trim();
    const apiKeyEnv = String(item?.apiKeyEnv || '').trim();
    if (!id || seen.has(id)) throw new Error(`models[${index}].id 缺失或重复。`);
    seen.add(id);
    if (!['openai', 'anthropic'].includes(protocol)) {
      throw new Error(`models[${index}].protocol 仅支持 openai 或 anthropic。`);
    }
    let url;
    try {
      url = new URL(baseUrl);
    } catch {
      throw new Error(`models[${index}].baseUrl 不是有效 URL。`);
    }
    const localHttp = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
    if (url.protocol !== 'https:' && !localHttp) {
      throw new Error(`models[${index}].baseUrl 必须使用 HTTPS；仅本机地址允许 HTTP。`);
    }
    if (!model || model.includes('REPLACE_AFTER_PHASE0')) throw new Error(`models[${index}].model 尚未配置。`);
    if (!apiKeyEnv || !/^[A-Z][A-Z0-9_]{2,80}$/.test(apiKeyEnv)) {
      throw new Error(`models[${index}].apiKeyEnv 必须是环境变量名。`);
    }
    return {
      id,
      protocol,
      baseUrl,
      model,
      authMode: item.authMode === 'api-key' ? 'api-key' : 'bearer',
      apiKeyEnv,
    };
  });
  const timeoutMs = Math.min(Math.max(Number(raw.timeoutMs) || 120_000, 5_000), 15 * 60_000);
  const expensive = raw.expensive && typeof raw.expensive === 'object' ? raw.expensive : {};
  return {
    models,
    timeoutMs,
    expensive: {
      longContextTokens: (Array.isArray(expensive.longContextTokens) ? expensive.longContextTokens : [])
        .map(Number).filter((value) => Number.isInteger(value) && value >= 1_000 && value <= 250_000),
      concurrency: (Array.isArray(expensive.concurrency) ? expensive.concurrency : [])
        .map(Number).filter((value) => Number.isInteger(value) && value >= 1 && value <= 16),
    },
  };
}

function requiredEnvironment(config, environment = process.env) {
  return config.models.map((model) => ({
    model: model.id,
    variable: model.apiKeyEnv,
    configured: Boolean(environment[model.apiKeyEnv]),
  }));
}

function instrumentFetch(fetchImpl, observations) {
  return async (url, options) => {
    const startedAt = Date.now();
    const response = await fetchImpl(url, options);
    observations.push({
      url: String(url),
      status: Number(response?.status) || 0,
      durationMs: Date.now() - startedAt,
      cost: response?.headers?.get?.('x-cost') || '',
      balance: response?.headers?.get?.('x-balance') || '',
      retryAfter: response?.headers?.get?.('retry-after') || '',
      queuePosition: response?.headers?.get?.('x-queue-position') || '',
    });
    return response;
  };
}

async function runCoreProbe(model, { credential, timeoutMs, fetchImpl }) {
  const observations = [];
  const startedAt = Date.now();
  const result = await runDirectAgent({
    connection: model,
    apiKey: credential,
    systemPrompt: `${SYSTEM_SENTINEL}\n必须先调用 ${TOOL_NAME}，再只输出 ${TOOL_SENTINEL}。`,
    prompt: '执行 Phase 0 工具透传与流式 usage 验证。',
    tools: [{
      name: TOOL_NAME,
      description: 'Return a deterministic Phase 0 validation marker.',
      input_schema: {
        type: 'object',
        properties: { marker: { type: 'string' } },
        required: ['marker'],
        additionalProperties: false,
      },
    }],
    executeTool: async ({ input }) => ({ ok: true, marker: input?.marker || TOOL_SENTINEL }),
    fetchImpl: instrumentFetch(fetchImpl, observations),
    timeoutMs,
    stream: true,
    maxTurns: 4,
  });
  return {
    ok: result.code === 0 && result.toolCallCount > 0,
    toolCalling: result.toolCallCount > 0,
    usageReturned: (result.usage?.inputTokens || 0) + (result.usage?.outputTokens || 0) > 0,
    usage: result.usage,
    turns: result.turns,
    toolCallCount: result.toolCallCount,
    durationMs: Date.now() - startedAt,
    responseText: String(result.stdout || '').slice(0, 240),
    authoritativeCostReturned: observations.some((item) => item.cost !== ''),
    authoritativeBalanceReturned: observations.some((item) => item.balance !== ''),
    observations,
  };
}

function buildLongContextBody(model, targetTokens) {
  const payload = `PHASE0_LONG_CONTEXT_END_${targetTokens}`;
  const filler = 'phase0 context datum '.repeat(Math.ceil(targetTokens / 4));
  const prompt = `${filler}\n${payload}\n只输出上述 PHASE0_LONG_CONTEXT_END 标记。`;
  if (model.protocol === 'anthropic') {
    return { model: model.model, max_tokens: 64, system: SYSTEM_SENTINEL, messages: [{ role: 'user', content: prompt }] };
  }
  return { model: model.model, max_tokens: 64, messages: [{ role: 'system', content: SYSTEM_SENTINEL }, { role: 'user', content: prompt }] };
}

async function runLongContextProbe(model, targetTokens, { credential, timeoutMs, fetchImpl }) {
  const startedAt = Date.now();
  const response = await fetchImpl(providerEndpoint(model), {
    method: 'POST',
    headers: providerHeaders(model.protocol, credential, model.authMode),
    body: JSON.stringify(buildLongContextBody(model, targetTokens)),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.text();
  return {
    targetTokens,
    ok: response.ok && body.includes(`PHASE0_LONG_CONTEXT_END_${targetTokens}`),
    status: response.status,
    durationMs: Date.now() - startedAt,
    responseBytes: Buffer.byteLength(body),
  };
}

async function runConcurrencyProbe(model, concurrency, options) {
  const startedAt = Date.now();
  const settled = await Promise.allSettled(Array.from({ length: concurrency }, () => runCoreProbe(model, options)));
  const passed = settled.filter((item) => item.status === 'fulfilled' && item.value.ok).length;
  const failures = settled.filter((item) => item.status === 'rejected').map((item) => String(item.reason?.code || item.reason?.message || item.reason));
  return { concurrency, passed, failed: settled.length - passed, durationMs: Date.now() - startedAt, failures };
}

async function runPhase0Evaluation(config, {
  environment = process.env,
  fetchImpl = globalThis.fetch,
  includeExpensive = false,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('当前 Node 运行时不支持 fetch。');
  const missing = requiredEnvironment(config, environment).filter((item) => !item.configured);
  if (missing.length) throw new Error(`缺少评测凭据环境变量：${missing.map((item) => item.variable).join(', ')}`);
  const results = [];
  for (const model of config.models) {
    const options = { credential: environment[model.apiKeyEnv], timeoutMs: config.timeoutMs, fetchImpl };
    const item = { id: model.id, protocol: model.protocol, model: model.model, core: null, longContext: [], concurrency: [] };
    try {
      item.core = await runCoreProbe(model, options);
    } catch (error) {
      item.core = { ok: false, error: String(error?.code || error?.message || error) };
    }
    if (includeExpensive) {
      for (const targetTokens of config.expensive.longContextTokens) {
        try {
          item.longContext.push(await runLongContextProbe(model, targetTokens, options));
        } catch (error) {
          item.longContext.push({ targetTokens, ok: false, error: String(error?.code || error?.message || error) });
        }
      }
      for (const concurrency of config.expensive.concurrency) {
        item.concurrency.push(await runConcurrencyProbe(model, concurrency, options));
      }
    }
    results.push(item);
  }
  return {
    generatedAt: new Date().toISOString(),
    includeExpensive,
    results,
    manualChecks: [
      '上游是否在 system prompt 前追加或改写内容',
      '八轮工具调用是否保持 sticky session',
      'sub2api 登录、账户、API Key 与充值接口的真实路径和字段',
      '生图通道并发与限流行为',
      '注入点归属与国内边缘可达性',
    ],
  };
}

function status(value) {
  if (value === true) return 'PASS';
  if (value === false) return 'FAIL';
  return 'NOT RUN';
}

function formatMarkdown(report) {
  const lines = [
    '# Hosted Model Phase 0 Matrix',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    '| Candidate | Protocol | Tool calling | Usage returned | X-Cost | X-Balance | Duration |',
    '|---|---|---:|---:|---:|---:|---:|',
  ];
  for (const item of report.results) {
    const core = item.core || {};
    lines.push(`| ${item.id} (${item.model}) | ${item.protocol} | ${status(core.toolCalling)} | ${status(core.usageReturned)} | ${status(core.authoritativeCostReturned)} | ${status(core.authoritativeBalanceReturned)} | ${core.durationMs ?? '-'} ms |`);
  }
  lines.push('', '## Expensive Probes', '');
  if (!report.includeExpensive) lines.push('Not run. Re-run with `--include-expensive` after confirming quota and cost limits.', '');
  for (const item of report.results) {
    for (const probe of item.longContext || []) lines.push(`- ${item.id} long context ${probe.targetTokens}: ${status(probe.ok)} (${probe.durationMs ?? '-'} ms)`);
    for (const probe of item.concurrency || []) lines.push(`- ${item.id} concurrency ${probe.concurrency}: ${probe.passed}/${probe.concurrency} passed (${probe.durationMs ?? '-'} ms)`);
  }
  lines.push('', '## Manual Evidence Still Required', '');
  for (const check of report.manualChecks) lines.push(`- [ ] ${check}`);
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function helpText() {
  return [
    'Usage: node scripts/eval-hosted-models.cjs [options]',
    '',
    '  --config <path>       Local JSON config (default: scripts/hosted-eval.config.json)',
    '  --output <path>       Markdown evidence output (default: docs/hosted-model-matrix.md)',
    '  --check-config        Validate schema and report required environment variables only',
    '  --include-expensive   Enable configured long-context and concurrency probes',
  ].join('\n');
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${helpText()}\n`);
    return 0;
  }
  const config = loadConfig(path.resolve(options.config));
  const required = requiredEnvironment(config);
  if (options.checkConfig) {
    process.stdout.write(`${JSON.stringify({ valid: true, requiredEnvironment: required }, null, 2)}\n`);
    return 0;
  }
  const report = await runPhase0Evaluation(config, { includeExpensive: options.includeExpensive });
  const output = path.resolve(options.output);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, formatMarkdown(report), 'utf8');
  process.stdout.write(`${JSON.stringify({ output, candidates: report.results.length, includeExpensive: report.includeExpensive }, null, 2)}\n`);
  return report.results.every((item) => item.core?.ok) ? 0 : 1;
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  });
}

module.exports = {
  buildLongContextBody,
  formatMarkdown,
  instrumentFetch,
  loadConfig,
  parseArgs,
  requiredEnvironment,
  runCoreProbe,
  runPhase0Evaluation,
  validateConfig,
};
