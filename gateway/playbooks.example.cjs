// 真实内容放在同目录 playbooks.cjs（已 gitignore），本文件仅描述结构。
// 注入层用它把客户端占位符展开为完整 system 内容，客户端永不持有这些文本。

const SHARED_RULES = '在此填入共享执行与安全规则。';

const STAGE_PLAYBOOKS = {
  analysis: '在此填入 analysis 阶段 playbook。',
  solving: '在此填入 solving 阶段 playbook。',
  paper: '在此填入 paper 阶段 playbook。',
  review: '在此填入 review 阶段 playbook。',
  supervisor: '在此填入只读规划 playbook。',
};

const AGENT_RULES = {
  rw: '在此填入可写模式的 agent 系统约束。',
  ro: '在此填入只读模式的 agent 系统约束。',
};

const STAGE_TASKS = {
  analysis: '在此填入 analysis 阶段任务指令。',
  solving: '在此填入 solving 阶段任务指令。',
  paper: '在此填入 paper 阶段任务指令。',
  review: '在此填入 review 阶段任务指令。',
  supervisor: '在此填入 supervisor 只读规划任务指令。',
};

function expandPlaybook({ stage, readOnly }) {
  const playbook = STAGE_PLAYBOOKS[stage];
  const task = STAGE_TASKS[stage];
  if (!playbook || !task) return null;
  return [AGENT_RULES[readOnly ? 'ro' : 'rw'], SHARED_RULES, playbook, task].join('\n\n');
}

module.exports = { expandPlaybook };
