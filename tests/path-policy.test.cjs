const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  isShellOpenable,
  writeRejectionReason,
  SHELL_OPENABLE_EXTENSIONS,
  WRITABLE_TOP_DIRECTORIES,
} = require('../electron/path-policy.cjs');

test('isShellOpenable allows only inert document formats', () => {
  // Allowed formats
  assert.ok(isShellOpenable('report.pdf'));
  assert.ok(isShellOpenable('chart.png'));
  assert.ok(isShellOpenable('data.csv'));
  assert.ok(isShellOpenable('paper.tex'));
  assert.ok(isShellOpenable('results.json'));

  // Blocked executable and script formats
  assert.ok(!isShellOpenable('model.py'));
  assert.ok(!isShellOpenable('script.ps1'));
  assert.ok(!isShellOpenable('tool.exe'));
  assert.ok(!isShellOpenable('wrapper.bat'));
  assert.ok(!isShellOpenable('launch.cmd'));
  assert.ok(!isShellOpenable('macro.vbs'));
  assert.ok(!isShellOpenable('shortcut.lnk'));
  assert.ok(!isShellOpenable('page.html'));
  assert.ok(!isShellOpenable('app.js'));
});

test('writeRejectionReason confines writes to work and inputs', () => {
  const root = path.resolve('/project');

  // Allowed writes
  assert.equal(writeRejectionReason(root, path.join(root, 'work/03_paper/main.tex')), '');
  assert.equal(writeRejectionReason(root, path.join(root, 'inputs/problem/data.csv')), '');

  // Blocked: checkpoint directory (starts with dot)
  assert.match(
    writeRejectionReason(root, path.join(root, 'work/.desktop-checkpoints/manifest.json')),
    /内部状态/
  );

  // Blocked: supervisor directory
  assert.match(
    writeRejectionReason(root, path.join(root, 'work/.desktop-supervisor/state.bin')),
    /内部状态/
  );

  // Blocked: project root
  assert.match(
    writeRejectionReason(root, path.join(root, 'README.md')),
    /work 或 inputs/
  );

  // Blocked: other top-level directory
  assert.match(
    writeRejectionReason(root, path.join(root, 'scripts/build.js')),
    /work 或 inputs/
  );
});

test('SHELL_OPENABLE_EXTENSIONS covers common document types but excludes executables', () => {
  const allowed = ['.pdf', '.png', '.csv', '.xlsx', '.txt', '.md', '.tex', '.json', '.yaml'];
  const blocked = ['.exe', '.bat', '.cmd', '.ps1', '.vbs', '.lnk', '.html', '.js', '.py'];

  for (const ext of allowed) {
    assert.ok(SHELL_OPENABLE_EXTENSIONS.has(ext), `${ext} should be openable`);
  }
  for (const ext of blocked) {
    assert.ok(!SHELL_OPENABLE_EXTENSIONS.has(ext), `${ext} should be blocked`);
  }
});

test('WRITABLE_TOP_DIRECTORIES contains only work and inputs', () => {
  assert.deepEqual([...WRITABLE_TOP_DIRECTORIES].sort(), ['inputs', 'work']);
});
