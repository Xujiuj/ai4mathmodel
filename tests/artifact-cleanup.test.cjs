const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { cleanupProjectArtifacts, cleanupStageArtifacts, isTransientFile } = require('../electron/artifact-cleanup.cjs');

test('classifies rebuildable files without treating source or compile logs as transient', () => {
  assert.equal(isTransientFile('paper.aux'), true);
  assert.equal(isTransientFile('paper.synctex.gz'), true);
  assert.equal(isTransientFile('paper.log'), true);
  assert.equal(isTransientFile('solver.py~'), true);
  assert.equal(isTransientFile('solver.py'), false);
  assert.equal(isTransientFile('results.yaml'), false);
  assert.equal(isTransientFile('compile.log'), false);
});

test('cleans only the selected stage and preserves key artifacts', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'modeling-cleanup-'));
  try {
    const solving = path.join(root, 'work', '02_solving', 'sub_problem_1');
    const analysis = path.join(root, 'work', '01_analysis');
    await fsp.mkdir(path.join(solving, '__pycache__'), { recursive: true });
    await fsp.mkdir(analysis, { recursive: true });
    await Promise.all([
      fsp.writeFile(path.join(solving, '__pycache__', 'model.pyc'), 'cache'),
      fsp.writeFile(path.join(solving, 'solver.py'), 'print(1)'),
      fsp.writeFile(path.join(solving, 'results.yaml'), 'summary: {}'),
      fsp.writeFile(path.join(solving, 'draft.tmp'), 'temporary'),
      fsp.writeFile(path.join(analysis, 'analysis.aux'), 'other stage'),
    ]);

    const result = await cleanupStageArtifacts(root, 'solving');

    assert.equal(result.removedCount, 2);
    assert.equal(fs.existsSync(path.join(solving, '__pycache__')), false);
    assert.equal(fs.existsSync(path.join(solving, 'draft.tmp')), false);
    assert.equal(fs.existsSync(path.join(solving, 'solver.py')), true);
    assert.equal(fs.existsSync(path.join(solving, 'results.yaml')), true);
    assert.equal(fs.existsSync(path.join(analysis, 'analysis.aux')), true);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('keeps one figure format unless the paper explicitly references the PNG', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'modeling-figures-'));
  try {
    const figures = path.join(root, 'work', '02_solving', 'figures');
    const paper = path.join(root, 'work', '03_paper');
    await fsp.mkdir(figures, { recursive: true });
    await fsp.mkdir(path.join(paper, 'figures'), { recursive: true });
    await Promise.all([
      fsp.writeFile(path.join(figures, 'result.png'), 'png'),
      fsp.writeFile(path.join(figures, 'result.pdf'), 'pdf'),
      fsp.writeFile(path.join(paper, 'figures', 'used.png'), 'png'),
      fsp.writeFile(path.join(paper, 'figures', 'used.pdf'), 'pdf'),
      fsp.writeFile(path.join(paper, 'main.tex'), '\\includegraphics{figures/used.png}'),
    ]);

    await cleanupStageArtifacts(root, 'solving');
    await cleanupStageArtifacts(root, 'paper');

    assert.equal(fs.existsSync(path.join(figures, 'result.png')), false);
    assert.equal(fs.existsSync(path.join(figures, 'result.pdf')), true);
    assert.equal(fs.existsSync(path.join(paper, 'figures', 'used.png')), true);
    assert.equal(fs.existsSync(path.join(paper, 'figures', 'used.pdf')), true);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('removes legacy prompt, state and preview artifacts without deleting deliverables', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'modeling-private-artifacts-'));
  try {
    const analysis = path.join(root, 'work', '01_analysis');
    const prompts = path.join(root, 'work', '03_paper', 'image_prompts');
    await fsp.mkdir(analysis, { recursive: true });
    await fsp.mkdir(prompts, { recursive: true });
    await Promise.all([
      fsp.writeFile(path.join(root, 'work', 'pipeline-state.yaml'), 'private: true'),
      fsp.writeFile(path.join(analysis, 'analysis_state_payload.json'), '{}'),
      fsp.writeFile(path.join(analysis, 'figure_prompts.json'), '{}'),
      fsp.writeFile(path.join(analysis, 'analysis-preview-page1.png'), 'preview'),
      fsp.writeFile(path.join(analysis, 'analysis.md'), '# 最终分析'),
      fsp.writeFile(path.join(prompts, 'figure.txt'), 'private prompt'),
    ]);

    const result = await cleanupProjectArtifacts(root);

    assert.equal(result.removedCount, 5);
    assert.equal(fs.existsSync(path.join(root, 'work', 'pipeline-state.yaml')), false);
    assert.equal(fs.existsSync(path.join(analysis, 'analysis_state_payload.json')), false);
    assert.equal(fs.existsSync(path.join(analysis, 'figure_prompts.json')), false);
    assert.equal(fs.existsSync(path.join(analysis, 'analysis-preview-page1.png')), false);
    assert.equal(fs.existsSync(prompts), false);
    assert.equal(fs.existsSync(path.join(analysis, 'analysis.md')), true);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
