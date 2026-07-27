const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const TRANSIENT_DIRECTORIES = new Set(['__pycache__', '.pytest_cache', '.ipynb_checkpoints', '.mypy_cache', '.ruff_cache', '.staging']);
const TRANSIENT_SUFFIXES = [
  '.aux',
  '.out',
  '.toc',
  '.lof',
  '.lot',
  '.blg',
  '.synctex.gz',
  '.fdb_latexmk',
  '.fls',
  '.xdv',
  '.nav',
  '.snm',
  '.vrb',
  '.tmp',
  '.temp',
  '.bak',
];
const INTERNAL_ARTIFACT_NAMES = new Set([
  'pipeline-state.yaml',
  'analysis_state_payload.json',
  'figure_prompts.json',
  'schematic_page_checks.json',
]);
const INTERNAL_ARTIFACT_DIRECTORIES = new Set(['image_prompts']);

const STAGE_DIRECTORIES = Object.freeze({
  analysis: ['work/01_analysis'],
  solving: ['work/02_solving'],
  paper: ['work/03_paper'],
  review: ['work/03_paper', 'work/04_review'],
});

function isTransientFile(name) {
  const lower = name.toLowerCase();
  if ((lower.endsWith('.log') && lower !== 'compile.log') || lower.endsWith('~')) return true;
  return TRANSIENT_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

function isInternalArtifact(name) {
  const lower = String(name || '').toLowerCase();
  return INTERNAL_ARTIFACT_NAMES.has(lower)
    || INTERNAL_ARTIFACT_DIRECTORIES.has(lower)
    || /(?:^|[-_])(?:preview(?:[-_]?page\d*)?|page[-_]?checks?)\.(?:png|jpg|jpeg|json)$/i.test(lower);
}

async function cleanDirectory(projectRoot, directory, removed) {
  if (!fs.existsSync(directory)) return;
  const entries = await fsp.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (TRANSIENT_DIRECTORIES.has(entry.name.toLowerCase()) || INTERNAL_ARTIFACT_DIRECTORIES.has(entry.name.toLowerCase())) {
        await fsp.rm(target, { recursive: true, force: true });
        removed.push(path.relative(projectRoot, target).replaceAll('\\', '/'));
      } else {
        await cleanDirectory(projectRoot, target, removed);
      }
    } else if (entry.isFile() && (isTransientFile(entry.name) || isInternalArtifact(entry.name))) {
      await fsp.rm(target, { force: true });
      removed.push(path.relative(projectRoot, target).replaceAll('\\', '/'));
    }
  }
}

function normalizedPath(target) {
  const resolved = path.resolve(target);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function collectExplicitFigureReferences(projectRoot) {
  const paperRoot = path.join(projectRoot, 'work', '03_paper');
  const references = new Set();
  async function visit(directory) {
    if (!fs.existsSync(directory)) return;
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.tex') continue;
      const source = await fsp.readFile(target, 'utf8').catch(() => '');
      for (const match of source.matchAll(/\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}/g)) {
        const reference = match[1].trim();
        if (!reference || reference.includes('\\')) continue;
        const resolved = path.resolve(path.dirname(target), reference);
        if (path.extname(reference)) references.add(normalizedPath(resolved));
        else {
          references.add(normalizedPath(`${resolved}.png`));
          references.add(normalizedPath(`${resolved}.pdf`));
        }
      }
    }
  }
  await visit(paperRoot);
  return references;
}

async function compactDuplicateFigures(projectRoot, directories, removed) {
  const references = await collectExplicitFigureReferences(projectRoot);
  const groups = new Map();
  async function visit(directory) {
    if (!fs.existsSync(directory)) return;
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      if (!entry.isFile()) continue;
      const extension = path.extname(entry.name).toLowerCase();
      if (!['.png', '.pdf'].includes(extension)) continue;
      const key = normalizedPath(path.join(directory, path.basename(entry.name, extension)));
      const group = groups.get(key) || {};
      group[extension.slice(1)] = target;
      groups.set(key, group);
    }
  }
  for (const directory of directories) await visit(directory);
  for (const group of groups.values()) {
    if (!group.png || !group.pdf || references.has(normalizedPath(group.png))) continue;
    await fsp.rm(group.png, { force: true });
    removed.push(path.relative(projectRoot, group.png).replaceAll('\\', '/'));
  }
}

async function cleanupStageArtifacts(projectRoot, stage) {
  const root = path.resolve(projectRoot);
  const directories = STAGE_DIRECTORIES[stage] || [];
  const removed = [];
  const targets = [];
  for (const relative of directories) {
    const target = path.resolve(root, relative);
    if (target !== root && target.startsWith(`${root}${path.sep}`)) {
      targets.push(target);
      await cleanDirectory(root, target, removed);
    }
  }
  await compactDuplicateFigures(root, targets, removed);
  return { stage, removed, removedCount: removed.length };
}

async function cleanupProjectArtifacts(projectRoot) {
  const root = path.resolve(projectRoot);
  const removed = [];
  for (const relative of ['work/01_analysis', 'work/02_solving', 'work/03_paper', 'work/04_review']) {
    const target = path.resolve(root, relative);
    if (target.startsWith(`${root}${path.sep}`)) await cleanDirectory(root, target, removed);
  }
  const legacyState = path.join(root, 'work', 'pipeline-state.yaml');
  if (fs.existsSync(legacyState)) {
    await fsp.rm(legacyState, { force: true });
    removed.push('work/pipeline-state.yaml');
  }
  return { removed, removedCount: removed.length };
}

module.exports = {
  cleanupStageArtifacts,
  cleanupProjectArtifacts,
  compactDuplicateFigures,
  isInternalArtifact,
  isTransientFile,
};
