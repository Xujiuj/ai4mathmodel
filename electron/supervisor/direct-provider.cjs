const { cleanBaseUrl, connectionProtocol } = require('../model-discovery.cjs');
const { RESEARCH_TOOL_DEFINITION, RESEARCH_TOOL_NAME } = require('./research.cjs');

const ANTHROPIC_VERSION = '2023-06-01';
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_TOOL_OUTPUT_CHARS = 24_000;
const MAX_FINAL_OUTPUT_CHARS = 48_000;
const MAX_TURNS = 72;
const MAX_HISTORY_MESSAGES = 28;
const MAX_HISTORY_SUMMARY_CHARS = 1_800;

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
  RESEARCH_TOOL_DEFINITION,
]);

function providerError(code, status = 0) {
  const messages = {
    MODEL_CONFIGURATION_INVALID: '模型配置不完整或接口协议不受支持。',
    MODEL_AUTH_FAILED: '模型服务鉴权失败。',
    MODEL_BALANCE_EXHAUSTED: '账户余额不足，请先充值后继续。',
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
  if (!['openai', 'openai-responses', 'ollama', 'anthropic'].includes(protocol)) throw providerError('MODEL_CONFIGURATION_INVALID');
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
  if (protocol === 'openai-responses') {
    const root = /\/v1(?:\/.*)?$/i.test(baseUrl) ? baseUrl.replace(/\/v1(?:\/.*)?$/i, '') : baseUrl;
    return `${root}/v1/responses`;
  }
  return `${baseUrl.replace(/\/chat\/completions$/i, '')}/chat/completions`;
}

const ALLOWED_EXTRA_HEADERS = new Set(['X-Device-Id', 'X-Stage', 'X-Pipeline-Id']);

function sanitizeExtraHeaders(extra = {}) {
  const headers = {};
  for (const [name, value] of Object.entries(extra || {})) {
    if (!ALLOWED_EXTRA_HEADERS.has(name)) continue;
    const text = String(value ?? '').replace(/[^\x20-\x7e]/g, '').slice(0, 200);
    if (text) headers[name] = text;
  }
  return headers;
}

function providerHeaders(protocol, apiKey = '', authMode = 'api-key', extraHeaders = {}) {
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json', ...sanitizeExtraHeaders(extraHeaders) };
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
  if (protocol === 'openai-responses') {
    return tools.map((tool) => {
      const source = tool?.function || tool || {};
      return {
      type: 'function',
      name: source.name,
      description: source.description || '',
      parameters: source.parameters || source.input_schema || {},
      strict: source.strict !== false,
      };
    });
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
  const usage = {
    inputTokens: Number(payload?.usage?.prompt_tokens || 0),
    outputTokens: Number(payload?.usage?.completion_tokens || 0),
    cacheReadTokens: 0,
  };
  return { text: cleanText(textFromContent(message.content)), toolCalls, assistant: message, usage };
}

function responsesAnswer(payload) {
  const output = Array.isArray(payload?.output) ? payload.output : [];
  const text = output
    .filter((item) => item?.type === 'message')
    .flatMap((item) => Array.isArray(item.content) ? item.content : [])
    .filter((part) => part?.type === 'output_text')
    .map((part) => part.text || '')
    .join('');
  const toolCalls = output
    .filter((item) => item?.type === 'function_call' && item?.name)
    .map((item, index) => ({
      id: cleanText(item.call_id || item.id || `tool-${index}`, 160),
      name: cleanText(item.name, 80),
      input: parseArguments(item.arguments),
      raw: item,
    }));
  return {
    text: cleanText(text),
    toolCalls,
    assistant: { role: 'assistant', content: text || null, output },
    usage: {
      inputTokens: Number(payload?.usage?.input_tokens || 0),
      outputTokens: Number(payload?.usage?.output_tokens || 0),
      cacheReadTokens: 0,
    },
  };
}

function mergeStreamDelta(message, chunk) {
  const delta = chunk?.choices?.[0]?.delta;
  if (!delta || typeof delta !== 'object') return;
  if (typeof delta.content === 'string') message.content += delta.content;
  else if (Array.isArray(delta.content)) message.content += textFromContent(delta.content);
  if (!Array.isArray(delta.tool_calls)) return;
  for (const call of delta.tool_calls) {
    const index = Math.max(0, Math.min(Number(call?.index) || 0, 64));
    if (!message.tool_calls[index]) message.tool_calls[index] = { id: '', type: 'function', function: { name: '', arguments: '' } };
    const slot = message.tool_calls[index];
    if (call?.id) slot.id = String(call.id).slice(0, 160);
    if (call?.function?.name) slot.function.name += String(call.function.name);
    if (typeof call?.function?.arguments === 'string') slot.function.arguments += call.function.arguments;
  }
}

function validHttpStatus(value) {
  const status = Number(value);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0;
}

function inBandStreamErrorStatus(error) {
  if (!error || typeof error !== 'object') return 0;
  for (const value of [error.status, error.status_code, error.statusCode, error.http_status, error.httpStatus, error.code]) {
    const status = validHttpStatus(value);
    if (status) return status;
  }
  const detail = [error.type, error.code, error.message].map((value) => String(value || '')).join(' ').toLowerCase();
  if (/rate.?limit|too many requests/.test(detail)) return 429;
  if (/authentication|unauthori[sz]ed|invalid (?:api )?key/.test(detail)) return 401;
  if (/permission|forbidden/.test(detail)) return 403;
  if (/invalid.?request|context|unsupported/.test(detail)) return 400;
  // Some OpenAI-compatible relays have already committed HTTP 200 for SSE
  // before discovering an upstream 5xx. Preserve that retryable meaning.
  if (/upstream|server.?error|api.?error|overload|unavailable|temporar/.test(detail)) return 502;
  return 0;
}

// 长任务经中转与反向代理时，非流式响应易被空闲超时掐断，因此托管链路统一用 SSE 增量重组。
async function readOpenAiStream(response) {
  const reader = response?.body?.getReader?.();
  if (!reader) throw providerError('MODEL_RESPONSE_INVALID');
  const decoder = new TextDecoder();
  const message = { role: 'assistant', content: '', tool_calls: [] };
  let buffer = '';
  let size = 0;
  let usage = null;
  let done = false;

  try {
    const processLine = (rawLine) => {
      const line = rawLine.trim();
      if (!line.startsWith('data:')) return;
      const data = line.slice(5).trim();
      if (data === '[DONE]') {
        done = true;
        return;
      }
      let chunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        return;
      }
      if (chunk?.error) {
        const status = inBandStreamErrorStatus(chunk.error);
        throw status ? statusError(status) : providerError('MODEL_UNAVAILABLE');
      }
      mergeStreamDelta(message, chunk);
      if (chunk?.usage) usage = chunk.usage;
    };

    while (!done) {
      const step = await reader.read();
      if (step.done) break;
      size += step.value?.length || 0;
      if (size > MAX_RESPONSE_BYTES) throw providerError('MODEL_RESPONSE_INVALID');
      buffer += decoder.decode(step.value, { stream: true });
      let breakIndex = buffer.indexOf('\n');
      while (breakIndex >= 0) {
        const line = buffer.slice(0, breakIndex);
        buffer = buffer.slice(breakIndex + 1);
        breakIndex = buffer.indexOf('\n');
        processLine(line);
      }
    }

    // Some fetch implementations finish an SSE response without a final line
    // terminator. Flush the decoder and parse the remaining data record so a
    // complete assistant response is not reported as invalid.
    buffer += decoder.decode();
    if (!done && buffer.trim()) processLine(buffer);

    const toolCalls = message.tool_calls.filter((call) => call?.function?.name);
    if (!message.content && !toolCalls.length) throw providerError('MODEL_RESPONSE_INVALID');
    return {
      choices: [{ message: { ...message, tool_calls: toolCalls.length ? toolCalls : undefined } }],
      usage,
    };
  } catch (error) {
    try {
      await reader.cancel?.();
    } catch {
      // Preserve the parser or reader failure when cleanup itself fails.
    }
    throw error;
  }
}

async function readResponsesStream(response) {
  const reader = response?.body?.getReader?.();
  if (!reader) throw providerError('MODEL_RESPONSE_INVALID');
  const decoder = new TextDecoder();
  const output = [];
  const functionCalls = new Map();
  let text = '';
  let buffer = '';
  let size = 0;
  let usage = null;
  let done = false;
  try {
    const processLine = (rawLine) => {
      const line = rawLine.trim();
      if (!line.startsWith('data:')) return;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') { done = true; return; }
      let event;
      try { event = JSON.parse(data); } catch { return; }
      if (event?.error || event?.type === 'error' || event?.type === 'response.failed') {
        const detail = event.error || event;
        const status = inBandStreamErrorStatus(detail);
        throw status ? statusError(status) : providerError('MODEL_UNAVAILABLE');
      }
      const type = event?.type || '';
      if (type === 'response.output_text.delta') text += String(event.delta || '');
      if (type === 'response.output_item.added' && event.item?.type === 'function_call') {
        const item = { ...event.item, arguments: String(event.item.arguments || '') };
        const key = String(item.call_id || item.id || event.output_index || output.length);
        functionCalls.set(key, item);
        if (item.id) functionCalls.set(String(item.id), item);
        if (item.call_id) functionCalls.set(String(item.call_id), item);
        output.push(item);
      }
      if (type === 'response.function_call_arguments.delta') {
        const key = String(event.call_id || event.item_id || event.output_index || functionCalls.size);
        let item = functionCalls.get(key);
        if (!item) {
          item = { type: 'function_call', call_id: event.call_id || event.item_id || key, name: event.name || '', arguments: '' };
          functionCalls.set(key, item);
          output.push(item);
        }
        item.arguments += String(event.delta || '');
      }
      if (type === 'response.output_item.done' && event.item?.type === 'function_call') {
        const item = event.item;
        const key = String(item.call_id || item.id || event.output_index || output.length);
        const existing = functionCalls.get(key);
        if (existing) Object.assign(existing, item, { arguments: item.arguments ?? existing.arguments });
        else {
          functionCalls.set(key, item);
          output.push(item);
        }
      }
      if (type === 'response.completed' || type === 'response.done') {
        if (Array.isArray(event.response?.output)) {
          for (const item of event.response.output) {
            if (item?.type === 'function_call') {
              const key = String(item.call_id || item.id || output.length);
              const existing = functionCalls.get(key);
              if (existing) Object.assign(existing, item);
              else output.push(item);
            }
          }
        }
        if (event.response?.usage) usage = event.response.usage;
        done = true;
      }
      if (event.usage) usage = event.usage;
    };
    while (!done) {
      const step = await reader.read();
      if (step.done) break;
      size += step.value?.length || 0;
      if (size > MAX_RESPONSE_BYTES) throw providerError('MODEL_RESPONSE_INVALID');
      buffer += decoder.decode(step.value, { stream: true });
      let breakIndex = buffer.indexOf('\n');
      while (breakIndex >= 0) {
        processLine(buffer.slice(0, breakIndex));
        buffer = buffer.slice(breakIndex + 1);
        breakIndex = buffer.indexOf('\n');
      }
    }
    buffer += decoder.decode();
    if (!done && buffer.trim()) processLine(buffer);
    if (!text && !output.length) throw providerError('MODEL_RESPONSE_INVALID');
    return { output: [ ...(text ? [{ type: 'message', content: [{ type: 'output_text', text }] }] : []), ...output ], usage };
  } catch (error) {
    try { await reader.cancel?.(); } catch { /* preserve parser failure */ }
    throw error;
  }
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
  const usage = {
    inputTokens: Number(payload?.prompt_eval_count || 0),
    outputTokens: Number(payload?.eval_count || 0),
    cacheReadTokens: 0,
  };
  return { text: cleanText(textFromContent(message.content)), toolCalls, assistant: message, usage };
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
  const usage = {
    inputTokens: Number(payload?.usage?.input_tokens || 0),
    outputTokens: Number(payload?.usage?.output_tokens || 0),
    cacheReadTokens: Number(payload?.usage?.cache_read_input_tokens || 0),
  };
  return {
    text: cleanText(content.filter((item) => item?.type === 'text').map((item) => item.text || '').join('\n')),
    toolCalls,
    assistant: { role: 'assistant', content },
    usage,
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
  if (status === 402) return providerError('MODEL_BALANCE_EXHAUSTED', status);
  if (status === 429) return providerError('MODEL_RATE_LIMITED', status);
  if (status === 408 || status === 504) return providerError('MODEL_REQUEST_TIMEOUT', status);
  if (status === 400 || status === 404 || status === 422) return providerError('MODEL_CONTEXT_LIMIT', status);
  return providerError('MODEL_UNAVAILABLE', status);
}

function hasOpenAiToolCalls(message) {
  return message?.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
}

function hasAnthropicToolUse(message) {
  return message?.role === 'assistant'
    && Array.isArray(message.content)
    && message.content.some((item) => item?.type === 'tool_use');
}

function hasAnthropicToolResult(message) {
  return message?.role === 'user'
    && Array.isArray(message.content)
    && message.content.some((item) => item?.type === 'tool_result');
}

function filterAnthropicToolResults(message, toolUseIds = null) {
  if (!hasAnthropicToolResult(message)) return message;
  const content = message.content.filter((item) => item?.type !== 'tool_result'
    || (toolUseIds && toolUseIds.has(String(item.tool_use_id))));
  return content.length ? { ...message, content } : null;
}

function historyUnits(messages, protocol) {
  const units = [];
  let index = 1;
  while (index < messages.length) {
    const message = messages[index];
    if (protocol === 'anthropic') {
      if (hasAnthropicToolUse(message)) {
        const group = [message];
        const toolUseIds = new Set(message.content
          .filter((item) => item?.type === 'tool_use' && item.id)
          .map((item) => String(item.id)));
        index += 1;
        if (hasAnthropicToolResult(messages[index])) {
          const resultMessage = filterAnthropicToolResults(messages[index], toolUseIds);
          if (resultMessage) group.push(resultMessage);
          index += 1;
        }
        units.push({ messages: group });
        continue;
      }
      if (hasAnthropicToolResult(message)) {
        const stripped = filterAnthropicToolResults(message);
        if (stripped) units.push({ messages: [stripped] });
        index += 1;
        continue;
      }
    } else {
      if (hasOpenAiToolCalls(message)) {
        const group = [message];
        const toolCallIds = new Set(message.tool_calls
          .filter((call) => call?.id)
          .map((call) => String(call.id)));
        index += 1;
        while (messages[index]?.role === 'tool') {
          const toolResult = messages[index++];
          if (toolResult.tool_call_id && toolCallIds.has(String(toolResult.tool_call_id))) group.push(toolResult);
        }
        units.push({ messages: group });
        continue;
      }
      if (message?.role === 'tool') {
        index += 1;
        continue;
      }
    }
    units.push({ messages: [message] });
    index += 1;
  }
  return units;
}

function summaryTextForMessage(message, protocol) {
  if (message?.role === 'tool') return '';
  if (protocol === 'anthropic' && Array.isArray(message?.content)) {
    return message.content
      .filter((item) => item?.type === 'text')
      .map((item) => item.text || '')
      .join('\n');
  }
  return textFromContent(message?.content);
}

function summarizeHistory(messages, protocol) {
  const toolNames = new Set();
  const snippets = [];
  for (const message of messages) {
    if (message?.role === 'tool') continue;
    if (protocol === 'anthropic' && Array.isArray(message?.content)) {
      for (const item of message.content) {
        if (item?.type === 'tool_use' && item.name) toolNames.add(cleanText(item.name, 80));
      }
    } else if (Array.isArray(message?.tool_calls)) {
      for (const call of message.tool_calls) {
        if (call?.function?.name) toolNames.add(cleanText(call.function.name, 80));
      }
    }
    const text = cleanText(summaryTextForMessage(message, protocol), 220);
    if (text) snippets.push(text);
  }
  const tools = toolNames.size ? ` Tools used: ${Array.from(toolNames).join(', ')}.` : '';
  const notes = snippets.length ? ` Notes: ${snippets.slice(-4).join(' | ')}` : '';
  return cleanText(`Earlier context compacted (${messages.length} messages).${tools}${notes}`, MAX_HISTORY_SUMMARY_CHARS);
}

function mergeAnthropicSummary(initial, summary) {
  if (initial?.role !== 'user') return [initial, { role: 'user', content: summary }];
  if (Array.isArray(initial.content)) {
    return [{ ...initial, content: [...initial.content, { type: 'text', text: summary }] }];
  }
  const content = initial.content ? `${initial.content}\n\n${summary}` : summary;
  return [{ ...initial, content }];
}

function trimHistory(messages, protocol) {
  if (!Array.isArray(messages) || messages.length <= MAX_HISTORY_MESSAGES) return messages;
  const initial = messages[0] || { role: 'user', content: '' };
  const units = historyUnits(messages, protocol);
  const available = Math.max(1, MAX_HISTORY_MESSAGES - 2);
  const selected = [];
  let selectedCount = 0;
  for (let index = units.length - 1; index >= 0; index -= 1) {
    const unit = units[index];
    const unitSize = unit.messages.length;
    if (selected.length && selectedCount + unitSize > available) break;
    selected.unshift(unit);
    selectedCount += unitSize;
  }
  const selectedMessages = selected.flatMap((unit) => unit.messages);
  const selectedSet = new Set(selectedMessages);
  const droppedMessages = messages.slice(1).filter((message) => !selectedSet.has(message));
  if (!droppedMessages.length) return [initial, ...selectedMessages];
  const summary = summarizeHistory(droppedMessages, protocol);
  if (protocol === 'anthropic') return [...mergeAnthropicSummary(initial, summary), ...selectedMessages];
  return [initial, { role: 'user', content: summary }, ...selectedMessages];
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

function createRequest(protocol, { model, systemPrompt, messages, tools, stream = false }) {
  if (protocol === 'anthropic') {
    return {
      model,
      max_tokens: 8192,
      system: cleanText(systemPrompt, 32_000),
      messages,
      tools: providerTools(protocol, tools),
    };
  }
  if (protocol === 'openai-responses') {
    const input = [
      { role: 'developer', content: cleanText(systemPrompt, 32_000) },
      ...messages.flatMap((message) => {
        if (message?.role === 'tool') return [{
          type: 'function_call_output',
          call_id: String(message.tool_call_id || ''),
          output: String(message.content || ''),
        }];
        if (message?.role === 'assistant' && Array.isArray(message.tool_calls)) {
          const calls = message.tool_calls.map((call) => ({
            type: 'function_call',
            call_id: String(call.id || ''),
            name: String(call.function?.name || ''),
            arguments: String(call.function?.arguments || '{}'),
          }));
          if (message.content) calls.push({ role: 'assistant', content: message.content });
          return calls;
        }
        if (message?.role === 'system') return [{ role: 'developer', content: message.content || '' }];
        return [{ role: message?.role || 'user', content: message?.content || '' }];
      }),
    ];
    return {
      model,
      input,
      tools: providerTools('openai-responses', tools),
      tool_choice: 'auto',
      max_output_tokens: 8192,
      ...(stream ? { stream: true } : {}),
    };
  }
  const normalizedMessages = [
    { role: 'system', content: cleanText(systemPrompt, 32_000) },
    ...messages,
  ];
  if (protocol === 'ollama') return { model, stream: false, messages: normalizedMessages, tools: providerTools(protocol, tools) };
  return {
    model,
    messages: normalizedMessages,
    tools: providerTools(protocol, tools),
    tool_choice: 'auto',
    temperature: 0.2,
    ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
  };
}

async function callProvider({ connection, apiKey, systemPrompt, messages, tools, fetchImpl, timeoutMs, signal, extraHeaders, stream = false }) {
  const protocol = protocolFor(connection);
  const streaming = Boolean(stream) && ['openai', 'openai-responses'].includes(protocol);
  const endpoint = providerEndpoint(connection);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener?.('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), Math.max(1_000, Math.min(Number(timeoutMs) || 120_000, 12 * 60 * 1000)));
  let requestId = '';
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        ...providerHeaders(protocol, apiKey, connection.authMode, extraHeaders),
        ...(streaming ? { Accept: 'text/event-stream' } : {}),
      },
      body: JSON.stringify(createRequest(protocol, {
        model: cleanText(connection.model, 240),
        systemPrompt,
        messages: trimHistory(messages, protocol),
        tools,
        stream: streaming,
      })),
      redirect: 'error',
      signal: controller.signal,
    });
    requestId = cleanText(response?.headers?.get?.('x-request-id'), 160);
    if (!response?.ok) {
      const error = statusError(Number(response?.status) || 0);
      if (requestId) error.requestId = requestId;
      throw error;
    }
    if (streaming) {
      const payload = protocol === 'openai-responses'
        ? await readResponsesStream(response)
        : await readOpenAiStream(response);
      return { protocol, requestId, ...(protocol === 'openai-responses' ? responsesAnswer(payload) : openAiAnswer(payload)) };
    }
    const payload = await responseJson(response);
    if (protocol === 'anthropic') return { protocol, requestId, ...anthropicAnswer(payload) };
    if (protocol === 'ollama') return { protocol, requestId, ...ollamaAnswer(payload) };
    return { protocol, requestId, ...(protocol === 'openai-responses' ? responsesAnswer(payload) : openAiAnswer(payload)) };
  } catch (error) {
    if (error?.code?.startsWith?.('MODEL_')) {
      if (requestId && !error.requestId) error.requestId = requestId;
      throw error;
    }
    if (controller.signal.aborted || error?.name === 'AbortError') throw providerError('MODEL_REQUEST_TIMEOUT');
    throw providerError('MODEL_NETWORK_ERROR');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
}

function retryableProviderTransportError(error, signal) {
  return !signal?.aborted && [
    'MODEL_UNAVAILABLE',
    'MODEL_NETWORK_ERROR',
    'MODEL_REQUEST_TIMEOUT',
  ].includes(error?.code);
}

async function callProviderWithRetry({ maxAttempts = 1, signal, onFailure, ...options }) {
  const attempts = Math.max(1, Math.min(Number(maxAttempts) || 1, 5));
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await callProvider({ ...options, signal });
    } catch (error) {
      onFailure?.(error);
      if (attempt >= attempts || !retryableProviderTransportError(error, signal)) throw error;
    }
  }
  throw providerError('MODEL_NETWORK_ERROR');
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
  if (protocol === 'openai-responses') {
    const output = Array.isArray(answer.assistant?.output) ? answer.assistant.output : [];
    for (const item of output) {
      if (item?.type === 'function_call') messages.push({
        role: 'assistant',
        tool_calls: [{ id: item.call_id || item.id, function: { name: item.name, arguments: item.arguments || '{}' } }],
      });
    }
    for (const result of results) messages.push({ role: 'tool', tool_call_id: result.id, content: result.content });
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
  extraHeaders,
  stream = false,
  maxTurns = MAX_TURNS,
  maxProviderAttempts = 1,
  researchToolExecutor,
} = {}) {
  if (typeof fetchImpl !== 'function' || typeof executeTool !== 'function' || !connection.model || !connection.baseUrl) {
    throw providerError('MODEL_CONFIGURATION_INVALID');
  }
  const protocol = protocolFor(connection);
  const allowedTools = new Set(tools.map((tool) => tool.name));
  const messages = [{ role: 'user', content: cleanText(prompt, 80_000) }];
  let toolCallCount = 0;
  const totalUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  const requestIds = [];

  for (let turn = 0; turn < Math.max(1, Math.min(Number(maxTurns) || MAX_TURNS, MAX_TURNS)); turn += 1) {
    if (signal?.aborted) throw providerError('MODEL_REQUEST_TIMEOUT');
    let answer;
    try {
      answer = await callProviderWithRetry({
        connection,
        apiKey,
        systemPrompt,
        messages,
        tools,
        fetchImpl,
        timeoutMs,
        signal,
        extraHeaders,
        stream,
        maxAttempts: maxProviderAttempts,
        onFailure: (error) => {
          if (error?.requestId && !requestIds.includes(error.requestId)) requestIds.push(error.requestId);
        },
      });
    } catch (error) {
      if (error?.requestId && !requestIds.includes(error.requestId)) requestIds.push(error.requestId);
      error.usage = totalUsage;
      error.requestIds = requestIds;
      throw error;
    }
    if (answer.requestId && !requestIds.includes(answer.requestId)) requestIds.push(answer.requestId);

    if (answer.usage) {
      totalUsage.inputTokens += answer.usage.inputTokens || 0;
      totalUsage.outputTokens += answer.usage.outputTokens || 0;
      totalUsage.cacheReadTokens += answer.usage.cacheReadTokens || 0;
    }

    if (!answer.toolCalls.length) {
      return {
        code: 0,
        stdout: answer.text,
        stderr: '',
        toolCallCount,
        turns: turn + 1,
        provider: protocol,
        usage: totalUsage,
        requestIds,
      };
    }

    const results = [];
    for (const [index, call] of answer.toolCalls.entries()) {
      toolCallCount += 1;
      let value;
      if (index >= 12) {
        value = { ok: false, error: 'TOOL_CALL_BATCH_LIMIT' };
      } else if (!allowedTools.has(call.name)) {
        value = { ok: false, error: 'TOOL_NOT_ALLOWED' };
      } else if (call.name === RESEARCH_TOOL_NAME && typeof researchToolExecutor === 'function') {
        try {
          value = await researchToolExecutor(call.input);
        } catch (error) {
          value = { ok: false, error: cleanText(error?.code || 'TOOL_EXECUTION_FAILED', 100) };
        }
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
  const error = providerError('MODEL_TOOL_LIMIT');
  error.usage = totalUsage;
  error.requestIds = requestIds;
  throw error;
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
