const STAGE_RUNTIME_REQUIREMENTS = {
  analysis: ['python'],
  solving: ['python'],
  paper: ['python', 'tectonic'],
  review: ['python', 'tectonic'],
  compile: ['tectonic'],
};

export function canonicalProjectRoot(root) {
  return String(root || '').replaceAll('\\', '/').replace(/\/+$/, '').toLocaleLowerCase();
}

export function sameProjectRoot(left, right) {
  const a = canonicalProjectRoot(left);
  const b = canonicalProjectRoot(right);
  return Boolean(a && b && a === b);
}

export function mergeActiveRuns(...runLists) {
  const merged = new Map();
  for (const run of runLists.flat()) {
    const key = canonicalProjectRoot(run?.root);
    if (key) merged.set(key, { ...merged.get(key), ...run });
  }
  return [...merged.values()];
}

export function projectIsRunning(runs, root) {
  return (Array.isArray(runs) ? runs : []).some((run) => sameProjectRoot(run?.root, root));
}

export function runtimePreflight(runtime = {}, stages = []) {
  const required = [...new Set((Array.isArray(stages) ? stages : [stages])
    .flatMap((stage) => STAGE_RUNTIME_REQUIREMENTS[String(stage || '').toLowerCase()] || []))];
  const missing = required.filter((tool) => runtime?.[tool] !== true);
  return { ok: missing.length === 0, required, missing };
}
