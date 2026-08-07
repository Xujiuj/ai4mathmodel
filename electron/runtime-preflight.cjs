const STAGE_RUNTIME_REQUIREMENTS = Object.freeze({
  analysis: Object.freeze(['python']),
  solving: Object.freeze(['python']),
  paper: Object.freeze(['python', 'tectonic']),
  review: Object.freeze(['python', 'tectonic']),
  compile: Object.freeze(['tectonic']),
});

function requiredRuntimes(stages = []) {
  return [...new Set((Array.isArray(stages) ? stages : [stages])
    .flatMap((stage) => STAGE_RUNTIME_REQUIREMENTS[String(stage || '').toLowerCase()] || []))];
}

function runtimePreflight(runtime = {}, stages = []) {
  const required = requiredRuntimes(stages);
  const missing = required.filter((tool) => runtime?.[tool] !== true);
  return { ok: missing.length === 0, required, missing };
}

function assertRuntimeAvailable(runtime = {}, stages = []) {
  const result = runtimePreflight(runtime, stages);
  if (result.ok) return result;
  const labels = result.missing.map((tool) => tool === 'tectonic' ? 'LaTeX' : 'Python');
  const error = new Error(`缺少运行组件：${labels.join('、')}。请先在设置中安装或配置后再运行。`);
  error.code = 'RUNTIME_PREFLIGHT_FAILED';
  error.missing = result.missing;
  throw error;
}

module.exports = {
  STAGE_RUNTIME_REQUIREMENTS,
  assertRuntimeAvailable,
  requiredRuntimes,
  runtimePreflight,
};
