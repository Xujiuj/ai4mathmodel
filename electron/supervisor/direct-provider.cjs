const { cleanBaseUrl, connectionProtocol } = require('../model-discovery.cjs');

const ANTHROPIC_VERSION = '2023-06-01';
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_TOOL_OUTPUT_CHARS = 24_000;
const MAX_FINAL_OUTPUT_CHARS = 48_000;
const MAX_TURNS = 72;
const MAX_HISTORY_MESSAGES = 28;

const WORKSPACE_TOOL_DEFINITIONS = Object.freeze([
  {
    name: 'list_workspace_files',
    description: '列出项目 inputs 或 work 目录中的文件。只能访问当前项目，不会返回绝对路径或隐藏运行资料。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对路径，默认为 inputs。' },
        max_depth: { type: 'integer', minimum: 1, maximum: 8, description: '递归深度。' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'read_workspace_file',
    description: '读取 inputs 或 work 内的纯文本文件。用于赛题文本、数据、模板和已生成成果。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '项目根目录下的相对路径。' },
        max_chars: { type: 'integer', minimum: 1000, maximum: 120000, description: '最大返回字符数。' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'inspect_spreadsheet',
    description: '读取 CSV 或 XLSX 的工作表名称、维度和有限行列预览。',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: '项目根目录下的 CSV 或 XLSX 相对路径。' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'inspect_document',
    description: '从 PDF 或 DOCX 中提取受限长度的正文文本，用于理解赛题或模板。',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: '项目根目录下的 PDF 或 DOCX 相对路径。' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'write_workspace_file',
    description: '在 work 目录内创建或覆盖文本成果、Python 代码、TeX、表格或说明文件。不得写入 inputs。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '以 work/ 开头的相对路径。' },
        content: { type: 'string', description: '完整 UTF-8 文本内容。' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_python',
    description: '运行 work 目录内已写入的 Python 脚本。进程使用受限环境，不继承模型密钥或内部资料。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '以 work/ 开头的 Python 脚本相对路径。' },
        timeout_seconds: { type: 'integer', minimum: 5, maximum: 600, description: '单次运行时限。' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'compile_paper',
    description: '编译 work/03_paper 下的论文入口 TeX，并使用可用的本地或随附 LaTeX 编译器。',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
]);

function providerError(code, status = 0) {
  const messages = {
    MODEL_CONFIGURATION_INVALID: '模型配置不完整或接口协议不受支持。',
    MODEL_AUTH_FAILED: '模型服务鉴权失败。',
    MODEL_RATE_LIMITED: '模型服务触发限流或配额保护。',
    MODEL_UNAVAILABLE: '模型服务暂时不可用。',
    MODEL_CONTEXT_LIMIT: '模型上下文超出服务限制。',
    MODEL_RESPONSE_INVALID: '模型服务返回了无法识别的响应。',
    MODEL_REQUEST_TIMEOUT: '模型服务请求超时。',
    MODEL_NETWORK_ERROR: '模型服务网络连接异常。',
    MODEL_TOOL_LIMIT: '模型未能在受限步骤内完成阶段任务。',
  };
  const error = new Error(messages[code] || '模型服务请求失败。');
  error.code = code;
  error.status = status;
  return error;
}

function cleanText(value, limit = MAX_FINAL_OUTPUT_CHARS) {
  return String(value || '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
    .slice(0, limit);
}

function protocolFor(connection = {}) {
  const protocol = connectionProtocol(connection);
  if (!['openai', 'ollama', 'anthropic'].includes(protocol)) throw providerError('MODEL_CONFIGURATION_INVALID');
  return protocol;
}

function providerEndpoint(connection = {}) {
  const protocol = protocolFor(connection);
  const baseUrl = cleanBaseUrl(connection.baseUrl, { allowInsecureRemote: Boolean(connection.allowInsecureRemote) });
  if (!baseUrl) throw providerError('MODEL_CONFIGURATION_INVALID');
  if (protocol === 'ollama') return `${baseUrl.replace(/\/api(?:\/.*)?$/i, '')}/api/chat`;
  if (protocol === 'anthropic') {
    const root = /\/v1(?:\/.*)?$/i.test(baseUrl) ? baseUrl.replace(/\/v1(?:\/.*)?$/i, '') : baseUrl;
    return `${root}/v1/messages`;
  }
  return `${baseUrl.replace(/\/chat\/completions$/i, '')}/chat/completions`;
}

function providerHeaders(protocol, apiKey = '', authMode = 'api-key') {
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
  if (protocol === 'anthropic') {
    headers['anthropic-version'] = ANTHROPIC_VERSION;
    if (apiKey && authMode === 'bearer') headers.Authorization = `Bearer ${apiKey}`;
    else if (apiKey) headers['x-api-key'] = apiKey;
  } else if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

function providerTools(protocol, tools = WORKSPACE_TOOL_DEFINITIONS) {
  if (protocol === 'anthropic') {
    return tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.input_schema }));
  }
  return tools.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.input_schema },
  }));
}

function textFromContent(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map((item) => typeof item === 'string' ? item : item?.text || item?.content || '')
    .filter(Boolean)
    .join('\n');
}

function parseArguments(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function openAiAnswer(payload) {
  const message = payload?.choices?.[0]?.message;
  if (!message || typeof message !== 'object') throw providerError('MODEL_RESPONSE_INVALID');
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls
    .filter((call) => call?.function?.name)
    .map((call, index) => ({
      id: cleanText(call.id || `tool-${index}`, 160),
      name: cleanText(call.function.name, 80),
      input: parseArguments(call.function.arguments),
      raw: call,
    })) : [];
  return { text: cleanText(textFromContent(message.content)), toolCalls, assistant: message };
}

function ollamaAnswer(payload) {
  const message = payload?.message;
  if (!message || typeof message !== 'object') throw providerError('MODEL_RESPONSE_INVALID');
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls
    .filter((call) => call?.function?.name || call?.name)
    .map((call, index) => ({
      id: cleanText(call.id || `tool-${index}`, 160),
      name: cleanText(call.function?.name || call.name, 80),
      input: parseArguments(call.function?.arguments || call.arguments),
      raw: call,
    })) : [];
  return { text: cleanText(textFromContent(message.content)), toolCalls, assistant: message };
}

function anthropicAnswer(payload) {
  const content = Array.isArray(payload?.content) ? payload.content : null;
  if (!content) throw providerError('MODEL_RESPONSE_INVALID');
  const toolCalls = content
    .filter((item) => item?.type === 'tool_use' && item?.name)
    .map((item, index) => ({
      id: cleanText(item.id || `tool-${index}`, 160),
      name: cleanText(item.name, 80),
      input: item.input && typeof item.input === 'object' ? item.input : {},
      raw: item,
    }));
  return {
    text: cleanText(content.filter((item) => item?.type === 'text').map((item) => item.text || '').join('\n')),
    toolCalls,
    assistant: { role: 'assistant', content },
  };
}

async function responseJson(response) {
  const length = Number(response?.headers?.get?.('content-length') || 0);
  if (length > MAX_RESPONSE_BYTES) throw providerError('MODEL_RESPONSE_INVALID');
  const payload = Buffer.from(await response.arrayBuffer());
  if (!payload.length || payload.length > MAX_RESPONSE_BYTES) throw providerError('MODEL_RESPONSE_INVALID');
  try {
    return JSON.parse(payload.toString('utf8'));
  } catch {
    throw providerError('MODEL_RESPONSE_INVALID');
  }
}

function statusError(status) {
  if (status === 401 || status === 403) return providerError('MODEL_AUTH_FAILED', status);
  if (status === 429) return providerError('MODEL_RATE_LIMITED', status);
  if (status === 408 || status === 504) return providerError('MODEL_REQUEST_TIMEOUT', status);
  if (status === 400 || status === 404 || status === 422) return providerError('MODEL_CONTEXT_LIMIT', status);
  return providerError('MODEL_UNAVAILABLE', status);
}

function trimHistory(messages, protocol) {
  if (messages.length <= MAX_HISTORY_MESSAGES) return messages;
  const initial = messages[0];
  const tail = messages.slice(-(MAX_HISTORY_MESSAGES - 1));
  if (protocol === 'anthropic' && tail[0]?.role === 'user' && Array.isArray(tail[0]?.content)) {
    const preceding = messages[messages.length - MAX_HISTORY_MESSAGES];
    if (preceding?.role === 'assistant') return [initial, preceding, ...tail].slice(-MAX_HISTORY_MESSAGES);
  }
  return [initial, ...tail];
}

function serializeToolResult(value) {
  let text;
  try {
    text = JSON.stringify(value ?? { ok: true });
  } catch {
    text = JSON.stringify({ ok: false, error: 'TOOL_RESULT_SERIALIZATION_FAILED' });
  }
  if (text.length <= MAX_TOOL_OUTPUT_CHARS) return text;
  return JSON.stringify({
    ok: true,
    truncated: true,
    preview: text.slice(0, MAX_TOOL_OUTPUT_CHARS),
  });
}

function createRequest(protocol, { model, systemPrompt, messages, tools }) {
  if (protocol === 'anthropic') {
    return {
      model,
      max_tokens: 8192,
      system: cleanText(systemPrompt, 32_000),
      messages,
      tools: providerTools(protocol, tools),
    };
  }
  const normalizedMessages = [
    { role: 'system', content: cleanText(systemPrompt, 32_000) },
    ...messages,
  ];
  if (protocol === 'ollama') return { model, stream: false, messages: normalizedMessages, tools: providerTools(protocol, tools) };
  return { model, messages: normalizedMessages, tools: providerTools(protocol, tools), tool_choice: 'auto', temperature: 0.2 };
}

async function callProvider({ connection, apiKey, systemPrompt, messages, tools, fetchImpl, timeoutMs, signal }) {
  const protocol = protocolFor(connection);
  const endpoint = providerEndpoint(connection);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener?.('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), Math.max(1_000, Math.min(Number(timeoutMs) || 120_000, 12 * 60 * 1000)));
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: providerHeaders(protocol, apiKey, connection.authMode),
      body: JSON.stringify(createRequest(protocol, {
        model: cleanText(connection.model, 240),
        systemPrompt,
        messages: trimHistory(messages, protocol),
        tools,
      })),
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response?.ok) throw statusError(Number(response?.status) || 0);
    const payload = await responseJson(response);
    if (protocol === 'anthropic') return { protocol, ...anthropicAnswer(payload) };
    if (protocol === 'ollama') return { protocol, ...ollamaAnswer(payload) };
    return { protocol, ...openAiAnswer(payload) };
  } catch (error) {
    if (error?.code?.startsWith?.('MODEL_')) throw error;
    if (controller.signal.aborted || error?.name === 'AbortError') throw providerError('MODEL_REQUEST_TIMEOUT');
    throw providerError('MODEL_NETWORK_ERROR');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
}

function appendToolResults(protocol, messages, answer, results) {
  if (protocol === 'anthropic') {
    messages.push(answer.assistant);
    messages.push({
      role: 'user',
      content: results.map((result) => ({ type: 'tool_result', tool_use_id: result.id, content: result.content })),
    });
    return;
  }
  messages.push({ ...answer.assistant, role: 'assistant' });
  for (const result of results) {
    messages.push({ role: 'tool', tool_call_id: result.id, name: result.name, content: result.content });
  }
}

async function runDirectAgent({
  connection = {},
  apiKey = '',
  systemPrompt = '',
  prompt = '',
  tools = WORKSPACE_TOOL_DEFINITIONS,
  executeTool,
  fetchImpl = globalThis.fetch,
  timeoutMs = 120_000,
  signal,
  maxTurns = MAX_TURNS,
} = {}) {
  if (typeof fetchImpl !== 'function' || typeof executeTool !== 'function' || !connection.model || !connection.baseUrl) {
    throw providerError('MODEL_CONFIGURATION_INVALID');
  }
  const protocol = protocolFor(connection);
  const allowedTools = new Set(tools.map((tool) => tool.name));
  const messages = [{ role: 'user', content: cleanText(prompt, 80_000) }];
  let toolCallCount = 0;

  for (let turn = 0; turn < Math.max(1, Math.min(Number(maxTurns) || MAX_TURNS, MAX_TURNS)); turn += 1) {
    if (signal?.aborted) throw providerError('MODEL_REQUEST_TIMEOUT');
    const answer = await callProvider({
      connection,
      apiKey,
      systemPrompt,
      messages,
      tools,
      fetchImpl,
      timeoutMs,
      signal,
    });
    if (!answer.toolCalls.length) {
      return { code: 0, stdout: answer.text, stderr: '', toolCallCount, turns: turn + 1, provider: protocol };
    }

    const results = [];
    for (const [index, call] of answer.toolCalls.entries()) {
      toolCallCount += 1;
      let value;
      if (index >= 12) {
        value = { ok: false, error: 'TOOL_CALL_BATCH_LIMIT' };
      } else if (!allowedTools.has(call.name)) {
        value = { ok: false, error: 'TOOL_NOT_ALLOWED' };
      } else {
        try {
          value = await executeTool({ name: call.name, input: call.input });
        } catch (error) {
          value = { ok: false, error: cleanText(error?.code || 'TOOL_EXECUTION_FAILED', 100) };
        }
      }
      results.push({ id: call.id, name: call.name, content: serializeToolResult(value) });
    }
    appendToolResults(protocol, messages, answer, results);
  }
  throw providerError('MODEL_TOOL_LIMIT');
}

module.exports = {
  ANTHROPIC_VERSION,
  WORKSPACE_TOOL_DEFINITIONS,
  callProvider,
  providerEndpoint,
  providerError,
  providerHeaders,
  providerTools,
  runDirectAgent,
};
