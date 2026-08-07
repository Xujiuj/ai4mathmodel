const path = require('node:path');
const { WORKSPACE_TOOL_DEFINITIONS } = require('./supervisor/direct-provider.cjs');
const { RESEARCH_TOOL_NAME, isAllowedResearchStage } = require('./supervisor/research.cjs');

const STAGE_MUTATION_PREFIXES = Object.freeze({
  analysis: Object.freeze(['work/01_analysis']),
  solving: Object.freeze(['work/02_solving']),
  paper: Object.freeze(['work/03_paper']),
  review: Object.freeze(['work/03_paper', 'work/04_review']),
});

function writableWorkspacePrefixesForStage(stage = '') {
  return [...(STAGE_MUTATION_PREFIXES[stage] || [])];
}

function assertWorkspaceMutationPath(stage, value) {
  const normalized = String(value || '').trim().replaceAll('\\', '/');
  const relative = path.posix.normalize(normalized).replace(/^\.\//, '');
  const allowed = writableWorkspacePrefixesForStage(stage);
  if (!normalized || relative === '.' || relative === '..' || relative.startsWith('../')
    || !allowed.some((prefix) => relative === prefix || relative.startsWith(`${prefix}/`))) {
    const error = new Error('WORKSPACE_STAGE_WRITE_RESTRICTED');
    error.code = 'WORKSPACE_STAGE_WRITE_RESTRICTED';
    throw error;
  }
  return relative;
}

function workspaceToolsForExecution(readOnly, stage = '', researchEnabled = false) {
  const blocked = new Set(readOnly ? ['write_workspace_file', 'run_python', 'run_builtin_recipe', 'compile_paper'] : []);
  const researchOptIn = researchEnabled === true
    || researchEnabled?.researchEnabled === true;
  if (stage === 'analysis') blocked.add('run_python');
  if (!['paper', 'review'].includes(stage)) blocked.add('compile_paper');
  return WORKSPACE_TOOL_DEFINITIONS.filter((tool) => tool.name !== RESEARCH_TOOL_NAME
    || (researchOptIn && isAllowedResearchStage(stage)))
    .filter((tool) => !blocked.has(tool.name));
}

module.exports = {
  assertWorkspaceMutationPath,
  workspaceToolsForExecution,
  writableWorkspacePrefixesForStage,
};
