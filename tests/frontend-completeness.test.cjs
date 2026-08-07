const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('hosted account controls expose all five canonical role tiers', () => {
  const source = read('src/components/AccountPanel.jsx');
  for (const role of ['coordinator', 'modeler', 'coder', 'writer', 'image']) {
    assert.match(source, new RegExp(`\\['${role}',\\s*'`), role);
  }
  assert.match(source, /onTierChange\?\.\(key, event\.target\.value\)/);
});

test('historical run reads reject quick-switch and project-switch responses', () => {
  const app = read('src/App.jsx');
  assert.match(app, /const historyRequestRef = useRef\(0\)/);
  assert.match(app, /const runCatalogRequestRef = useRef\(0\)/);
  assert.match(app, /historyRequestRef\.current \+= 1/);
  assert.match(app, /runCatalogRequestRef\.current \+= 1/);
  assert.match(app, /const selectedRunIdRef = useRef\(''\)/);
  assert.match(app, /const projectRoot = activeProject\.root/);
  assert.match(app, /const requestId = \+\+historyRequestRef\.current/);
  assert.match(app, /projectRoot === activeProjectRef\.current\?\.root/);
  assert.match(app, /selectedRunIdRef\.current === runId/);
  assert.match(app, /historyRequestRef\.current \+= 1;[\s\S]*setHistoryLoading\(false\);/);
  assert.match(app, /if \(!isCurrentRequest\(\)\) return;/);
  assert.match(app, /if \(isCurrentRequest\(\)\) setHistoryLoading\(false\)/);
  assert.match(app, /const projectRoot = project\?\.root \|\| ''/);
  assert.match(app, /desktopApi\.listRuns\(projectRoot, \{ limit: 100 \}\)/);
  assert.match(app, /const isCurrentRequest = \(\) => requestId === runCatalogRequestRef\.current/);
  assert.match(app, /if \(!isCurrentRequest\(\)\) return \[\];/);

  let generation = 0;
  let activeRoot = 'project-a';
  let selectedRun = '';
  const accepted = [];
  const request = (root, runId) => {
    const requestId = ++generation;
    activeRoot = root;
    selectedRun = runId;
    return { requestId, root, runId };
  };
  const settle = ({ requestId, root, runId, value }) => {
    if (requestId === generation && root === activeRoot && runId === selectedRun) accepted.push(value);
  };

  const first = request('project-a', 'run-1');
  const second = request('project-a', 'run-2');
  settle({ ...first, value: 'stale-run-1' });
  settle({ ...second, value: 'current-run-2' });
  const third = request('project-b', 'run-3');
  settle({ ...second, value: 'stale-project-a' });
  settle({ ...third, value: 'current-project-b' });
  assert.deepEqual(accepted, ['current-run-2', 'current-project-b']);

  let catalogGeneration = 0;
  let catalogRoot = 'project-a';
  const catalogAccepted = [];
  const catalogRequest = (root) => ({ requestId: ++catalogGeneration, root });
  const settleCatalog = ({ requestId, root, value }) => {
    if (requestId === catalogGeneration && root === catalogRoot) catalogAccepted.push(value);
  };
  const oldCatalog = catalogRequest('project-a');
  const currentCatalog = catalogRequest('project-a');
  settleCatalog({ ...oldCatalog, value: 'stale-catalog' });
  settleCatalog({ ...currentCatalog, value: 'current-catalog' });
  catalogRoot = 'project-b';
  const projectBCatalog = catalogRequest('project-b');
  settleCatalog({ ...currentCatalog, value: 'stale-project-a-catalog' });
  settleCatalog({ ...projectBCatalog, value: 'current-project-b-catalog' });
  assert.deepEqual(catalogAccepted, ['current-catalog', 'current-project-b-catalog']);
});

test('all advertised image formats share the same preview routing contract', async () => {
  const moduleUrl = `${require('node:url').pathToFileURL(path.join(root, 'src/fileTypes.js')).href}?test=${Date.now()}`;
  const { IMAGE_PREVIEW_EXTENSIONS } = await import(moduleUrl);
  assert.deepEqual([...IMAGE_PREVIEW_EXTENSIONS], ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']);
  assert.match(read('src/App.jsx'), /IMAGE_PREVIEW_EXTENSIONS\.has\(file\.ext\)/);
  assert.match(read('src/components/PaperWorkspace.jsx'), /IMAGE_PREVIEW_EXTENSIONS\.has\(extension\)/);
});

test('native PDF previews expose recoverable loading, error, timeout, and loaded states', () => {
  const paper = read('src/components/PaperWorkspace.jsx');
  const styles = read('src/styles.css');
  assert.match(paper, /const PDF_LOAD_TIMEOUT_MS = 8000/);
  assert.match(paper, /data-pdf-state=\{state\}/);
  assert.match(paper, /data-pdf-timeout-ms=\{PDF_LOAD_TIMEOUT_MS\}/);
  assert.match(paper, /onLoad=\{markLoaded\}/);
  assert.match(paper, /onError=\{markFailed\}/);
  assert.match(paper, /state === 'error' \|\| state === 'timeout'/);
  assert.match(paper, /className="native-pdf-recovery"/);
  assert.equal((paper.match(/<NativePdfPreview\b/g) || []).length, 3);
  assert.match(styles, /\.native-pdf-preview \{[^}]*position: relative/);
  assert.match(styles, /\.native-pdf-status \{[^}]*position: absolute/);
});

test('browser preview version is injected from package metadata', () => {
  const packageInfo = JSON.parse(read('package.json'));
  assert.match(read('vite.config.mjs'), /__MATH_MODEL_APP_VERSION__[\s\S]*packageInfo\.version/);
  assert.match(read('src/api.js'), /version:\s*APP_VERSION/);
  assert.doesNotMatch(read('src/api.js'), /version:\s*'0\.1\.0'/);
  assert.equal(packageInfo.version, '0.1.1');
});

test('project removal and autosave expose renderer-side failure guards', () => {
  assert.match(read('src/components/Shell.jsx'), /disabled=\{Boolean\(projectRun\)\}/);
  assert.match(read('src/App.jsx'), /projectIsRunning\(displayRuns, project\?\.root\)/);
  const paper = read('src/components/PaperWorkspace.jsx');
  assert.match(paper, /catch \(error\)[\s\S]*onSaveError\?\.\(error\)/);
  assert.match(paper, /void save\(\)/);
});

test('responsive icon controls retain accessible names when labels are hidden', () => {
  const shell = read('src/components/Shell.jsx');
  for (const label of ['新建项目', '导入项目', '运行记录', '账户与充值', '设置与模型']) {
    assert.match(shell, new RegExp(`aria-label="${label}"`), label);
  }
  assert.match(shell, /<CommandButton[^>]+aria-label=\{primaryLabel\}/);
});

test('run drawer tabs and tools fit the narrow workspace without clipping', () => {
  const styles = read('src/styles.css');
  assert.match(styles, /@media \(max-width: 390px\)[\s\S]*?\.drawer-tabs \{[^}]*min-width: 0;[^}]*overflow: hidden;/);
  assert.match(styles, /@media \(max-width: 390px\)[\s\S]*?\.drawer-tabs > button \{[^}]*min-width: 0;[^}]*flex: 1 1 0;/);
  assert.match(styles, /@media \(max-width: 390px\)[\s\S]*?\.drawer-tabs-actions \{[^}]*flex: 0 0 67px;/);
});

test('external run-history actions move focus into an already open drawer without stealing internal tab focus', () => {
  const drawer = read('src/components/RunDrawer.jsx');
  assert.match(drawer, /if \(drawer && !drawer\.contains\(document\.activeElement\)\) drawer\.focus\(\)/);
  assert.match(drawer, /\}, \[open, tab\]\)/);
});

test('run drawer exposes selected-run history, resume, and replay actions', () => {
  const drawer = read('src/components/RunDrawer.jsx');
  const app = read('src/App.jsx');
  for (const label of ['历史运行', '查看所选日志', '从断点继续', '重新运行']) assert.match(drawer, new RegExp(label));
  assert.match(app, /desktopApi\.listRuns\(/);
  assert.match(app, /desktopApi\.runHistory\(projectRoot, \{ runId, limit: 2000 \}\)/);
  assert.match(app, /desktopApi\.resumeRun\(project\.root, run\.runId\)/);
  assert.match(app, /desktopApi\.replayRun\(project\.root, run\.runId\)/);
  assert.match(app, /后续模型调用仍会正常计费/);
});
