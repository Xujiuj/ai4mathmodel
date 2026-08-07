const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('sidebar active-run lookup uses canonical project roots', () => {
  const shell = read('src/components/Shell.jsx');
  assert.match(shell, /import \{ canonicalProjectRoot \} from '\.\.\/runState\.js';/);
  assert.match(shell, /new Map\([\s\S]*activeRuns\s*\.map\(\(item\) => \[canonicalProjectRoot\(item\.root\), item\]\)[\s\S]*filter\(\(\[root\]\) => Boolean\(root\)\)/);
  assert.match(shell, /runByRoot\.get\(canonicalProjectRoot\(project\.root\)\)/);
});

test('safe-stop action reports renderer failures instead of leaking a rejection', () => {
  const app = read('src/App.jsx');
  assert.match(app, /const stopStage = async \(\) => \{/);
  assert.match(app, /try \{\s*await desktopApi\.stopStage\(activeProject\.root\);/);
  assert.match(app, /catch \(error\) \{\s*notify\(error\.message \|\| '停止任务失败，请重试。', 'error'\);/);
});

test('filesystem commands surface IPC failures to the renderer', () => {
  const app = read('src/App.jsx');
  assert.match(app, /const openExternal = async \(file\) => \{/);
  assert.match(app, /await desktopApi\.openPath\(file\.path\)/);
  assert.match(app, /无法使用系统程序打开文件。/);
  assert.match(app, /const revealOutput = async \(file\) => \{/);
  assert.match(app, /await desktopApi\.revealPath\(file\.path\)/);
  assert.match(app, /无法在文件夹中显示输出文件。/);
  assert.match(app, /const exportFile = async \(file, label\) => \{/);
  assert.match(app, /await desktopApi\.exportFile\(file\.path\)/);
  assert.match(app, /导出失败，请重试。/);
});

test('checkpoint restore converts IPC errors into a dismissible toast', () => {
  const app = read('src/App.jsx');
  assert.match(app, /await desktopApi\.restoreCheckpoint\(activeProject\.root, checkpoint\.id\)/);
  assert.match(app, /恢复检查点失败，请重试。/);
});

test('project creation accepts direct text and text-file uploads', () => {
  const modal = read('src/components/Modals.jsx');
  const preload = read('electron/preload.cjs');
  assert.match(modal, /problemText/);
  assert.match(modal, /accept="\.txt,\.md/);
  assert.match(modal, /dataTransfer\.files/);
  assert.match(preload, /problemText:/);
});

test('paper snapshot and command bar expose DOCX export', () => {
  const app = read('src/App.jsx');
  const workspace = read('src/components/PaperWorkspace.jsx');
  const main = read('electron/main.cjs');
  assert.match(main, /paper: \{ pdf, tex, markdown, docx,/);
  assert.match(main, /require\('\.\/docx-export\.cjs'\)/);
  assert.match(app, /hasDocx=\{Boolean\(snapshot\?\.paper\?\.docx\)\}/);
  assert.match(app, /onExportDocx=\{\(\) => exportFile\(snapshot\?\.paper\?\.docx, 'DOCX'\)\}/);
  assert.match(workspace, /onExportDocx/);
  assert.match(workspace, /导出DOCX/);
});
