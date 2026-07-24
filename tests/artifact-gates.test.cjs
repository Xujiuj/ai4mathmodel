const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { ensureWorkspaceInitialized, validateStageArtifacts } = require('../electron/supervisor/artifact-gates.cjs');

async function fixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modeling-artifact-gates-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

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
