const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { defaultLatexTemplate } = require('../electron/default-templates.cjs');
const { withTectonicFontAliases } = require('../electron/runtime-tools.cjs');

const projectRoot = path.resolve(__dirname, '..');
const tectonic = path.join(projectRoot, 'runtime', 'tectonic', 'tectonic.exe');
const cache = path.join(projectRoot, 'runtime', 'tectonic', 'cache');

test('competition defaults are distinct and compile with the offline runtime', async (context) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mmw-default-templates-'));
  context.after(() => fsp.rm(root, { recursive: true, force: true }));
  const templates = [
    ['china', /Chinese Mathematical Modeling Competition/, /a4paper/],
    ['american', /MCM\/ICM/, /letterpaper/],
  ];

  assert.equal(fs.existsSync(tectonic), true, 'bundled Tectonic is required for template verification');
  for (const [competition, identity, paperSize] of templates) {
    const directory = path.join(root, competition);
    await fsp.mkdir(directory, { recursive: true });
    const source = defaultLatexTemplate(competition);
    assert.match(source, identity);
    assert.match(source, paperSize);
    await fsp.writeFile(path.join(directory, 'main.tex'), source, 'utf8');
    const result = await withTectonicFontAliases(directory, { appRoot: projectRoot }, async () => spawnSync(
      tectonic,
      ['--untrusted', '--only-cached', '--outdir', directory, 'main.tex'],
      {
        cwd: directory,
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, TECTONIC_CACHE_DIR: cache },
      },
    ));
    assert.equal(result.status, 0, `${competition}: ${result.stdout}\n${result.stderr}`);
    const pdf = await fsp.readFile(path.join(directory, 'main.pdf'));
    assert.equal(pdf.subarray(0, 5).toString('ascii'), '%PDF-');
  }
});
