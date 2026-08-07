const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assertWorkspaceMutationPath,
  workspaceToolsForExecution,
  writableWorkspacePrefixesForStage,
} = require('../electron/workspace-tool-policy.cjs');

function namesFor(readOnly, stage, researchEnabled = false) {
  return workspaceToolsForExecution(readOnly, stage, researchEnabled).map((tool) => tool.name);
}

test('analysis can inspect documents but cannot execute model-authored Python', () => {
  const tools = namesFor(false, 'analysis');
  assert.equal(tools.includes('inspect_document'), true);
  assert.equal(tools.includes('run_python'), false);
  assert.equal(tools.includes('compile_paper'), false);
});

test('solving retains Python while paper stages retain compilation', () => {
  const solving = namesFor(false, 'solving');
  assert.equal(solving.includes('run_python'), true);
  assert.equal(solving.includes('compile_paper'), false);

  const paper = namesFor(false, 'paper');
  assert.equal(paper.includes('run_python'), true);
  assert.equal(paper.includes('compile_paper'), true);
});

test('read-only execution removes all mutation and execution tools', () => {
  const tools = namesFor(true, 'review');
  assert.equal(tools.includes('write_workspace_file'), false);
  assert.equal(tools.includes('run_python'), false);
  assert.equal(tools.includes('compile_paper'), false);
});

test('scholarly search is opt-in and remains stage-scoped', () => {
  assert.equal(namesFor(false, 'analysis').includes('search_scholarly_sources'), false);
  assert.equal(namesFor(false, 'analysis', true).includes('search_scholarly_sources'), true);
  assert.equal(workspaceToolsForExecution(false, 'analysis', { researchEnabled: true }).some((tool) => tool.name === 'search_scholarly_sources'), true);
  assert.equal(namesFor(true, 'review', true).includes('search_scholarly_sources'), true);
  assert.equal(namesFor(false, 'solving', true).includes('search_scholarly_sources'), false);
});

test('stage mutation paths are confined to the owning artifact directories', () => {
  assert.deepEqual(writableWorkspacePrefixesForStage('analysis'), ['work/01_analysis']);
  assert.deepEqual(writableWorkspacePrefixesForStage('solving'), ['work/02_solving']);
  assert.deepEqual(writableWorkspacePrefixesForStage('paper'), ['work/03_paper']);
  assert.deepEqual(writableWorkspacePrefixesForStage('review'), ['work/03_paper', 'work/04_review']);

  assert.equal(assertWorkspaceMutationPath('analysis', 'work/01_analysis/analysis.md'), 'work/01_analysis/analysis.md');
  assert.equal(assertWorkspaceMutationPath('solving', 'work\\02_solving\\solver.py'), 'work/02_solving/solver.py');
  assert.equal(assertWorkspaceMutationPath('review', 'work/03_paper/main.tex'), 'work/03_paper/main.tex');
  assert.equal(assertWorkspaceMutationPath('review', 'work/04_review/paper_quality_audit.md'), 'work/04_review/paper_quality_audit.md');

  assert.throws(
    () => assertWorkspaceMutationPath('solving', 'work/03_paper/main.tex'),
    (error) => error?.code === 'WORKSPACE_STAGE_WRITE_RESTRICTED',
  );
  assert.throws(
    () => assertWorkspaceMutationPath('paper', 'work/03_paper/../../01_analysis/analysis.md'),
    (error) => error?.code === 'WORKSPACE_STAGE_WRITE_RESTRICTED',
  );
  assert.throws(
    () => assertWorkspaceMutationPath('supervisor', 'work/01_analysis/analysis.md'),
    (error) => error?.code === 'WORKSPACE_STAGE_WRITE_RESTRICTED',
  );
});
