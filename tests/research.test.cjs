const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  MAX_RESPONSE_BYTES,
  RESEARCH_TOOL_NAME,
  assertSafeResearchQuery,
  assertAllowedResearchUrl,
  buildOpenAlexUrl,
  cacheFileFor,
  normalizeCrossrefRecord,
  normalizeOpenAlexRecord,
  normalizeResearchInput,
  searchScholarlySources,
} = require('../electron/supervisor/research.cjs');
const { workspaceToolsForExecution } = require('../electron/workspace-tool-policy.cjs');

function jsonResponse(payload, status = 200) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => name.toLowerCase() === 'content-length' ? String(body.length) : null },
    arrayBuffer: async () => body,
  };
}

function namesFor(stage, readOnly = false, researchEnabled = false) {
  return workspaceToolsForExecution(readOnly, stage, researchEnabled).map((tool) => tool.name);
}

test('research is stage-scoped to analysis, writing/paper, and review', () => {
  assert.equal(namesFor('analysis', false, true).includes(RESEARCH_TOOL_NAME), true);
  assert.equal(namesFor('paper', false, true).includes(RESEARCH_TOOL_NAME), true);
  assert.equal(namesFor('writing', false, true).includes(RESEARCH_TOOL_NAME), true);
  assert.equal(namesFor('review', true, true).includes(RESEARCH_TOOL_NAME), true);
  assert.equal(namesFor('solving', false, true).includes(RESEARCH_TOOL_NAME), false);
  assert.equal(namesFor('supervisor', false, true).includes(RESEARCH_TOOL_NAME), false);
  assert.equal(namesFor('', false, true).includes(RESEARCH_TOOL_NAME), false);
});

test('research input accepts only query and bounded result count', () => {
  assert.deepEqual(normalizeResearchInput({ query: 'causal inference' }), { query: 'causal inference', resultCount: 5 });
  assert.deepEqual(normalizeResearchInput({ query: 'causal inference', result_count: 2 }), { query: 'causal inference', resultCount: 2 });
  for (const input of [
    {},
    { query: 'x', path: 'inputs/private.txt' },
    { query: 'x', prompt: 'private instructions' },
    { query: 'x', result_count: 0 },
    { query: 'x', result_count: 9 },
    { query: 'x', result_count: '2' },
    { query: '\u0000' },
  ]) assert.throws(() => normalizeResearchInput(input), (error) => error.code === 'RESEARCH_INPUT_INVALID');
});

test('research query egress policy allows bibliographic terms and rejects sensitive data', () => {
  for (const query of [
    'causal inference panel data',
    'doi:10.1038/s41586-024-00001-1',
    '张三 多目标优化 鲁棒性',
  ]) assert.equal(assertSafeResearchQuery(query), query);

  for (const query of [
    'C:\\Users\\alice\\project\\inputs\\private.csv',
    'work/01_analysis/analysis.md',
    'api_key=sk-example-credential-value',
    'contact researcher@example.com about private results',
    `token=${'a'.repeat(64)}`,
    Array.from({ length: 33 }, (_, index) => `term${index}`).join(' '),
  ]) assert.throws(() => normalizeResearchInput({ query }), (error) => error.code === 'RESEARCH_QUERY_SENSITIVE');
});

test('research only permits official HTTPS hosts', () => {
  assert.equal(assertAllowedResearchUrl(buildOpenAlexUrl('test', 1)).hostname, 'api.openalex.org');
  assert.throws(() => assertAllowedResearchUrl('http://api.openalex.org/works'), (error) => error.code === 'RESEARCH_HOST_NOT_ALLOWED');
  assert.throws(() => assertAllowedResearchUrl('https://evil.example/works'), (error) => error.code === 'RESEARCH_HOST_NOT_ALLOWED');
});

test('research normalizes OpenAlex and Crossref citation metadata', () => {
  assert.deepEqual(normalizeOpenAlexRecord({
    doi: 'https://doi.org/10.1234/ABC',
    display_name: '  A bounded title  ',
    publication_year: 2024,
    authorships: [{ author: { display_name: 'Ada Lovelace' } }],
    primary_location: { source: { display_name: 'Journal of Tests' } },
    cited_by_count: 12,
    biblio: { volume: '7', issue: '2', first_page: '45', last_page: '52' },
    abstract_inverted_index: { bounded: [1], 'A': [0], title: [2] },
  }), {
    doi: '10.1234/ABC', title: 'A bounded title', year: 2024,
    authors: ['Ada Lovelace'], source: 'Journal of Tests', abstract: 'A bounded title',
    cited_by_count: 12, citations_count: 12, publication_year: 2024,
    citation_info: { volume: '7', issue: '2', first_page: '45', last_page: '52' },
    volume: '7', issue: '2', first_page: '45', last_page: '52',
    citation_format: 'Ada Lovelace (2024). A bounded title. Journal of Tests, 7(2), 45-52. DOI: 10.1234/ABC',
  });
  assert.deepEqual(normalizeCrossrefRecord({
    DOI: 'doi:10.5678/test', title: ['Crossref title'], published: { 'date-parts': [[2021]] },
    author: [{ given: 'Grace', family: 'Hopper' }], 'container-title': ['Test Letters'],
  }), {
    doi: '10.5678/test', title: 'Crossref title', year: 2021,
    authors: ['Grace Hopper'], source: 'Test Letters',
  });
});

test('research tolerates malformed OpenAlex metadata without leaking undefined values', () => {
  const normalized = normalizeOpenAlexRecord({
    title: 'Fallback title',
    abstract_inverted_index: {
      fallback: ['bad-position', -1, 10001],
      works: [1],
      0: ['not-a-word-entry'],
    },
    cited_by_count: 'not-a-count',
    biblio: { volume: 3, issue: '', first_page: 10, last_page: null },
    authorships: [{ author: null }, null, { author: { display_name: 'Author' } }],
  });
  assert.equal(normalized.abstract, 'works');
  assert.equal(normalized.cited_by_count, null);
  assert.equal(normalized.citations_count, null);
  assert.deepEqual(normalized.citation_info, { volume: '3', issue: null, first_page: '10', last_page: null });
  assert.equal(normalized.volume, '3');
  assert.equal(normalized.issue, null);
  assert.equal(normalized.first_page, '10');
  assert.equal(normalized.last_page, null);
  assert.match(normalized.citation_format, /^Author\. Fallback title\./);
  assert.equal(normalized.citation_format.includes('undefined'), false);
});

test('research request contains no project paths or prompts and caches a bounded result', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mmw-research-'));
  const requests = [];
  const payload = {
    results: [{
      doi: 'https://doi.org/10.1000/test', display_name: 'A result', publication_year: 2020,
      authorships: [{ author: { display_name: 'Researcher' } }],
      primary_location: { source: { display_name: 'Source' } },
    }],
  };
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return jsonResponse(payload);
  };
  const first = await searchScholarlySources({
    root, stage: 'analysis', input: { query: 'causal inference sentinel', result_count: 1 }, fetchImpl, now: () => '2026-08-04T00:00:00.000Z',
  });
  const second = await searchScholarlySources({ root, stage: 'analysis', input: { query: 'causal inference sentinel', result_count: 1 }, fetchImpl });
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /^https:\/\/api\.openalex\.org\//);
  assert.match(requests[0].url, /search=causal\+inference\+sentinel/);
  assert.equal(requests[0].options.method, 'GET');
  assert.equal(requests[0].options.body, undefined);
  assert.equal(JSON.stringify(requests[0].options).includes(root), false);
  assert.equal(first.provenance.url.includes(root), false);
  assert.equal(first.cache.path.startsWith('work/'), true);
  assert.equal(second.cache.hit, true);
  assert.deepEqual(second.results, first.results);
  assert.equal(fs.existsSync(cacheFileFor(root, 'causal inference sentinel', 1).absolute), true);
  await fsp.rm(root, { recursive: true, force: true });
});

test('research rejects oversized responses and timeouts', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mmw-research-limits-'));
  await assert.rejects(searchScholarlySources({
    root, stage: 'analysis', input: { query: 'large' },
    fetchImpl: async () => ({ ok: true, headers: { get: () => String(MAX_RESPONSE_BYTES + 1) } }),
  }), (error) => error.code === 'RESEARCH_RESPONSE_TOO_LARGE');
  await assert.rejects(searchScholarlySources({
    root, stage: 'analysis', input: { query: 'slow' }, timeoutMs: 5,
    fetchImpl: async (_url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => { const error = new Error('aborted'); error.name = 'AbortError'; reject(error); });
    }),
  }), (error) => error.code === 'RESEARCH_TIMEOUT');
  await fsp.rm(root, { recursive: true, force: true });
});

test('research cancels an active response reader when the bounded stream fails', async () => {
  let cancelled = 0;
  let released = 0;
  const reader = {
    reads: 0,
    async read() {
      this.reads += 1;
      if (this.reads === 1) return { done: false, value: Buffer.alloc(MAX_RESPONSE_BYTES) };
      return { done: false, value: Buffer.from('x') };
    },
    async cancel() { cancelled += 1; },
    releaseLock() { released += 1; },
  };

  await assert.rejects(searchScholarlySources({
    stage: 'analysis',
    input: { query: 'bounded stream' },
    fetchImpl: async () => ({
      ok: true,
      headers: { get: () => null },
      body: { getReader: () => reader },
      arrayBuffer: async () => { throw new Error('streaming must be preferred'); },
    }),
  }), (error) => error.code === 'RESEARCH_RESPONSE_TOO_LARGE');
  assert.equal(cancelled, 1);
  assert.equal(released, 1);
});
