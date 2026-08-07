const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const YAML = require('yaml');

const {
  isSafeArtifactPath,
  isValidDoi,
  validateAggregateContract,
  validateEvidenceManifest,
  validateResultsContracts,
  validateSubproblemInputs,
  validateSubproblemsContract,
} = require('./artifact-contracts.cjs');
const { defaultLatexTemplate } = require('../default-templates.cjs');

const MIN_ANALYSIS_CHARACTERS = 3_500;
const MIN_PAPER_CHARACTERS = 8_000;
const MIN_ABSTRACT_CHARACTERS = 400;
const MAX_ABSTRACT_CHARACTERS = 1_800;

function meaningfulCharacterCount(value) {
  return String(value || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/%.*$/gm, ' ')
    .replace(/\\(?:begin|end)\s*\{[^}]+\}/g, ' ')
    .replace(/\\[a-zA-Z@]+\*?(?:\[[^\]]*\])?/g, ' ')
    .match(/[\p{L}\p{N}]/gu)?.length || 0;
}

function markdownHeadings(value) {
  return [...String(value || '').matchAll(/^#{1,4}\s+(.+)$/gm)].map((match) => match[1].trim());
}

function latexSectionTitles(value) {
  return [...String(value || '').matchAll(/\\(?:sub)*section\*?\s*\{([^}]+)\}/gi)].map((match) => match[1].trim());
}

function conceptCoverage(value, groups) {
  return groups.filter((patterns) => patterns.some((pattern) => pattern.test(value))).length;
}

function containsNumericEvidence(value) {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return /(?:^|[^\p{L}])[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?%?(?:$|[^\p{L}])/u.test(value);
  if (Array.isArray(value)) return value.some(containsNumericEvidence);
  if (value && typeof value === 'object') return Object.values(value).some(containsNumericEvidence);
  return false;
}

async function readUtf8(file) {
  return file ? fsp.readFile(file.path, 'utf8').catch(() => '') : '';
}

async function projectArtifactExists(view, relative) {
  try {
    const target = view.resolvePath(relative);
    if (!insideRoot(view.root, target)) return false;
    const stat = await fsp.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    const [rootReal, targetReal] = await Promise.all([
      fsp.realpath(view.root),
      fsp.realpath(target),
    ]);
    return insideRoot(rootReal, targetReal);
  } catch {
    return false;
  }
}

async function readStructuredProjectArtifact(view, relative) {
  if (!/\.(?:ya?ml|json)$/i.test(relative) || !await projectArtifactExists(view, relative)) return null;
  try {
    const target = view.resolvePath(relative);
    const stat = await fsp.stat(target);
    if (stat.size > 5 * 1024 * 1024) return null;
    const source = await fsp.readFile(target, 'utf8');
    return /\.json$/i.test(relative) ? JSON.parse(source) : YAML.parse(source);
  } catch {
    return null;
  }
}

function contractFailure(validation, artifactRefs) {
  return {
    ok: false,
    code: validation.code,
    reason: validation.reason,
    artifactRefs,
  };
}

function extractAbstract(value) {
  const source = String(value || '');
  const environment = source.match(/\\begin\s*\{(?:abstract|cnabstract|zhabstract|abstractzh)\}\s*([\s\S]*?)\\end\s*\{(?:abstract|cnabstract|zhabstract|abstractzh)\}/i);
  if (environment) return environment[1];
  const heading = source.match(/\\(?:section|chapter)\*?\s*\{摘要\}\s*([\s\S]*?)(?=\\(?:section|chapter)\*?\s*\{|$)/);
  return heading?.[1] || '';
}

function insideRoot(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function validateReferencedFigures(root, entryDirectory, texSource, pdf) {
  const references = [...String(texSource || '').matchAll(/\\includegraphics(?:\s*\[[^\]]*\])?\s*\{([^}]+)\}/gi)]
    .map((match) => match[1].trim())
    .filter((value) => value && !value.includes('\\'));
  if (!references.length) return { ok: true, files: [] };
  const graphicPaths = [...String(texSource || '').matchAll(/\\graphicspath\s*\{((?:\s*\{[^}]+\}\s*)+)\}/gi)]
    .flatMap((match) => [...match[1].matchAll(/\{([^}]+)\}/g)].map((item) => item[1].trim()))
    .filter(Boolean);
  const extensions = ['.pdf', '.png', '.jpg', '.jpeg', '.webp'];
  const files = [];
  const rootReal = await fsp.realpath(root).catch(() => path.resolve(root));
  for (const reference of [...new Set(references)]) {
    const normalized = reference.replaceAll('\\', path.sep).replaceAll('/', path.sep);
    const bases = ['', ...graphicPaths].map((base) => path.resolve(entryDirectory, base.replaceAll('\\', path.sep).replaceAll('/', path.sep), normalized));
    const candidates = bases.flatMap((candidate) => path.extname(candidate) ? [candidate] : extensions.map((extension) => `${candidate}${extension}`));
    let target;
    let targetStat;
    let unsafeCandidate = false;
    for (const candidate of candidates) {
      if (!insideRoot(root, candidate) || !fs.existsSync(candidate)) continue;
      try {
        const [stat, candidateReal] = await Promise.all([
          fsp.lstat(candidate),
          fsp.realpath(candidate),
        ]);
        if (stat.isSymbolicLink() || !insideRoot(rootReal, candidateReal)) {
          unsafeCandidate = true;
          continue;
        }
        if (!stat.isFile()) continue;
        target = candidate;
        targetStat = stat;
        break;
      } catch {
        // Treat a concurrently removed candidate as missing.
      }
    }
    if (!target) {
      return unsafeCandidate
        ? { ok: false, code: 'FIGURE_REFERENCE_UNSAFE', reason: `论文引用的图片越出项目边界：${reference}`, files }
        : { ok: false, code: 'FIGURE_REFERENCE_MISSING', reason: `论文引用的图片不存在：${reference}`, files };
    }
    const stat = targetStat;
    const file = { path: target, relative: toPublicRelative(root, target), modifiedAt: stat.mtimeMs };
    files.push(file);
    if (pdf?.modifiedAt && stat.mtimeMs > pdf.modifiedAt + 10) {
      return { ok: false, code: 'PDF_STALE', reason: '论文图片晚于最终 PDF，必须重新编译并核对版面。', files };
    }
  }
  return { ok: true, files };
}

function asProjectView(rootOrView) {
  if (rootOrView && typeof rootOrView === 'object' && typeof rootOrView.root === 'string') {
    return {
      root: rootOrView.root,
      resolvePath: typeof rootOrView.resolvePath === 'function'
        ? rootOrView.resolvePath
        : (relative) => path.join(rootOrView.root, relative),
    };
  }
  return {
    root: rootOrView,
    resolvePath: (relative) => path.join(rootOrView, relative),
  };
}

function toRelative(root, target) {
  return path.relative(root, target).replaceAll('\\', '/');
}

function toPublicRelative(root, target) {
  return toRelative(root, target).replace(/^work\/\.staging\/[^/]+\//, 'work/');
}

async function listFiles(rootOrView, relative, result = []) {
  const view = asProjectView(rootOrView);
  const directory = view.resolvePath(relative);
  if (!fs.existsSync(directory)) return result;
  for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || ['node_modules', '__pycache__'].includes(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await listFiles(view, toPublicRelative(view.root, target), result);
    if (entry.isFile()) {
      const stat = await fsp.stat(target);
      result.push({
        path: target,
        relative: toPublicRelative(view.root, target),
        name: entry.name,
        ext: path.extname(entry.name).toLowerCase(),
        size: stat.size,
        modifiedAt: stat.mtimeMs,
      });
    }
  }
  return result;
}

async function copyRegularDirectory(source, destination) {
  let copiedFiles = 0;
  await fsp.mkdir(destination, { recursive: true });
  for (const entry of await fsp.readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) copiedFiles += await copyRegularDirectory(from, to);
    if (entry.isFile()) {
      await fsp.mkdir(path.dirname(to), { recursive: true });
      await fsp.copyFile(from, to, fs.constants.COPYFILE_EXCL);
      copiedFiles += 1;
    }
  }
  return copiedFiles;
}

async function containsRegularFile(directory) {
  if (!fs.existsSync(directory)) return false;
  for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
    if (entry.isFile()) return true;
    if (entry.isDirectory() && await containsRegularFile(path.join(directory, entry.name))) return true;
  }
  return false;
}

async function ensureWorkspaceInitialized(root, options = {}) {
  const templateFiles = await listFiles(root, path.join('inputs', 'template'));
  const problemFiles = await listFiles(root, path.join('inputs', 'problem'));
  if (!problemFiles.length) {
    return { ok: false, reason: '赛题文件和论文模板必须同时存在。', code: 'MISSING_INPUTS' };
  }
  let generatedTemplate = false;
  if (!templateFiles.length) {
    const templateDirectory = path.join(root, 'inputs', 'template');
    await fsp.mkdir(templateDirectory, { recursive: true });
    await fsp.writeFile(path.join(templateDirectory, 'main.tex'), defaultLatexTemplate(options.competition), { encoding: 'utf8', flag: 'wx' });
    generatedTemplate = true;
  }
  const availableTemplateFiles = generatedTemplate
    ? await listFiles(root, path.join('inputs', 'template'))
    : templateFiles;
  const texFiles = availableTemplateFiles.filter((file) => file.ext === '.tex');
  const preferredNames = ['main.tex', 'paper.tex', 'mcm.tex', 'cumcm.tex', 'example.tex'];
  let template = preferredNames.map((name) => texFiles.find((file) => file.name.toLowerCase() === name)).find(Boolean);
  if (!template) {
    for (const candidate of texFiles) {
      const content = await fsp.readFile(candidate.path, 'utf8').catch(() => '');
      if (/\\documentclass/.test(content)) {
        template = candidate;
        break;
      }
    }
  }
  template ||= texFiles[0];
  if (!template) return { ok: false, reason: '模板目录中没有可用的 TeX 入口文件。', code: 'MISSING_TEMPLATE_ENTRY' };

  const problemPriority = ['.pdf', '.md', '.txt', '.docx'];
  const statement = problemPriority.map((ext) => problemFiles.find((file) => file.ext === ext)).find(Boolean) || problemFiles[0];
  const templateSource = await fsp.readFile(template.path, 'utf8').catch(() => '');
  const languageEvidence = `${statement.name}\n${templateSource.slice(0, 8000)}`;
  const language = /[\u3400-\u9fff]|ctex|xeCJK/i.test(languageEvidence) ? 'zh' : 'en';
  for (const directory of ['work/01_analysis', 'work/02_solving', 'work/03_paper', 'work/04_review']) {
    await fsp.mkdir(path.join(root, directory), { recursive: true });
  }
  const paperDirectory = path.join(root, 'work', '03_paper');
  const copiedTemplateFiles = await containsRegularFile(paperDirectory)
    ? 0
    : await copyRegularDirectory(path.join(root, 'inputs', 'template'), paperDirectory);
  return {
    ok: true,
    language,
    template: template.relative,
    statement: statement.relative,
    dataFiles: Math.max(0, problemFiles.length - 1),
    copiedTemplateFiles,
    generatedTemplate,
  };
}

async function evaluateStageGate(root, stage, options = {}) {
  const dependency = { analysis: 'init', solving: 'analysis', paper: 'solving', review: 'paper' }[stage];
  if (!dependency) return { ok: false, reason: `未知阶段：${stage}` };
  if (dependency === 'init') return { ok: true, dependency };
  const validation = await validateStageArtifacts(root, dependency, options);
  if (!validation.ok) return { ok: false, reason: `上一步成果尚未通过验证：${validation.reason}`, dependency };
  return { ok: true, dependency };
}

async function confirmStage(root, stage, { now = Date.now() } = {}) {
  return { stage, status: 'complete', completedAt: new Date(now).toISOString(), root: path.basename(root) };
}

async function validPdf(file) {
  if (!file || file.size < 1024) return false;
  const handle = await fsp.open(file.path, 'r');
  try {
    const buffer = Buffer.alloc(5);
    await handle.read(buffer, 0, 5, 0);
    return buffer.toString('ascii') === '%PDF-';
  } finally {
    await handle.close();
  }
}

function findArtifact(files, suffix) {
  const normalized = String(suffix).replace(/\\/g, '/').toLowerCase();
  return files.find((file) => String(file.relative || '').replace(/\\/g, '/').toLowerCase() === normalized);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasScalar(value, key) {
  const candidate = value?.[key];
  return (typeof candidate === 'string' && candidate.trim().length > 0)
    || (typeof candidate === 'number' && Number.isFinite(candidate));
}

function hasCollection(value, key, { allowEmpty = false } = {}) {
  const candidate = value?.[key];
  if (Array.isArray(candidate)) return allowEmpty || candidate.length > 0;
  return isRecord(candidate) && (allowEmpty || Object.keys(candidate).length > 0);
}

function validRecords(value, key, predicate, { allowEmpty = false } = {}) {
  const records = value?.[key];
  return Array.isArray(records) && (allowEmpty || records.length > 0) && records.every((record) => isRecord(record) && predicate(record));
}

const STRUCTURED_ARTIFACT_VALIDATORS = Object.freeze({
  'work/01_analysis/data_profile.yaml': (value) => hasScalar(value, 'schema_version')
    && validRecords(value, 'datasets', (record) => hasScalar(record, 'path')
      && (hasScalar(record, 'status') || hasCollection(record, 'fields') || hasCollection(record, 'shape'))),
  'work/01_analysis/model_contract.yaml': (value) => hasScalar(value, 'schema_version')
    && validRecords(value, 'models', (record) => hasScalar(record, 'subproblem_id')
      && (hasScalar(record, 'method') || hasScalar(record, 'selected_method'))
      && hasScalar(record, 'claim_type')
      && hasScalar(record, 'estimand_or_objective')
      && Array.isArray(record.candidate_families)
      && record.candidate_families.length >= 2
      && hasScalar(record, 'baseline')
      && hasCollection(record, 'assumptions')
      && hasCollection(record, 'validation_tests')
      && hasCollection(record, 'failure_modes')
      && hasScalar(record, 'fallback')),
  'work/01_analysis/validation_plan.yaml': (value) => hasScalar(value, 'schema_version')
    && validRecords(value, 'checks', (record) => hasScalar(record, 'subproblem_id')
      && (hasScalar(record, 'method') || hasScalar(record, 'type') || hasScalar(record, 'check'))),
  'work/01_analysis/figure_plan.yaml': (value) => hasScalar(value, 'schema_version')
    && validRecords(value, 'figures', (record) => (hasScalar(record, 'id') || hasScalar(record, 'figure_id')) && hasScalar(record, 'claim')),
  'work/01_analysis/literature/evidence_map.yaml': (value) => hasScalar(value, 'schema_version')
    && validRecords(value, 'evidence', (record) => hasScalar(record, 'id')
      && (hasScalar(record, 'claim') || hasScalar(record, 'claim_supported'))
      && String(record.status || '').toLowerCase() === 'verified'
      && hasScalar(record, 'role')
      && isRecord(record.metadata)
      && hasScalar(record.metadata, 'title')
      && hasScalar(record.metadata, 'year')
      && isValidDoi(record.metadata.doi)
      && isRecord(record.verification)
      && hasScalar(record.verification, 'service')
      && Array.isArray(record.verification.checked_fields)
      && ['title', 'year', 'doi'].every((field) => record.verification.checked_fields.includes(field))),
  'work/02_solving/environment.yaml': (value) => hasScalar(value, 'schema_version')
    && hasCollection(value, 'runtime')
    && hasCollection(value, 'dependencies', { allowEmpty: true }),
  'work/02_solving/validation_report.yaml': (value) => hasScalar(value, 'schema_version')
    && validRecords(value, 'checks', (record) => hasScalar(record, 'id')
      && hasScalar(record, 'subproblem_id')
      && hasScalar(record, 'status')
      && hasCollection(record, 'evidence_paths')),
  'work/02_solving/figures/figure_manifest.yaml': (value) => hasScalar(value, 'schema_version')
    && validRecords(value, 'figures', (record) => hasScalar(record, 'figure_id')
      && hasScalar(record, 'subproblem_id')
      && hasScalar(record, 'claim')
      && hasCollection(record, 'source_data')
      && hasCollection(record, 'data_locators')
      && hasScalar(record, 'generation_source')
      && hasScalar(record, 'archetype')
      && hasScalar(record, 'final_width')
      && hasCollection(record, 'exports')
      && String(record.qa_status || '').toLowerCase() === 'passed'),
  'work/03_paper/prose_polish_report.yaml': (value) => hasScalar(value, 'schema_version')
    && hasScalar(value, 'decision')
    && validRecords(value, 'findings', (record) => hasScalar(record, 'location')
      && hasScalar(record, 'severity')
      && hasScalar(record, 'recommendation'), { allowEmpty: true })
    && hasCollection(value, 'overclaims', { allowEmpty: true })
    && hasCollection(value, 'unresolved_terminology', { allowEmpty: true }),
  'work/04_review/release_manifest.yaml': (value) => hasScalar(value, 'schema_version')
    && String(value.decision || '').toUpperCase() === 'PASS'
    && validRecords(value, 'files', (record) => hasScalar(record, 'path')
      && typeof record.sha256 === 'string'
      && /^[a-f0-9]{64}$/i.test(record.sha256)),
});

function validateStructuredArtifactSchema(suffix, value) {
  const normalized = String(suffix).replace(/\\/g, '/').toLowerCase();
  const validate = STRUCTURED_ARTIFACT_VALIDATORS[normalized];
  return !validate || validate(value);
}

async function validateFigureManifestArtifacts(manifest, analysisContract, artifactExists) {
  const subproblemIds = new Set(Array.isArray(analysisContract?.subproblems)
    ? analysisContract.subproblems.map((subproblem) => subproblem.id)
    : []);
  for (const figure of manifest?.figures || []) {
    if (!subproblemIds.has(figure.subproblem_id)) {
      return { ok: false, code: 'FIGURE_SUBPROBLEM_UNKNOWN', reason: `Figure ${figure.figure_id} references an unknown subproblem.` };
    }
    const paths = [...figure.source_data, figure.generation_source, ...figure.exports];
    for (const artifact of paths) {
      if (!isSafeArtifactPath(artifact)) {
        return { ok: false, code: 'FIGURE_ARTIFACT_UNSAFE', reason: `Figure ${figure.figure_id} contains an unsafe artifact path.` };
      }
      if (!await artifactExists(artifact)) {
        return { ok: false, code: 'FIGURE_ARTIFACT_MISSING', reason: `Figure ${figure.figure_id} references missing artifact ${artifact}.` };
      }
    }
  }
  return { ok: true };
}

async function requireStructuredArtifact(files, suffix, code, label) {
  const file = findArtifact(files, suffix);
  if (!file) return { ok: false, code, reason: `Missing required ${label}: ${suffix}.`, artifactRefs: [] };
  let value;
  try {
    value = YAML.parse(await readUtf8(file));
  } catch {
    return { ok: false, code: `${code}_INVALID`, reason: `${label} is not valid YAML: ${suffix}.`, artifactRefs: [file.relative] };
  }
  if (!value || typeof value !== 'object' || !Object.keys(value).length) {
    return { ok: false, code: `${code}_EMPTY`, reason: `${label} is empty: ${suffix}.`, artifactRefs: [file.relative] };
  }
  if (!validateStructuredArtifactSchema(suffix, value)) {
    return { ok: false, code: `${code}_SCHEMA_INVALID`, reason: `${label} does not satisfy its required schema: ${suffix}.`, artifactRefs: [file.relative] };
  }
  return { ok: true, file, value };
}

async function requireTextArtifact(files, suffix, code, label, minimumCharacters) {
  const file = findArtifact(files, suffix);
  if (!file) return { ok: false, code, reason: `Missing required ${label}: ${suffix}.`, artifactRefs: [] };
  if (meaningfulCharacterCount(await readUtf8(file)) < minimumCharacters) {
    return { ok: false, code: `${code}_INCOMPLETE`, reason: `${label} is incomplete: ${suffix}.`, artifactRefs: [file.relative] };
  }
  return { ok: true, file };
}

async function validateStageArtifacts(rootOrView, stage, options = {}) {
  const view = asProjectView(rootOrView);
  const root = view.root;
  const artifactExists = (relative) => projectArtifactExists(view, relative);
  const artifactReader = (relative) => readStructuredProjectArtifact(view, relative);
  if (stage === 'analysis') {
    const files = await listFiles(view, 'work/01_analysis');
    const document = files.find((file) => file.name.toLowerCase() === 'analysis.md');
    if (!document) return { ok: false, code: 'ANALYSIS_MISSING', reason: '缺少有效的 analysis.md。', artifactRefs: [] };
    const source = await readUtf8(document);
    if (meaningfulCharacterCount(source) < MIN_ANALYSIS_CHARACTERS) {
      return { ok: false, code: 'ANALYSIS_TOO_SHORT', reason: '赛题分析正文过短，尚未形成可执行的建模合同。', artifactRefs: [document.relative] };
    }
    const headings = markdownHeadings(source);
    const coverage = conceptCoverage(source, [
      [/问题重述|任务拆解|problem\s+(?:restatement|definition)/i],
      [/数据理解|数据分析|data\s+(?:understanding|analysis)/i],
      [/模型假设|建模假设|基本假设|assumptions?/i],
      [/符号说明|符号表|符号与(?:单位|定义)|notations?|symbols?/i],
      [/方法比较|模型建立|求解方法|methodology|model(?:ing)?\s+approach/i],
      [/验证|敏感性|稳健性|误差|validation|sensitivity|robustness|error\s+analysis/i],
    ]);
    if (headings.length < 6 || coverage < 5) {
      return { ok: false, code: 'ANALYSIS_STRUCTURE_INCOMPLETE', reason: '赛题分析缺少必要的学术结构或验证设计。', artifactRefs: [document.relative] };
    }
    const problemText = files.find((file) => file.name.toLowerCase() === 'problem_text.md');
    if (!problemText || problemText.size < 300) {
      return { ok: false, code: 'PROBLEM_TEXT_MISSING', reason: '缺少可复核的规范化赛题文本。', artifactRefs: [document.relative] };
    }
    const pdf = files.find((file) => file.name.toLowerCase() === 'analysis.pdf');
    if (!await validPdf(pdf)) {
      return { ok: false, code: 'ANALYSIS_PDF_INVALID', reason: 'Analysis PDF is missing or invalid.', artifactRefs: [document.relative, problemText.relative] };
    }
    const subproblemsFile = files.find((file) => file.name.toLowerCase() === 'subproblems.yaml');
    if (!subproblemsFile) {
      return { ok: false, code: 'SUBPROBLEMS_CONTRACT_MISSING', reason: 'Analysis must produce work/01_analysis/subproblems.yaml.', artifactRefs: [document.relative, problemText.relative, pdf.relative] };
    }
    let subproblemsContract;
    try {
      subproblemsContract = YAML.parse(await readUtf8(subproblemsFile));
    } catch {
      return { ok: false, code: 'SUBPROBLEMS_CONTRACT_INVALID', reason: 'subproblems.yaml is not valid YAML.', artifactRefs: [subproblemsFile.relative] };
    }
    const analysisContracts = [
      ['work/01_analysis/data_profile.yaml', 'DATA_PROFILE_MISSING', 'data profile'],
      ['work/01_analysis/model_contract.yaml', 'MODEL_CONTRACT_MISSING', 'model contract'],
      ['work/01_analysis/validation_plan.yaml', 'VALIDATION_PLAN_MISSING', 'validation plan'],
      ['work/01_analysis/figure_plan.yaml', 'FIGURE_PLAN_MISSING', 'figure plan'],
      ['work/01_analysis/literature/evidence_map.yaml', 'LITERATURE_EVIDENCE_MISSING', 'literature evidence map'],
    ];
    const analysisContractFiles = [];
    for (const [suffix, code, label] of analysisContracts) {
      const required = await requireStructuredArtifact(files, suffix, code, label);
      if (!required.ok) return required;
      analysisContractFiles.push(required.file);
    }
    const bibliography = findArtifact(files, 'work/01_analysis/literature/references.bib');
    if (!bibliography || meaningfulCharacterCount(await readUtf8(bibliography)) < 40) {
      return { ok: false, code: 'LITERATURE_BIBLIOGRAPHY_MISSING', reason: 'Verified literature bibliography is missing or empty.', artifactRefs: bibliography ? [bibliography.relative] : [] };
    }
    const analysisNarratives = [
      ['work/01_analysis/intake_risks.md', 'INTAKE_RISKS_MISSING', 'intake risk register', 80],
      ['work/01_analysis/model_design.md', 'MODEL_DESIGN_MISSING', 'model design rationale', 300],
      ['work/01_analysis/literature/search_log.md', 'LITERATURE_SEARCH_LOG_MISSING', 'literature search log', 120],
      ['work/01_analysis/literature/method_notes.md', 'LITERATURE_METHOD_NOTES_MISSING', 'literature method notes', 200],
    ];
    const analysisNarrativeFiles = [];
    for (const [suffix, code, label, minimumCharacters] of analysisNarratives) {
      const required = await requireTextArtifact(files, suffix, code, label, minimumCharacters);
      if (!required.ok) return required;
      analysisNarrativeFiles.push(required.file);
    }
    const contractValidation = validateSubproblemsContract(subproblemsContract);
    if (!contractValidation.ok) {
      return contractFailure(contractValidation, [subproblemsFile.relative]);
    }
    const inputValidation = await validateSubproblemInputs(subproblemsContract, { artifactExists });
    if (!inputValidation.ok) {
      return contractFailure(inputValidation, [subproblemsFile.relative]);
    }
    return {
      ok: true,
      summary: 'Analysis, intake, literature, model, validation, and figure contracts passed validation.',
      artifactRefs: [document, problemText, pdf, subproblemsFile, bibliography, ...analysisContractFiles, ...analysisNarrativeFiles].filter(Boolean).map((file) => file.relative),
    };
  }
  if (stage === 'solving') {
    const files = await listFiles(view, 'work/02_solving');
    const results = files.filter((file) => file.name.toLowerCase() === 'results.yaml');
    const sources = files.filter((file) => ['.py', '.ipynb', '.r', '.m'].includes(file.ext));
    if (!results.length) return { ok: false, code: 'RESULTS_MISSING', reason: '模型求解未生成任何 results.yaml。', artifactRefs: [] };
    if (!sources.length) return { ok: false, code: 'SOURCE_MISSING', reason: '模型求解缺少可复现的关键代码或笔记本。', artifactRefs: results.map((file) => file.relative) };
    const aggregate = files.find((file) => file.name.toLowerCase() === 'aggregate_results.yaml');
    if (!aggregate) return { ok: false, code: 'AGGREGATE_RESULTS_MISSING', reason: '缺少汇总后的实验结果与验证证据。', artifactRefs: [...results, ...sources].map((file) => file.relative) };
    const aggregateSource = await readUtf8(aggregate);
    let aggregateValue;
    try {
      aggregateValue = YAML.parse(aggregateSource);
    } catch {
      return { ok: false, code: 'AGGREGATE_RESULTS_INVALID', reason: '汇总实验结果不是有效的结构化数据。', artifactRefs: [aggregate.relative] };
    }
    if (!aggregateValue || typeof aggregateValue !== 'object' || meaningfulCharacterCount(aggregateSource) < 180 || !containsNumericEvidence(aggregateValue)) {
      return { ok: false, code: 'AGGREGATE_RESULTS_INCOMPLETE', reason: '汇总实验结果缺少指标、误差或对照数据。', artifactRefs: [aggregate.relative] };
    }
    const resultRecords = [];
    for (const result of results) {
      const resultSource = await readUtf8(result);
      try {
        const value = YAML.parse(resultSource);
        if (!value || typeof value !== 'object' || !containsNumericEvidence(value)) {
          return { ok: false, code: 'RESULTS_INCOMPLETE', reason: '子问题结果缺少可复核的数值证据。', artifactRefs: [result.relative] };
        }
        resultRecords.push({ relative: result.relative, value });
      } catch {
        return { ok: false, code: 'RESULTS_INVALID', reason: '子问题结果文件格式无效。', artifactRefs: [result.relative] };
      }
    }

    const analysisFiles = await listFiles(view, 'work/01_analysis');
    const subproblemsFile = analysisFiles.find((file) => file.name.toLowerCase() === 'subproblems.yaml');
    if (!subproblemsFile) {
      return { ok: false, code: 'SUBPROBLEMS_CONTRACT_MISSING', reason: 'Solving requires the validated analysis subproblem contract.', artifactRefs: [aggregate.relative, ...results.map((file) => file.relative)] };
    }
    let subproblemsContract;
    try {
      subproblemsContract = YAML.parse(await readUtf8(subproblemsFile));
    } catch {
      return { ok: false, code: 'SUBPROBLEMS_CONTRACT_INVALID', reason: 'subproblems.yaml is not valid YAML.', artifactRefs: [subproblemsFile.relative] };
    }
    const subproblemsValidation = validateSubproblemsContract(subproblemsContract);
    if (!subproblemsValidation.ok) {
      return contractFailure(subproblemsValidation, [subproblemsFile.relative]);
    }
    const inputValidation = await validateSubproblemInputs(subproblemsContract, { artifactExists });
    if (!inputValidation.ok) {
      return contractFailure(inputValidation, [subproblemsFile.relative]);
    }
    const resultsValidation = await validateResultsContracts(resultRecords, subproblemsContract, { artifactExists, artifactReader });
    if (!resultsValidation.ok) {
      return contractFailure(resultsValidation, results.map((file) => file.relative));
    }
    const aggregateValidation = await validateAggregateContract(
      aggregateValue,
      subproblemsContract,
      resultsValidation.resultPathById,
      { artifactExists, resultValueById: resultsValidation.resultValueById },
    );
    if (!aggregateValidation.ok) {
      return contractFailure(aggregateValidation, [aggregate.relative]);
    }
    const solvingContracts = [
      ['work/02_solving/environment.yaml', 'ENVIRONMENT_CONTRACT_MISSING', 'runtime environment contract'],
      ['work/02_solving/validation_report.yaml', 'VALIDATION_REPORT_MISSING', 'result validation report'],
      ['work/02_solving/figures/figure_manifest.yaml', 'FIGURE_MANIFEST_MISSING', 'scientific figure manifest'],
    ];
    const solvingContractFiles = [];
    let figureManifest;
    for (const [suffix, code, label] of solvingContracts) {
      const required = await requireStructuredArtifact(files, suffix, code, label);
      if (!required.ok) return required;
      solvingContractFiles.push(required.file);
      if (suffix.endsWith('figure_manifest.yaml')) figureManifest = required.value;
    }
    const figureArtifacts = await validateFigureManifestArtifacts(figureManifest, subproblemsContract, artifactExists);
    if (!figureArtifacts.ok) {
      return { ...figureArtifacts, artifactRefs: ['work/02_solving/figures/figure_manifest.yaml'] };
    }
    const validationSummary = await requireTextArtifact(
      files,
      'work/02_solving/validation_summary.md',
      'VALIDATION_SUMMARY_MISSING',
      'validation summary',
      250,
    );
    if (!validationSummary.ok) return validationSummary;
    return {
      ok: true,
      summary: `已验证 ${results.length} 组子问题结果、汇总实验数据和 ${sources.length} 个可复现代码载体。`,
      artifactRefs: [subproblemsFile, aggregate, ...results, ...sources, ...solvingContractFiles, validationSummary.file].filter(Boolean).slice(0, 30).map((file) => file.relative),
    };
  }
  if (stage === 'paper' || stage === 'review') {
    const paperFiles = await listFiles(view, 'work/03_paper');
    const markdown = options.paperFormat === 'markdown'
      ? paperFiles.find((file) => file.name.toLowerCase() === 'paper.md')
      : null;
    if (options.paperFormat === 'markdown' && !markdown) {
      return { ok: false, code: 'MARKDOWN_MISSING', reason: 'Markdown 项目缺少 work/03_paper/paper.md 写作稿。', artifactRefs: [] };
    }
    if (markdown && meaningfulCharacterCount(await readUtf8(markdown)) < MIN_PAPER_CHARACTERS) {
      return { ok: false, code: 'MARKDOWN_TOO_SHORT', reason: 'paper.md 正文篇幅不足，尚未形成完整论文写作稿。', artifactRefs: [markdown.relative] };
    }
    const texFiles = paperFiles.filter((file) => file.ext === '.tex');
    const texSources = await Promise.all(texFiles.map(async (file) => ({ file, source: await readUtf8(file) })));
    const entry = texSources.find((item) => /\\begin\s*\{document\}/.test(item.source))
      || texSources.sort((left, right) => right.file.size - left.file.size)[0];
    const tex = entry?.file;
    const pdfs = paperFiles.filter((file) => file.ext === '.pdf').sort((a, b) => b.size - a.size);
    const pdf = pdfs.find((file) => !file.relative.includes('/figures/')) || pdfs[0];
    if (!tex) return { ok: false, code: 'TEX_MISSING', reason: '论文阶段缺少有效的 TeX 正文。', artifactRefs: [] };
    const texSource = entry.source;
    if (!/\\begin\s*\{document\}/.test(texSource)) return { ok: false, code: 'TEX_INVALID', reason: '论文 TeX 不包含完整文档入口。', artifactRefs: [tex.relative] };
    if (!await validPdf(pdf)) return { ok: false, code: 'PDF_INVALID', reason: '论文 PDF 缺失或格式无效。', artifactRefs: [tex.relative] };
    if (markdown?.modifiedAt && pdf?.modifiedAt && markdown.modifiedAt > pdf.modifiedAt + 10) {
      return { ok: false, code: 'PDF_STALE', reason: 'paper.md 晚于最终 PDF，必须同步 TeX 并重新编译。', artifactRefs: [markdown.relative, tex.relative, pdf.relative] };
    }
    const combinedTex = texSources.map((item) => item.source).join('\n');
    const referencedFigures = await validateReferencedFigures(root, path.dirname(tex.path), combinedTex, pdf);
    if (!referencedFigures.ok) {
      return { ok: false, code: referencedFigures.code, reason: referencedFigures.reason, artifactRefs: [tex.relative, pdf.relative, ...referencedFigures.files.map((file) => file.relative)] };
    }
    if (meaningfulCharacterCount(combinedTex) < MIN_PAPER_CHARACTERS) {
      return { ok: false, code: 'PAPER_TOO_SHORT', reason: '论文正文篇幅不足，尚未完整呈现模型、实验与验证。', artifactRefs: [tex.relative, pdf.relative] };
    }
    const abstractLength = meaningfulCharacterCount(extractAbstract(combinedTex));
    if (abstractLength < MIN_ABSTRACT_CHARACTERS) {
      return { ok: false, code: 'ABSTRACT_TOO_SHORT', reason: '摘要过短，未覆盖方法、结果与结论。', artifactRefs: [tex.relative, pdf.relative] };
    }
    if (abstractLength > MAX_ABSTRACT_CHARACTERS) {
      return { ok: false, code: 'ABSTRACT_TOO_LONG', reason: '摘要过长，存在超页风险。', artifactRefs: [tex.relative, pdf.relative] };
    }
    const sectionTitles = latexSectionTitles(combinedTex);
    const paperCoverage = conceptCoverage(sectionTitles.join('\n'), [
      [/问题|problem/i],
      [/假设|assumption/i],
      [/符号|notation|symbol/i],
      [/模型|方法|model|method/i],
      [/求解|结果|实验|solution|result|experiment/i],
      [/验证|敏感性|稳健性|误差|validation|sensitivity|robustness|error/i],
      [/评价|结论|conclusion|evaluation/i],
    ]);
    if (sectionTitles.length < 7 || paperCoverage < 6) {
      return { ok: false, code: 'PAPER_STRUCTURE_INCOMPLETE', reason: '论文缺少完整的建模、结果、验证或结论章节。', artifactRefs: [tex.relative, pdf.relative] };
    }
    if (/\\appendix\b|\\(?:sub)*section\*?\s*\{\s*(?:附录|appendix)/i.test(combinedTex)) {
      return { ok: false, code: 'APPENDIX_NOT_ALLOWED', reason: '论文包含附录，请将必要实验数据移入正文并移除附录。', artifactRefs: [tex.relative, pdf.relative] };
    }
    const bibliographyFiles = paperFiles.filter((file) => file.ext === '.bib');
    const bibliographySource = `${combinedTex}\n${(await Promise.all(bibliographyFiles.map(readUtf8))).join('\n')}`;
    const referenceCount = (bibliographySource.match(/\\bibitem\b|^\s*@[a-z]+\s*\{/gim) || []).length;
    if (referenceCount < 5) {
      return { ok: false, code: 'REFERENCES_INSUFFICIENT', reason: '专业参考文献数量不足。', artifactRefs: [tex.relative, pdf.relative, ...bibliographyFiles.map((file) => file.relative)] };
    }

    const analysisFiles = await listFiles(view, 'work/01_analysis');
    const subproblemsFile = analysisFiles.find((file) => file.name.toLowerCase() === 'subproblems.yaml');
    if (!subproblemsFile) {
      return { ok: false, code: 'SUBPROBLEMS_CONTRACT_MISSING', reason: 'Paper provenance requires the analysis subproblem contract.', artifactRefs: [tex.relative, pdf.relative] };
    }
    const evidenceManifestFile = paperFiles.find((file) => file.name.toLowerCase() === 'evidence_manifest.yaml');
    if (!evidenceManifestFile) {
      return { ok: false, code: 'EVIDENCE_MANIFEST_MISSING', reason: 'Paper and review require work/03_paper/evidence_manifest.yaml.', artifactRefs: [tex.relative, pdf.relative] };
    }
    let subproblemsContract;
    let evidenceManifest;
    try {
      subproblemsContract = YAML.parse(await readUtf8(subproblemsFile));
    } catch {
      return { ok: false, code: 'SUBPROBLEMS_CONTRACT_INVALID', reason: 'subproblems.yaml is not valid YAML.', artifactRefs: [subproblemsFile.relative] };
    }
    try {
      evidenceManifest = YAML.parse(await readUtf8(evidenceManifestFile));
    } catch {
      return { ok: false, code: 'EVIDENCE_MANIFEST_INVALID', reason: 'evidence_manifest.yaml is not valid YAML.', artifactRefs: [evidenceManifestFile.relative] };
    }
    const inputValidation = await validateSubproblemInputs(subproblemsContract, { artifactExists });
    if (!inputValidation.ok) {
      return contractFailure(inputValidation, [subproblemsFile.relative]);
    }
    const evidenceValidation = await validateEvidenceManifest(evidenceManifest, subproblemsContract, {
      artifactExists,
      artifactReader,
      referencedFigurePaths: referencedFigures.files.map((file) => file.relative),
    });
    if (!evidenceValidation.ok) {
      return contractFailure(evidenceValidation, [subproblemsFile.relative, evidenceManifestFile.relative]);
    }
    const prosePolishReport = await requireStructuredArtifact(
      paperFiles,
      'work/03_paper/prose_polish_report.yaml',
      'PROSE_POLISH_REPORT_MISSING',
      'independent prose polish report',
    );
    if (!prosePolishReport.ok) return prosePolishReport;
    const sourceRefs = [markdown?.relative, tex.relative, pdf.relative].filter(Boolean);
    if (stage === 'paper') return {
      ok: true,
      summary: 'Paper source, evidence, citations, figures, prose audit, and PDF passed validation.',
      artifactRefs: [...sourceRefs, evidenceManifestFile.relative, prosePolishReport.file.relative, ...referencedFigures.files.map((file) => file.relative)],
    };

    const reviewFiles = await listFiles(view, 'work/04_review');
    const releaseManifest = await requireStructuredArtifact(reviewFiles, 'work/04_review/release_manifest.yaml', 'RELEASE_MANIFEST_MISSING', 'release manifest');
    if (!releaseManifest.ok) return releaseManifest;
    const figureAudit = findArtifact(reviewFiles, 'work/04_review/figure_audit.md');
    if (!figureAudit || meaningfulCharacterCount(await readUtf8(figureAudit)) < 200) {
      return { ok: false, code: 'FIGURE_AUDIT_MISSING', reason: 'Final-size figure audit is missing or incomplete.', artifactRefs: figureAudit ? [figureAudit.relative] : [] };
    }
    const audit = [...reviewFiles, ...paperFiles].find((file) => /(?:paper.*audit|quality.*audit|audit.*paper).*\.md$/i.test(file.name));
    if (!audit) return { ok: false, code: 'AUDIT_MISSING', reason: '质量审查未生成有效审计报告。', artifactRefs: [tex.relative, pdf.relative] };
    if (meaningfulCharacterCount(await readUtf8(audit)) < 800) {
      return { ok: false, code: 'AUDIT_TOO_SHORT', reason: '质量审查报告过短，未覆盖内容、排版、图表与真实性检查。', artifactRefs: [tex.relative, pdf.relative, audit.relative] };
    }
    return {
      ok: true,
      summary: 'Final paper, evidence, visual audit, quality audit, and release manifest passed validation.',
      artifactRefs: [...sourceRefs, evidenceManifestFile.relative, prosePolishReport.file.relative, audit.relative, figureAudit.relative, releaseManifest.file.relative],
    };
  }
  return { ok: false, code: 'UNKNOWN_STAGE', reason: `未知阶段：${stage}`, artifactRefs: [] };
}

module.exports = {
  copyRegularDirectory,
  confirmStage,
  ensureWorkspaceInitialized,
  evaluateStageGate,
  listFiles,
  validateStructuredArtifactSchema,
  validateFigureManifestArtifacts,
  validateStageArtifacts,
};
