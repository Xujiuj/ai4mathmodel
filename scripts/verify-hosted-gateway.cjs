const crypto = require('node:crypto');
const { app, net, session } = require('electron');
const { hostedEndpoints } = require('../electron/hosted/endpoints.cjs');
const { installHostedCertificateVerifier, registerHostedCertificatePin } = require('../electron/hosted/tls-pinning.cjs');
const { playbookPlaceholder } = require('../electron/hosted/playbook-ref.cjs');
const { WORKSPACE_TOOL_DEFINITIONS, runDirectAgent } = require('../electron/supervisor/direct-provider.cjs');
const { createRunState } = require('../electron/supervisor/contracts.cjs');
const { buildAgentPrompt } = require('../electron/supervisor/supervisor.cjs');
const { stagePrompt } = require('../electron/supervisor/playbooks.cjs');

const requestedModelArgument = process.argv.find((argument) => argument.startsWith('--model-name='));
const requestedModel = requestedModelArgument ? requestedModelArgument.slice('--model-name='.length).trim() : '';
if (requestedModel && !/^[A-Za-z0-9._-]{1,100}$/.test(requestedModel)) {
  throw new Error('Invalid --model-name value');
}
const runModelProbe = process.argv.includes('--model') || Boolean(requestedModel);
const runToolProbe = process.argv.includes('--tool');
const runAgentProbe = process.argv.includes('--agent');
const runAgentLoopProbe = process.argv.includes('--agent-loop');
const runImageProbe = process.argv.includes('--image');
const timeoutMs = 180_000;
const configuredEmail = String(process.env.MMW_HOSTED_PROBE_EMAIL || '').trim().toLowerCase();
const configuredPassword = String(process.env.MMW_HOSTED_PROBE_PASSWORD || '');
const pipelineId = String(process.env.MMW_HOSTED_PROBE_PIPELINE_ID || `gateway-probe-${Date.now()}`)
  .trim()
  .slice(0, 160);
if ((configuredEmail && !configuredPassword) || (!configuredEmail && configuredPassword)) {
  throw new Error('MMW_HOSTED_PROBE_EMAIL and MMW_HOSTED_PROBE_PASSWORD must be supplied together');
}
if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(pipelineId)) throw new Error('Invalid MMW_HOSTED_PROBE_PIPELINE_ID');

registerHostedCertificatePin(app);

async function request(base, path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await net.fetch(`${base}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
    });
    const body = Buffer.from(await response.arrayBuffer());
    let json = null;
    try {
      json = JSON.parse(body.toString('utf8'));
    } catch {
      // The model and image endpoints may return non-JSON errors; status is still useful.
    }
    return { response, json, body: body.toString('utf8') };
  } finally {
    clearTimeout(timer);
  }
}

app.whenReady().then(async () => {
  installHostedCertificateVerifier(session.defaultSession);
  const endpoints = hostedEndpoints();
  if (!endpoints.gateway || !endpoints.portal) throw new Error('Hosted endpoint configuration is missing');
  const email = configuredEmail || `gateway-probe-${Date.now()}-${crypto.randomBytes(4).toString('hex')}@example.invalid`;
  const password = configuredPassword || crypto.randomBytes(18).toString('base64url');
  const result = {};
  try {
    const health = await request(endpoints.gateway, '/health');
    if (!health.response.ok || health.json?.ok !== true) throw new Error(`Health probe failed: ${health.response.status}`);
    result.health = health.response.status;

    const ready = await request(endpoints.gateway, '/ready');
    if (!ready.response.ok || ready.json?.ok !== true) throw new Error(`Readiness probe failed: ${ready.response.status}`);
    result.ready = ready.response.status;

    const session = configuredEmail
      ? await request(endpoints.gateway, '/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      })
      : await request(endpoints.gateway, '/auth/register', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
    const expectedSessionStatus = configuredEmail ? 200 : 201;
    if (session.response.status !== expectedSessionStatus || !session.json?.credential) {
      throw new Error(`${configuredEmail ? 'Login' : 'Registration'} failed: ${session.response.status}`);
    }
    result[configuredEmail ? 'login' : 'registration'] = session.response.status;

    const deviceId = crypto.randomBytes(24).toString('hex');
    const token = await request(endpoints.gateway, '/auth/token', {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.json.credential}` },
      body: JSON.stringify({ deviceId }),
    });
    if (!token.response.ok || !token.json?.accessToken) throw new Error(`Token issuance failed: ${token.response.status}`);
    result.token = token.response.status;
    // Keep the device id only in memory and never place it in result output.
    const authHeaders = { Authorization: `Bearer ${token.json.accessToken}`, 'X-Device-Id': deviceId };
    const paidHeaders = { ...authHeaders, 'X-Pipeline-Id': pipelineId };

    const catalog = await request(endpoints.gateway, '/catalog', { headers: authHeaders });
    if (!catalog.response.ok || !catalog.json?.tiers?.[0]?.models?.reasoning) throw new Error(`Catalog failed: ${catalog.response.status}`);
    result.catalog = catalog.response.status;
    result.reasoningModel = catalog.json.tiers[0].models.reasoning;

    const imageRoute = await request(endpoints.gateway, '/v1/images/generations', {
      method: 'POST',
      headers: paidHeaders,
      body: JSON.stringify({}),
    });
    if (imageRoute.response.status !== 422) throw new Error(`Image route probe failed: ${imageRoute.response.status}`);
    result.imageRoute = imageRoute.response.status;

    const modelName = requestedModel || catalog.json.tiers[0].models.reasoning;
    if (runModelProbe) {
      const model = await request(endpoints.gateway, '/v1/chat/completions', {
        method: 'POST',
        headers: paidHeaders,
        body: JSON.stringify({
          model: modelName,
          max_tokens: 12,
          messages: [
            { role: 'system', content: playbookPlaceholder({ stage: 'analysis' }) },
            { role: 'user', content: '只回复 OK。' },
          ],
        }),
      });
      if (!model.response.ok || !model.response.headers.get('x-request-id')) throw new Error(`Model relay failed: ${model.response.status}`);
      result.model = model.response.status;
      result.probedModel = modelName;
    }

    if (runToolProbe) {
      const tool = await request(endpoints.gateway, '/v1/chat/completions', {
        method: 'POST',
        headers: { ...paidHeaders, Accept: 'text/event-stream' },
        body: JSON.stringify({
          model: modelName,
          stream: true,
          stream_options: { include_usage: true },
          messages: [
            { role: 'system', content: playbookPlaceholder({ stage: 'analysis' }) },
            { role: 'user', content: 'Call the list_workspace_files function with {"path":"inputs"}. Return the function call only.' },
          ],
          tools: [{
            type: 'function',
            function: {
              name: 'list_workspace_files',
              description: 'Lists files below a workspace path.',
              parameters: {
                type: 'object',
                properties: { path: { type: 'string' } },
                required: ['path'],
                additionalProperties: false,
              },
            },
          }],
          tool_choice: { type: 'function', function: { name: 'list_workspace_files' } },
        }),
      });
      const hasToolCall = /tool_calls/.test(tool.body) && /list_workspace_files/.test(tool.body);
      const finished = /data:\s*\[DONE\]/.test(tool.body);
      if (!tool.response.ok || !tool.response.headers.get('x-request-id') || !hasToolCall || !finished) {
        throw new Error(`Tool relay failed: ${tool.response.status}`);
      }
      result.tool = tool.response.status;
      result.probedToolModel = modelName;
    }

    if (runAgentProbe) {
      const probeState = createRunState({ stages: ['analysis', 'solving', 'paper', 'review'] });
      const agentPrompt = buildAgentPrompt({
        state: probeState,
        stage: 'solving',
        basePrompt: stagePrompt(process.cwd(), 'solving'),
      });
      const agent = await request(endpoints.gateway, '/v1/chat/completions', {
        method: 'POST',
        headers: { ...paidHeaders, Accept: 'text/event-stream' },
        body: JSON.stringify({
          model: modelName,
          stream: true,
          stream_options: { include_usage: true },
          messages: [
            { role: 'system', content: playbookPlaceholder({ stage: 'solving' }) },
            { role: 'user', content: agentPrompt },
          ],
          tools: WORKSPACE_TOOL_DEFINITIONS,
          tool_choice: 'auto',
          temperature: 0.2,
        }),
      });
      const finished = /data:\s*\[DONE\]/.test(agent.body);
      if (!agent.response.ok || !agent.response.headers.get('x-request-id') || !finished) {
        throw new Error(`Agent relay failed: ${agent.response.status}`);
      }
      result.agent = agent.response.status;
      result.probedAgentModel = modelName;
      result.agentToolCount = WORKSPACE_TOOL_DEFINITIONS.length;
    }

    if (runAgentLoopProbe) {
      let toolExecutions = 0;
      let upstreamDiagnostic = null;
      let loop;
      try {
        loop = await runDirectAgent({
          connection: { baseUrl: catalog.json.baseUrl, model: modelName, protocol: 'openai' },
          apiKey: token.json.accessToken,
          systemPrompt: playbookPlaceholder({ stage: 'solving' }),
          prompt: [
            'Call list_workspace_files exactly once with {"path":"inputs"}.',
            'After receiving the tool result, reply only OK and do not make another tool call.',
          ].join(' '),
          tools: WORKSPACE_TOOL_DEFINITIONS,
          executeTool: async ({ name, input }) => {
            toolExecutions += 1;
            if (name !== 'list_workspace_files' || input?.path !== 'inputs') {
              return { ok: false, error: 'UNEXPECTED_PROBE_TOOL' };
            }
            return { ok: true, path: 'inputs', entries: [] };
          },
          fetchImpl: async (url, options) => {
            const response = await net.fetch(url, options);
            if (!response.ok) {
              const preview = Buffer.from(await response.clone().arrayBuffer())
                .toString('utf8')
                .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
                .replace(/[\u0000-\u001f\u007f]/g, ' ')
                .slice(0, 800);
              upstreamDiagnostic = { status: response.status, preview };
            }
            return response;
          },
          extraHeaders: { 'X-Device-Id': deviceId, 'X-Stage': 'solving', 'X-Pipeline-Id': pipelineId },
          stream: true,
          maxTurns: 2,
          maxProviderAttempts: 1,
          timeoutMs,
        });
      } catch (error) {
        error.upstreamDiagnostic = upstreamDiagnostic;
        throw error;
      }
      if (toolExecutions !== 1 || loop.turns !== 2 || loop.stdout.trim().toUpperCase() !== 'OK') {
        throw new Error('Agent tool-loop relay did not complete the expected two turns');
      }
      result.agentLoop = 200;
      result.agentLoopTurns = loop.turns;
    }

    if (runImageProbe) {
      const image = await request(endpoints.gateway, '/v1/images/generations', {
        method: 'POST',
        headers: paidHeaders,
        body: JSON.stringify({
          model: catalog.json.tiers[0].models.image,
          n: 1,
          size: '1024x1024',
          response_format: 'b64_json',
          prompt: '用于网关连通性验证的极简科学线稿：一个坐标轴和一个数据点；无文字、标题、图注或水印。',
        }),
      });
      if (!image.response.ok || !(image.json?.data?.[0]?.b64_json || image.json?.data?.[0]?.url)) {
        throw new Error(`Image relay failed: ${image.response.status}`);
      }
      result.image = image.response.status;
    }

    process.stdout.write(`${JSON.stringify(result)}\n`);
    app.exit(0);
  } catch (error) {
    const diagnostic = {
      code: String(error?.code || ''),
      status: Number(error?.status) || 0,
      requestIds: Array.isArray(error?.requestIds) ? error.requestIds : [],
      upstream: error?.upstreamDiagnostic || null,
    };
    process.stderr.write(`Hosted gateway verification failed: ${String(error?.message || error)} ${JSON.stringify(diagnostic)}\n`);
    app.exit(1);
  }
}).catch((error) => {
  process.stderr.write(`Hosted gateway initialization failed: ${String(error?.message || error)}\n`);
  app.exit(1);
});
