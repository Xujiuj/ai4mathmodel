const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const mainSource = fs.readFileSync(require.resolve('../electron/main.cjs'), 'utf8');

const {
  claimProjectCreationRoot,
  normalizeProjectCreationName,
  resolveProjectCreationRoot,
} = require('../electron/project-creation.cjs');

async function temporaryDirectory() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'mmw-project-creation-'));
}

test('project names reject empty and dot names after sanitization', () => {
  for (const value of ['', '   ', '.', '..']) {
    assert.throws(() => normalizeProjectCreationName(value), /项目名称无效/);
  }
});

test('sanitized traversal names remain a direct child of the selected parent', () => {
  const parent = path.resolve('selected-parent');
  const name = normalizeProjectCreationName('../outside');
  const root = resolveProjectCreationRoot(parent, name);
  assert.equal(path.dirname(root), parent);
  assert.equal(root, path.join(parent, '..-outside'));
});

test('exclusive project root claiming rejects existing directories, files, and links', async (t) => {
  const parent = await temporaryDirectory();
  t.after(() => fsp.rm(parent, { recursive: true, force: true }));

  const existingDirectory = path.join(parent, 'existing-directory');
  await fsp.mkdir(existingDirectory);
  await assert.rejects(() => claimProjectCreationRoot(parent, 'existing-directory'), { code: 'EEXIST' });
  assert.equal(fs.existsSync(existingDirectory), true);

  const existingFile = path.join(parent, 'existing-file');
  await fsp.writeFile(existingFile, 'keep');
  await assert.rejects(() => claimProjectCreationRoot(parent, 'existing-file'), { code: 'EEXIST' });
  assert.equal(await fsp.readFile(existingFile, 'utf8'), 'keep');

  const existingLink = path.join(parent, 'existing-link');
  await fsp.symlink(existingFile, existingLink, 'file');
  await assert.rejects(() => claimProjectCreationRoot(parent, 'existing-link'), { code: 'EEXIST' });
  assert.equal((await fsp.lstat(existingLink)).isSymbolicLink(), true);
});

test('valid project root claiming creates only the requested child', async (t) => {
  const parent = await temporaryDirectory();
  t.after(() => fsp.rm(parent, { recursive: true, force: true }));

  const claimed = await claimProjectCreationRoot(parent, 'valid-project');
  assert.equal(claimed.safeName, 'valid-project');
  assert.equal(claimed.root, path.join(parent, 'valid-project'));
  assert.equal((await fsp.lstat(claimed.root)).isDirectory(), true);
  assert.equal((await fsp.readdir(parent)).length, 1);
});

test('a failed post-claim operation removes only the claimed target', async (t) => {
  const parent = await temporaryDirectory();
  t.after(() => fsp.rm(parent, { recursive: true, force: true }));
  const sibling = path.join(parent, 'keep.txt');
  await fsp.writeFile(sibling, 'keep');

  const { root } = await claimProjectCreationRoot(parent, 'failed-project');
  await assert.rejects(async () => {
    try {
      await fsp.writeFile(path.join(root, 'partial.txt'), 'partial');
      throw new Error('simulated project creation failure');
    } catch (error) {
      await fsp.rm(root, { recursive: true, force: true });
      throw error;
    }
  }, /simulated project creation failure/);
  assert.equal(fs.existsSync(root), false);
  assert.equal(await fsp.readFile(sibling, 'utf8'), 'keep');
});

test('the Electron handler uses exclusive claiming and target-scoped cleanup', () => {
  const handlerStart = mainSource.indexOf("handle('projects:create'");
  const handlerEnd = mainSource.indexOf("handle('projects:remove'", handlerStart);
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
  const handler = mainSource.slice(handlerStart, handlerEnd);
  assert.match(handler, /claimProjectCreationRoot\(result\.filePaths\[0\], name\)/);
  assert.match(handler, /fsp\.rm\(root, \{ recursive: true, force: true \}\)/);
  assert.match(handler, /flag: 'wx'/);
});
