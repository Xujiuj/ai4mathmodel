const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  ensureWorkspaceInitialized,
  validateFigureManifestArtifacts,
  validateStageArtifacts,
  validateStructuredArtifactSchema,
} = require('../electron/supervisor/artifact-gates.cjs');

async function fixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modeling-artifact-gates-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function writeEnhancedAnalysisContracts(directory) {
  const literature = path.join(directory, 'literature');
  await fs.mkdir(literature, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(directory, 'data_profile.yaml'), 'schema_version: 1\ndatasets:\n  - path: inputs/problem/statement.txt\n    status: profiled\n', 'utf8'),
    fs.writeFile(path.join(directory, 'model_contract.yaml'), 'schema_version: 1\nmodels:\n  - subproblem_id: sp-1\n    method: regularized regression\n    claim_type: predictive\n    estimand_or_objective: future conditional mean\n    candidate_families: [linear regression, tree ensemble]\n    baseline: historical mean\n    assumptions: [stable sampling]\n    validation_tests: [held-out error]\n    failure_modes: [distribution shift]\n    fallback: regularized linear baseline\n', 'utf8'),
    fs.writeFile(path.join(directory, 'validation_plan.yaml'), 'schema_version: 1\nchecks:\n  - subproblem_id: sp-1\n    method: baseline comparison\n', 'utf8'),
    fs.writeFile(path.join(directory, 'figure_plan.yaml'), 'schema_version: 1\nfigures:\n  - id: fig-1\n    claim: model comparison\n', 'utf8'),
    fs.writeFile(path.join(literature, 'evidence_map.yaml'), 'schema_version: 1\nevidence:\n  - id: lit-1\n    claim_supported: The method is applicable.\n    status: verified\n    role: method_origin\n    metadata:\n      title: Verified modeling method\n      year: 2025\n      doi: 10.1000/verified\n    verification:\n      service: Crossref\n      checked_fields: [title, year, doi]\n', 'utf8'),
    fs.writeFile(path.join(literature, 'references.bib'), '@article{verified, title={Verified modeling method}, author={Author}, journal={Journal}, year={2025}}\n', 'utf8'),
    fs.writeFile(path.join(directory, 'intake_risks.md'), '# Intake risks\n\nAmbiguity, missing-data exposure, conservative interpretation, and resolution checks are recorded here. '.repeat(3), 'utf8'),
    fs.writeFile(path.join(directory, 'model_design.md'), '# Model design\n\nCandidate methods, equations, assumptions, baseline, interfaces, and failure conditions are compared. '.repeat(12), 'utf8'),
    fs.writeFile(path.join(literature, 'search_log.md'), '# Search log\n\nQuery, registry, date, scope, inclusion rationale, and exclusion rationale are recorded. '.repeat(5), 'utf8'),
    fs.writeFile(path.join(literature, 'method_notes.md'), '# Method notes\n\nApplicability, assumptions, evidence, strengths, limitations, and known failure modes are recorded. '.repeat(8), 'utf8'),
  ]);
}

test('structured workflow contracts reject arbitrary YAML objects', () => {
  const valid = {
    'work/01_analysis/data_profile.yaml': { schema_version: 1, datasets: [{ path: 'inputs/data.csv', status: 'profiled' }] },
    'work/01_analysis/model_contract.yaml': { schema_version: 1, models: [{ subproblem_id: 'sp-1', method: 'regression', claim_type: 'predictive', estimand_or_objective: 'conditional mean', candidate_families: ['linear', 'tree'], baseline: 'mean', assumptions: ['stable sampling'], validation_tests: ['holdout'], failure_modes: ['shift'], fallback: 'linear' }] },
    'work/01_analysis/validation_plan.yaml': { schema_version: 1, checks: [{ subproblem_id: 'sp-1', method: 'holdout' }] },
    'work/01_analysis/figure_plan.yaml': { schema_version: 1, figures: [{ id: 'fig-1', claim: 'comparison' }] },
    'work/01_analysis/literature/evidence_map.yaml': { schema_version: 1, evidence: [{ id: 'lit-1', claim_supported: 'supported', status: 'verified', role: 'method_origin', metadata: { title: 'Paper', year: 2025, doi: '10.1000/verified' }, verification: { service: 'Crossref', checked_fields: ['title', 'year', 'doi'] } }] },
    'work/02_solving/environment.yaml': { schema_version: 1, runtime: { name: 'python', version: '3.11' }, dependencies: [] },
    'work/02_solving/validation_report.yaml': { schema_version: 1, checks: [{ id: 'check-1', subproblem_id: 'sp-1', status: 'passed', evidence_paths: ['work/result.yaml'] }] },
    'work/02_solving/figures/figure_manifest.yaml': { schema_version: 1, figures: [{ figure_id: 'fig-1', subproblem_id: 'sp-1', claim: 'comparison', source_data: ['work/data.csv'], data_locators: ['metrics.score'], generation_source: 'work/plot.py', archetype: 'dot interval', final_width: 'single-column', exports: ['work/fig.pdf'], qa_status: 'passed' }] },
    'work/03_paper/prose_polish_report.yaml': { schema_version: 1, decision: 'PASS', findings: [], overclaims: [], unresolved_terminology: [] },
    'work/04_review/release_manifest.yaml': { schema_version: 1, decision: 'PASS', files: [{ path: 'work/03_paper/main.pdf', sha256: 'a'.repeat(64) }] },
  };
  for (const [artifact, value] of Object.entries(valid)) {
    assert.equal(validateStructuredArtifactSchema(artifact, value), true, artifact);
    assert.equal(validateStructuredArtifactSchema(artifact, { foo: 'bar' }), false, artifact);
  }
});

test('quality gates reject slogan-only model, literature, and figure contracts', () => {
  assert.equal(validateStructuredArtifactSchema('work/01_analysis/model_contract.yaml', {
    schema_version: 1,
    models: [{ subproblem_id: 'sp-1', method: 'advanced model' }],
  }), false);
  assert.equal(validateStructuredArtifactSchema('work/01_analysis/literature/evidence_map.yaml', {
    schema_version: 1,
    evidence: [{ id: 'lit-1', claim: 'supported', title: 'unverified', status: 'candidate' }],
  }), false);
  assert.equal(validateStructuredArtifactSchema('work/02_solving/figures/figure_manifest.yaml', {
    schema_version: 1,
    figures: [{ figure_id: 'fig-1', claim: 'looks good', source_data: ['work/data.csv'], generation_source: 'work/plot.py', exports: ['work/fig.png'] }],
  }), false);
});

test('figure manifest gate resolves ownership and every declared artifact', async () => {
  const manifest = {
    figures: [{
      figure_id: 'fig-1',
      subproblem_id: 'sp-1',
      source_data: ['work/02_solving/sub_problem_1/results.yaml'],
      generation_source: 'work/02_solving/sub_problem_1/plot.py',
      exports: ['work/02_solving/sub_problem_1/figures/result.pdf'],
    }],
  };
  const contract = { subproblems: [{ id: 'sp-1' }] };
  const existing = new Set([
    'work/02_solving/sub_problem_1/results.yaml',
    'work/02_solving/sub_problem_1/plot.py',
    'work/02_solving/sub_problem_1/figures/result.pdf',
  ]);
  assert.equal((await validateFigureManifestArtifacts(manifest, contract, async (file) => existing.has(file))).ok, true);
  const missing = await validateFigureManifestArtifacts(manifest, contract, async () => false);
  assert.equal(missing.code, 'FIGURE_ARTIFACT_MISSING');
  const unknown = await validateFigureManifestArtifacts(manifest, { subproblems: [{ id: 'sp-2' }] }, async () => true);
  assert.equal(unknown.code, 'FIGURE_SUBPROBLEM_UNKNOWN');
});

test('initialization copies the complete uploaded template into an empty paper workspace', async (context) => {
  const root = await fixture(context);
  await fs.mkdir(path.join(root, 'inputs', 'template', 'figures'), { recursive: true });
  await fs.mkdir(path.join(root, 'inputs', 'problem'), { recursive: true });
  await fs.writeFile(path.join(root, 'inputs', 'template', 'main.tex'), '\\documentclass{article}\\begin{document}\\end{document}', 'utf8');
  await fs.writeFile(path.join(root, 'inputs', 'template', 'paper.cls'), 'class source', 'utf8');
  await fs.writeFile(path.join(root, 'inputs', 'template', 'figures', 'logo.png'), 'image', 'utf8');
  await fs.writeFile(path.join(root, 'inputs', 'problem', 'statement.txt'), 'problem statement', 'utf8');

  const result = await ensureWorkspaceInitialized(root);

  assert.equal(result.ok, true);
  assert.equal(result.copiedTemplateFiles, 3);
  assert.equal(await fs.readFile(path.join(root, 'work', '03_paper', 'paper.cls'), 'utf8'), 'class source');
  assert.equal(await fs.readFile(path.join(root, 'work', '03_paper', 'figures', 'logo.png'), 'utf8'), 'image');
});

test('initialization never overwrites an existing paper workspace', async (context) => {
  const root = await fixture(context);
  await fs.mkdir(path.join(root, 'inputs', 'template'), { recursive: true });
  await fs.mkdir(path.join(root, 'inputs', 'problem'), { recursive: true });
  await fs.mkdir(path.join(root, 'work', '03_paper'), { recursive: true });
  await fs.writeFile(path.join(root, 'inputs', 'template', 'main.tex'), '\\documentclass{article}', 'utf8');
  await fs.writeFile(path.join(root, 'inputs', 'problem', 'statement.txt'), 'problem statement', 'utf8');
  await fs.writeFile(path.join(root, 'work', '03_paper', 'draft.tex'), 'existing draft', 'utf8');

  const result = await ensureWorkspaceInitialized(root);

  assert.equal(result.ok, true);
  assert.equal(result.copiedTemplateFiles, 0);
  assert.equal(await fs.readFile(path.join(root, 'work', '03_paper', 'draft.tex'), 'utf8'), 'existing draft');
  await assert.rejects(fs.access(path.join(root, 'work', '03_paper', 'main.tex')));
});

test('initialization creates a competition-specific default template when none was uploaded', async (context) => {
  const root = await fixture(context);
  await fs.mkdir(path.join(root, 'inputs', 'problem'), { recursive: true });
  await fs.writeFile(path.join(root, 'inputs', 'problem', 'statement.txt'), 'problem statement', 'utf8');

  const result = await ensureWorkspaceInitialized(root, { competition: 'american' });

  assert.equal(result.ok, true);
  assert.equal(result.generatedTemplate, true);
  const source = await fs.readFile(path.join(root, 'inputs', 'template', 'main.tex'), 'utf8');
  assert.match(source, /MCM\/ICM/);
  assert.match(await fs.readFile(path.join(root, 'work', '03_paper', 'main.tex'), 'utf8'), /\\documentclass/);
});

test('rejects a short analysis even when the file clears the old byte threshold', async (context) => {
  const root = await fixture(context);
  const directory = path.join(root, 'work', '01_analysis');
  await fs.mkdir(directory, { recursive: true });
  const paddedOutline = '# 问题分析\n\n' + '方法描述。'.repeat(180);
  await fs.writeFile(path.join(directory, 'analysis.md'), paddedOutline, 'utf8');

  const result = await validateStageArtifacts(root, 'analysis');

  assert.equal(result.ok, false);
  assert.equal(result.code, 'ANALYSIS_TOO_SHORT');
});

test('requires a valid local PDF alongside a complete analysis', async (context) => {
  const root = await fixture(context);
  const directory = path.join(root, 'work', '01_analysis');
  await fs.mkdir(directory, { recursive: true });
  const headings = [
    '问题重述', '数据理解', '模型假设', '符号说明', '方法比较', '验证设计',
  ].map((heading) => `# ${heading}\n${'可复核的技术分析与验证设计。'.repeat(110)}`).join('\n\n');
  await fs.writeFile(path.join(directory, 'analysis.md'), headings, 'utf8');
  await fs.writeFile(path.join(directory, 'problem_text.md'), '规范化题意与数据清单。'.repeat(40), 'utf8');

  const result = await validateStageArtifacts(root, 'analysis');

  assert.equal(result.ok, false);
  assert.equal(result.code, 'ANALYSIS_PDF_INVALID');
});

test('accepts equivalent Chinese academic headings in a complete analysis contract', async (context) => {
  const root = await fixture(context);
  const directory = path.join(root, 'work', '01_analysis');
  await fs.mkdir(directory, { recursive: true });
  const headings = [
    '问题重述与任务拆解', '数据理解与证据分层', '建模假设',
    '符号与单位', '候选方法比较', '验证与稳健性设计',
  ].map((heading) => `# ${heading}\n${'可复核的技术分析、约束说明、数值证据和验证设计。'.repeat(120)}`).join('\n\n');
  await fs.writeFile(path.join(directory, 'analysis.md'), headings, 'utf8');
  await fs.writeFile(path.join(directory, 'problem_text.md'), '规范化题意与数据清单。'.repeat(40), 'utf8');
  await fs.writeFile(path.join(directory, 'analysis.pdf'), Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2048)]));
  await fs.mkdir(path.join(root, 'inputs', 'problem'), { recursive: true });
  await fs.writeFile(path.join(root, 'inputs', 'problem', 'statement.txt'), 'modeling problem', 'utf8');
  await fs.writeFile(path.join(directory, 'subproblems.yaml'), [
    'schema_version: 1',
    'subproblems:',
    '  - id: sp-1',
    '    question: Complete the stated modeling task.',
    '    inputs: [inputs/problem/statement.txt]',
    '    outputs: [work/02_solving/sub_problem_1/results.yaml]',
    '    depends_on: []',
    '    primary_method: Validated mathematical modeling.',
    '    validation_requirements: [Compare against a baseline.]',
  ].join('\n'), 'utf8');
  await writeEnhancedAnalysisContracts(directory);

  const result = await validateStageArtifacts(root, 'analysis');

  assert.equal(result.ok, true, result.reason || '');

  await fs.writeFile(path.join(directory, 'data_profile.yaml'), 'foo: bar\n', 'utf8');
  const malformed = await validateStageArtifacts(root, 'analysis');
  assert.equal(malformed.ok, false);
  assert.equal(malformed.code, 'DATA_PROFILE_MISSING_SCHEMA_INVALID');
});

test('requires the enhanced evidence and model contracts after the legacy analysis contract passes', async (context) => {
  const root = await fixture(context);
  const directory = path.join(root, 'work', '01_analysis');
  await fs.mkdir(directory, { recursive: true });
  const headings = [
    'Problem restatement', 'Data understanding', 'Model assumptions', 'Notation and units', 'Method comparison', 'Validation design',
  ].map((heading) => `# ${heading}\n${'Reproducible technical analysis with constraints, evidence, and validation. '.repeat(120)}`).join('\n\n');
  await fs.writeFile(path.join(directory, 'analysis.md'), headings, 'utf8');
  await fs.writeFile(path.join(directory, 'problem_text.md'), 'Normalized problem statement and data inventory. '.repeat(40), 'utf8');
  await fs.writeFile(path.join(directory, 'analysis.pdf'), Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2048)]));
  await fs.mkdir(path.join(root, 'inputs', 'problem'), { recursive: true });
  await fs.writeFile(path.join(root, 'inputs', 'problem', 'statement.txt'), 'modeling problem', 'utf8');
  await fs.writeFile(path.join(directory, 'subproblems.yaml'), [
    'schema_version: 1',
    'subproblems:',
    '  - id: sp-1',
    '    question: Complete the stated modeling task.',
    '    inputs: [inputs/problem/statement.txt]',
    '    outputs: [work/02_solving/sub_problem_1/results.yaml]',
    '    depends_on: []',
    '    primary_method: Validated mathematical modeling.',
    '    validation_requirements: [Compare against a baseline.]',
  ].join('\n'), 'utf8');
  const collision = path.join(directory, 'nested', 'work', '01_analysis');
  await fs.mkdir(collision, { recursive: true });
  await fs.writeFile(path.join(collision, 'data_profile.yaml'), 'schema_version: 1\ndatasets: []\n', 'utf8');

  const result = await validateStageArtifacts(root, 'analysis');

  assert.equal(result.ok, false);
  assert.equal(result.code, 'DATA_PROFILE_MISSING');
});

test('requires the versioned subproblem handoff after existing analysis checks pass', async (context) => {
  const root = await fixture(context);
  const directory = path.join(root, 'work', '01_analysis');
  await fs.mkdir(directory, { recursive: true });
  const headings = [
    '问题重述', '数据理解', '模型假设', '符号说明', '方法比较', '验证设计',
  ].map((heading) => `# ${heading}\n${'可复核的技术分析与验证设计。'.repeat(120)}`).join('\n\n');
  await fs.writeFile(path.join(directory, 'analysis.md'), headings, 'utf8');
  await fs.writeFile(path.join(directory, 'problem_text.md'), '规范化题意与数据清单。'.repeat(40), 'utf8');
  await fs.writeFile(path.join(directory, 'analysis.pdf'), Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2048)]));

  const result = await validateStageArtifacts(root, 'analysis');

  assert.equal(result.ok, false);
  assert.equal(result.code, 'SUBPROBLEMS_CONTRACT_MISSING');
});

test('requires aggregate experiment evidence before accepting solving artifacts', async (context) => {
  const root = await fixture(context);
  const directory = path.join(root, 'work', '02_solving', 'sub_problem_1');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'solver.py'), 'print("done")\n', 'utf8');
  await fs.writeFile(path.join(directory, 'results.yaml'), 'metrics:\n  score: 0.8\n', 'utf8');

  const result = await validateStageArtifacts(root, 'solving');

  assert.equal(result.ok, false);
  assert.equal(result.code, 'AGGREGATE_RESULTS_MISSING');
});

test('rejects a thin paper regardless of template boilerplate and PDF presence', async (context) => {
  const root = await fixture(context);
  const directory = path.join(root, 'work', '03_paper');
  await fs.mkdir(directory, { recursive: true });
  const tex = `\\documentclass{article}
\\begin{document}
\\begin{abstract}摘要过短。\\end{abstract}
\\section{问题重述}${'模板占位。'.repeat(350)}
\\end{document}`;
  await fs.writeFile(path.join(directory, 'main.tex'), tex, 'utf8');
  await fs.writeFile(path.join(directory, 'main.pdf'), Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2048)]));

  const result = await validateStageArtifacts(root, 'paper');

  assert.equal(result.ok, false);
  assert.ok(['PAPER_TOO_SHORT', 'ABSTRACT_TOO_SHORT', 'PAPER_STRUCTURE_INCOMPLETE'].includes(result.code));
});

test('requires the Markdown writing source for Markdown projects', async (context) => {
  const root = await fixture(context);
  const directory = path.join(root, 'work', '03_paper');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'main.tex'), '\\documentclass{article}\n\\begin{document}content\\end{document}', 'utf8');
  await fs.writeFile(path.join(directory, 'main.pdf'), Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2048)]));

  const result = await validateStageArtifacts(root, 'paper', { paperFormat: 'markdown' });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'MARKDOWN_MISSING');
});

test('rejects a thin Markdown writing source before evaluating TeX gates', async (context) => {
  const root = await fixture(context);
  const directory = path.join(root, 'work', '03_paper');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'paper.md'), '# 标题\n内容不足。', 'utf8');

  const result = await validateStageArtifacts(root, 'paper', { paperFormat: 'markdown' });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'MARKDOWN_TOO_SHORT');
});

test('rejects a PDF that predates a referenced generated figure', async (context) => {
  const root = await fixture(context);
  const directory = path.join(root, 'work', '03_paper');
  const figures = path.join(directory, 'figures');
  await fs.mkdir(figures, { recursive: true });
  const sections = [
    '问题重述', '模型假设', '符号说明', '模型建立与方法', '模型求解与实验结果', '敏感性与稳健性验证', '模型评价与结论',
  ].map((title) => `\\section{${title}}\n${'本节基于真实数据说明变量关系、计算结果、误差来源与可复核证据。'.repeat(220)}`).join('\n');
  const references = Array.from({ length: 5 }, (_, index) => `\\bibitem{r${index}} 作者. 专业期刊论文 ${index}. 学术期刊, 2025.`).join('\n');
  const tex = `\\documentclass{article}
\\usepackage{graphicx}
\\begin{document}
\\begin{abstract}${'本文给出问题、方法、核心数值结果和稳健性结论。'.repeat(45)}\\end{abstract}
\\includegraphics{figures/overview.png}
${sections}
\\begin{thebibliography}{9}${references}\\end{thebibliography}
\\end{document}`;
  const texPath = path.join(directory, 'main.tex');
  const pdfPath = path.join(directory, 'main.pdf');
  const figurePath = path.join(figures, 'overview.png');
  await fs.writeFile(texPath, tex, 'utf8');
  await fs.writeFile(pdfPath, Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2048)]));
  await fs.writeFile(figurePath, Buffer.from('89504e470d0a1a0a', 'hex'));
  const old = new Date(Date.now() - 10_000);
  await fs.utimes(pdfPath, old, old);

  const result = await validateStageArtifacts(root, 'paper');

  assert.equal(result.ok, false);
  assert.equal(result.code, 'PDF_STALE');
});

test('rejects a referenced figure that escapes through a directory link', async (context) => {
  const root = await fixture(context);
  const externalFigures = await fs.mkdtemp(path.join(os.tmpdir(), 'modeling-external-figures-'));
  context.after(() => fs.rm(externalFigures, { recursive: true, force: true }));
  const directory = path.join(root, 'work', '03_paper');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(externalFigures, 'overview.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  await fs.symlink(
    externalFigures,
    path.join(directory, 'figures'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const sections = [
    '问题重述', '模型假设', '符号说明', '模型建立与方法', '模型求解与实验结果', '敏感性与稳健性验证', '模型评价与结论',
  ].map((title) => `\\section{${title}}\n${'本节基于真实数据说明变量关系、计算结果、误差来源与可复核证据。'.repeat(220)}`).join('\n');
  const references = Array.from({ length: 5 }, (_, index) => `\\bibitem{r${index}} Author. Verified journal article ${index}. Journal, 2025.`).join('\n');
  const tex = `\\documentclass{article}
\\usepackage{graphicx}
\\begin{document}
\\begin{abstract}${'本文给出问题、方法、核心数值结果和稳健性结论。'.repeat(45)}\\end{abstract}
\\includegraphics{figures/overview.png}
${sections}
\\begin{thebibliography}{9}${references}\\end{thebibliography}
\\end{document}`;
  await fs.writeFile(path.join(directory, 'main.tex'), tex, 'utf8');
  await fs.writeFile(path.join(directory, 'main.pdf'), Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2048)]));

  const result = await validateStageArtifacts(root, 'paper');

  assert.equal(result.ok, false);
  assert.equal(result.code, 'FIGURE_REFERENCE_UNSAFE');
});
