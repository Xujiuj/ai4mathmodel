const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');

const RESEARCH_TOOL_NAME = 'search_scholarly_sources';
const RESEARCH_STAGES = Object.freeze(['analysis', 'paper', 'writing', 'review']);
const RESEARCH_HOSTS = Object.freeze(new Set(['api.openalex.org', 'api.crossref.org']));
const OPENALEX_URL = 'https://api.openalex.org/works';
const MAX_QUERY_CHARS = 240;
const MAX_QUERY_WORDS = 32;
const MAX_RESULTS = 8;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_RESULT_TITLE_CHARS = 500;
const MAX_RESULT_ABSTRACT_CHARS = 8_000;
const MAX_ABSTRACT_POSITION = 10_000;
const MAX_RESULT_AUTHORS = 8;
const MAX_AUTHOR_CHARS = 160;
const MAX_SOURCE_CHARS = 240;
const MAX_BIBLIO_FIELD_CHARS = 80;
const MAX_TIMEOUT_MS = 120_000;
const CACHE_VERSION = 2;

const SENSITIVE_QUERY_PATTERNS = Object.freeze([
  /(?:^|[\s"'`])(?:[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|mnt|etc|var|opt|private|tmp)\/)/i,
  /(?:^|[\s"'`])(?:inputs|work|\.metadata|\.staging|\.trash|src|electron|gateway)[\\/][^\s"'`]+/i,
  /(?:^|\s)(?:\.env|credentials\.json|settings\.json)(?:\s|$)/i,
  /\b(?:api[_ -]?key|password|passwd|secret|authorization|bearer|access[_ -]?token|refresh[_ -]?token)\s*[:=]\s*\S+/i,
  /\b(?:AKIA[0-9A-Z]{16}|(?:sk|rk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{16,})\b/,
  /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\b/,
  /\b[0-9a-f]{40,}\b/i,
  /\b[A-Za-z0-9+/]{48,}={0,2}\b/,
  /\b[^\s@]{1,64}@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,63}\b/,
]);

const RESEARCH_TOOL_DEFINITION = Object.freeze({
  name: RESEARCH_TOOL_NAME,
  description: 'Search official scholarly metadata APIs for citation candidates. Use only public titles, DOIs, authors, or short topic keywords; never include project text, paths, personal data, or credentials.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 1, maxLength: MAX_QUERY_CHARS },
      result_count: { type: 'integer', minimum: 1, maximum: MAX_RESULTS },
    },
    required: ['query'],
    additionalProperties: false,
  },
});

function researchError(code, status = 0) {
  const messages = {
    RESEARCH_STAGE_NOT_ALLOWED: 'Research is unavailable in this stage.',
    RESEARCH_INPUT_INVALID: 'Research query input is invalid.',
    RESEARCH_QUERY_SENSITIVE: 'Research query may contain private project data.',
    RESEARCH_HOST_NOT_ALLOWED: 'Research host is not allowed.',
    RESEARCH_RESPONSE_TOO_LARGE: 'Research response exceeded the size limit.',
    RESEARCH_TIMEOUT: 'Research request timed out.',
    RESEARCH_UPSTREAM_ERROR: 'Research provider returned an error.',
    RESEARCH_RESPONSE_INVALID: 'Research provider returned invalid metadata.',
    RESEARCH_NETWORK_ERROR: 'Research provider could not be reached.',
  };
  const error = new Error(messages[code] || 'Research request failed.');
  error.code = code;
  error.status = status;
  return error;
}

function cleanText(value, limit) {
  return String(value || '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
    .slice(0, limit);
}

function assertSafeResearchQuery(query) {
  const words = query.split(/\s+/u).filter(Boolean);
  if (words.length > MAX_QUERY_WORDS || SENSITIVE_QUERY_PATTERNS.some((pattern) => pattern.test(query))) {
    throw researchError('RESEARCH_QUERY_SENSITIVE');
  }
  return query;
}

function normalizeResearchInput(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw researchError('RESEARCH_INPUT_INVALID');
  const keys = Object.keys(input);
  if (keys.some((key) => !['query', 'result_count'].includes(key))) throw researchError('RESEARCH_INPUT_INVALID');
  const query = typeof input.query === 'string' ? input.query.trim() : '';
  const resultCount = input.result_count === undefined ? 5 : input.result_count;
  if (!query || query.length > MAX_QUERY_CHARS || /[\u0000-\u001f\u007f]/.test(query)) throw researchError('RESEARCH_INPUT_INVALID');
  if (typeof resultCount !== 'number' || !Number.isInteger(resultCount) || resultCount < 1 || resultCount > MAX_RESULTS) throw researchError('RESEARCH_INPUT_INVALID');
  return { query: assertSafeResearchQuery(query), resultCount };
}

function isAllowedResearchStage(stage) {
  return RESEARCH_STAGES.includes(String(stage || '').trim().toLowerCase());
}

function buildOpenAlexUrl(query, resultCount) {
  const url = new URL(OPENALEX_URL);
  url.searchParams.set('search', query);
  url.searchParams.set('per-page', String(resultCount));
  url.searchParams.set('select', 'id,doi,title,display_name,publication_year,authorships,primary_location,cited_by_count,biblio,abstract_inverted_index');
  return url.toString();
}

function assertAllowedResearchUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw researchError('RESEARCH_HOST_NOT_ALLOWED');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !RESEARCH_HOSTS.has(url.hostname.toLowerCase())) {
    throw researchError('RESEARCH_HOST_NOT_ALLOWED');
  }
  return url;
}

function normalizeDoi(value) {
  const doi = cleanText(value, 300).replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '');
  return doi || null;
}

function normalizeAuthors(authors) {
  if (!Array.isArray(authors)) return [];
  return authors
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      const author = entry?.author || entry;
      return author?.display_name || author?.name || [author?.given, author?.family].filter(Boolean).join(' ');
    })
    .map((name) => typeof name === 'string' ? cleanText(name, MAX_AUTHOR_CHARS) : '')
    .filter(Boolean)
    .slice(0, MAX_RESULT_AUTHORS);
}

function normalizeYear(value) {
  const year = Number(value);
  return Number.isInteger(year) && year >= 1000 && year <= 9999 ? year : null;
}

function normalizeCount(value) {
  if (!['number', 'string'].includes(typeof value) || (typeof value === 'string' && !value.trim())) return null;
  const count = Number(value);
  return Number.isInteger(count) && count >= 0 ? count : null;
}

function normalizeBiblioField(value) {
  if (value === null || value === undefined || value === '' || !['string', 'number'].includes(typeof value)) return null;
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  const field = cleanText(value, MAX_BIBLIO_FIELD_CHARS);
  return field || null;
}

function normalizeBiblio(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { volume: null, issue: null, first_page: null, last_page: null };
  }
  return {
    volume: normalizeBiblioField(value.volume),
    issue: normalizeBiblioField(value.issue),
    first_page: normalizeBiblioField(value.first_page),
    last_page: normalizeBiblioField(value.last_page),
  };
}

function reconstructOpenAlexAbstract(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const words = new Map();
  for (const [rawWord, rawPositions] of Object.entries(value)) {
    if (!Array.isArray(rawPositions)) continue;
    const word = cleanText(rawWord, MAX_AUTHOR_CHARS);
    if (!word) continue;
    for (const rawPosition of rawPositions) {
      if (!['number', 'string'].includes(typeof rawPosition) || (typeof rawPosition === 'string' && !rawPosition.trim())) continue;
      const position = Number(rawPosition);
      if (!Number.isInteger(position) || position < 0 || position > MAX_ABSTRACT_POSITION || words.has(position)) continue;
      words.set(position, word);
    }
  }
  return Array.from(words.entries())
    .sort(([left], [right]) => left - right)
    .map(([, word]) => word)
    .join(' ')
    .slice(0, MAX_RESULT_ABSTRACT_CHARS);
}

function formatOpenAlexCitation({ authors, year, title, source, biblio, doi }) {
  const authorNames = Array.isArray(authors) ? authors.filter(Boolean) : [];
  const authorText = authorNames.length > 3
    ? `${authorNames[0]} et al.`
    : authorNames.join(', ');
  const yearText = year === null || year === undefined ? '' : `(${year})`;
  const parts = [];
  const authorYear = [authorText, yearText].filter(Boolean).join(' ').trim();
  if (authorYear) parts.push(`${authorYear}.`);
  if (title) parts.push(`${title}.`);
  const publication = [];
  if (source) publication.push(source);
  const volumeIssue = biblio?.volume
    ? `${biblio.volume}${biblio.issue ? `(${biblio.issue})` : ''}`
    : (biblio?.issue ? `(${biblio.issue})` : '');
  if (volumeIssue) publication.push(volumeIssue);
  const pages = biblio?.first_page && biblio?.last_page
    ? `${biblio.first_page}-${biblio.last_page}`
    : (biblio?.first_page || biblio?.last_page || '');
  if (pages) publication.push(pages);
  if (publication.length) parts.push(`${publication.join(', ')}.`);
  if (doi) parts.push(`DOI: ${doi}`);
  return parts.join(' ').trim();
}

function normalizeOpenAlexRecord(record = {}) {
  const safeRecord = record && typeof record === 'object' && !Array.isArray(record) ? record : {};
  const source = safeRecord.primary_location?.source?.display_name
    || safeRecord.host_venue?.display_name
    || safeRecord.host_venue?.name
    || '';
  const doi = normalizeDoi(safeRecord.doi);
  const title = cleanText(safeRecord.display_name || safeRecord.title, MAX_RESULT_TITLE_CHARS) || null;
  const year = normalizeYear(safeRecord.publication_year);
  const authors = normalizeAuthors(safeRecord.authorships);
  const biblio = normalizeBiblio(safeRecord.biblio);
  return {
    doi,
    title,
    year,
    authors,
    source: cleanText(source, MAX_SOURCE_CHARS) || null,
    abstract: reconstructOpenAlexAbstract(safeRecord.abstract_inverted_index),
    cited_by_count: normalizeCount(safeRecord.cited_by_count),
    citations_count: normalizeCount(safeRecord.cited_by_count),
    publication_year: year,
    citation_info: biblio,
    volume: biblio.volume,
    issue: biblio.issue,
    first_page: biblio.first_page,
    last_page: biblio.last_page,
    citation_format: formatOpenAlexCitation({
      authors, year, title, source: cleanText(source, MAX_SOURCE_CHARS) || null, biblio, doi,
    }),
  };
}

function normalizeCrossrefRecord(record = {}) {
  const date = record.published?.['date-parts']?.[0]
    || record['published-print']?.['date-parts']?.[0]
    || record['published-online']?.['date-parts']?.[0];
  return {
    doi: normalizeDoi(record.DOI),
    title: cleanText(Array.isArray(record.title) ? record.title[0] : record.title, MAX_RESULT_TITLE_CHARS) || null,
    year: normalizeYear(Array.isArray(date) ? date[0] : null),
    authors: normalizeAuthors(record.author),
    source: cleanText(Array.isArray(record['container-title']) ? record['container-title'][0] : record['container-title'], MAX_SOURCE_CHARS) || null,
  };
}

function normalizeResults(payload, provider = 'openalex', resultCount = MAX_RESULTS) {
  const records = Array.isArray(payload?.results)
    ? payload.results
    : Array.isArray(payload?.message?.items) ? payload.message.items : [];
  const normalize = provider === 'crossref' ? normalizeCrossrefRecord : normalizeOpenAlexRecord;
  return records
    .map(normalize)
    .filter((record) => record.title || record.doi)
    .slice(0, resultCount);
}

async function responseBytes(response) {
  const declared = Number(response?.headers?.get?.('content-length') || 0);
  if (declared > MAX_RESPONSE_BYTES) throw researchError('RESEARCH_RESPONSE_TOO_LARGE');
  const reader = response?.body?.getReader?.();
  if (reader) {
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const step = await reader.read();
        if (step.done) break;
        const chunk = Buffer.from(step.value || []);
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) throw researchError('RESEARCH_RESPONSE_TOO_LARGE');
        chunks.push(chunk);
      }
      return Buffer.concat(chunks, size);
    } catch (error) {
      try { await reader.cancel?.(); } catch {}
      throw error;
    } finally {
      try { reader.releaseLock?.(); } catch {}
    }
  }
  if (typeof response?.arrayBuffer !== 'function') throw researchError('RESEARCH_RESPONSE_INVALID');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_RESPONSE_BYTES) throw researchError('RESEARCH_RESPONSE_TOO_LARGE');
  return bytes;
}

async function fetchResearchPayload(url, { fetchImpl = globalThis.fetch, timeoutMs = 15_000, signal } = {}) {
  const endpoint = assertAllowedResearchUrl(url);
  if (typeof fetchImpl !== 'function') throw researchError('RESEARCH_NETWORK_ERROR');
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener?.('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(Number(timeoutMs) || 15_000, MAX_TIMEOUT_MS)));
  try {
    const response = await fetchImpl(endpoint.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': 'ModelingWorkbenchResearch/1.0' },
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response?.ok) throw researchError('RESEARCH_UPSTREAM_ERROR', Number(response?.status) || 0);
    let payload;
    try {
      payload = JSON.parse((await responseBytes(response)).toString('utf8'));
    } catch (error) {
      if (error?.code) throw error;
      throw researchError('RESEARCH_RESPONSE_INVALID');
    }
    if (!payload || typeof payload !== 'object') throw researchError('RESEARCH_RESPONSE_INVALID');
    return payload;
  } catch (error) {
    if (error?.code?.startsWith?.('RESEARCH_')) throw error;
    if (controller.signal.aborted || error?.name === 'AbortError') throw researchError('RESEARCH_TIMEOUT');
    throw researchError('RESEARCH_NETWORK_ERROR');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
}

function cacheFileFor(root, query, resultCount) {
  const key = crypto.createHash('sha256')
    .update(JSON.stringify({ version: CACHE_VERSION, provider: 'openalex', query, resultCount }))
    .digest('hex');
  return {
    absolute: path.join(root, 'work', '.metadata', 'research-cache', `${key}.json`),
    relative: `work/.metadata/research-cache/${key}.json`,
  };
}

async function readCache(file) {
  try {
    const value = JSON.parse(await fsp.readFile(file, 'utf8'));
    return value && Array.isArray(value.results) && typeof value.provenance?.fetchedAt === 'string' ? value : null;
  } catch {
    return null;
  }
}

async function writeCache(file, value) {
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(temporary, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
    await fsp.rename(temporary, file);
    return true;
  } catch {
    return false;
  }
}

async function searchScholarlySources({ root, stage, input, fetchImpl = globalThis.fetch, signal, timeoutMs, now = () => new Date().toISOString() } = {}) {
  if (!isAllowedResearchStage(stage)) throw researchError('RESEARCH_STAGE_NOT_ALLOWED');
  const { query, resultCount } = normalizeResearchInput(input);
  const cache = typeof root === 'string' && root ? cacheFileFor(root, query, resultCount) : null;
  if (cache) {
    const cached = await readCache(cache.absolute);
    if (cached) return { ok: true, query, results: cached.results, provenance: cached.provenance, cache: { hit: true, path: cache.relative } };
  }

  const url = buildOpenAlexUrl(query, resultCount);
  const payload = await fetchResearchPayload(url, { fetchImpl, signal, timeoutMs });
  const results = normalizeResults(payload, 'openalex', resultCount);
  const fetchedAt = cleanText(now(), 64) || new Date().toISOString();
  const value = {
    ok: true,
    query,
    results,
    provenance: { source: 'OpenAlex', url, fetchedAt },
  };
  if (cache) {
    await writeCache(cache.absolute, value);
    return { ...value, cache: { hit: false, path: cache.relative } };
  }
  return { ...value, cache: { hit: false } };
}

module.exports = {
  MAX_QUERY_CHARS,
  MAX_QUERY_WORDS,
  MAX_RESULTS,
  MAX_RESULT_ABSTRACT_CHARS,
  MAX_RESPONSE_BYTES,
  RESEARCH_HOSTS,
  RESEARCH_STAGES,
  RESEARCH_TOOL_DEFINITION,
  RESEARCH_TOOL_NAME,
  assertSafeResearchQuery,
  assertAllowedResearchUrl,
  buildOpenAlexUrl,
  cacheFileFor,
  fetchResearchPayload,
  isAllowedResearchStage,
  normalizeCrossrefRecord,
  normalizeBiblio,
  normalizeCount,
  normalizeOpenAlexRecord,
  normalizeResearchInput,
  normalizeResults,
  reconstructOpenAlexAbstract,
  formatOpenAlexCitation,
  researchError,
  searchScholarlySources,
};
