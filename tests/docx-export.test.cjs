const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { convertPaperToDocx, isValidDocx } = require('../electron/docx-export.cjs');

const projectRoot = path.resolve(__dirname, '..');
const python = path.join(projectRoot, 'runtime', 'python', 'python.exe');
const pythonEnv = {
  ...process.env,
  PYTHONDONTWRITEBYTECODE: '1',
  PYTHONNOUSERSITE: '1',
  PYTHONUTF8: '1',
};

test('paper conversion produces a DOCX package readable by python-docx', async (context) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mmw-docx-export-'));
  context.after(() => fsp.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'paper.tex');
  const output = path.join(root, 'paper.docx');
  await fsp.writeFile(source, String.raw`\title{Verified Modeling Paper}
\begin{document}
\section{Method}
The optimization model minimizes total cost under capacity constraints.
\subsection{Validation}
Sensitivity analysis confirms the principal conclusion.
\end{document}`, 'utf8');

  const converted = await convertPaperToDocx({
    sourcePath: source,
    outputPath: output,
    runPython: async (args) => {
      const result = spawnSync(python, args, { cwd: root, encoding: 'utf8', windowsHide: true, env: pythonEnv });
      return { code: result.status, stdout: result.stdout, stderr: result.stderr };
    },
  });
  assert.deepEqual(converted, { ok: true, path: output });
  assert.equal(await isValidDocx(output), true);

  const opened = spawnSync(python, ['-c', 'from docx import Document; import sys; print("|".join(p.text for p in Document(sys.argv[1]).paragraphs))', output], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    env: pythonEnv,
  });
  assert.equal(opened.status, 0, opened.stderr);
  assert.match(opened.stdout, /Verified Modeling Paper/);
  assert.match(opened.stdout, /Sensitivity analysis/);
});

test('DOCX validation rejects arbitrary ZIP-like files', async (context) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mmw-docx-invalid-'));
  context.after(() => fsp.rm(root, { recursive: true, force: true }));
  const invalid = path.join(root, 'invalid.docx');
  await fsp.writeFile(invalid, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(400)]));
  assert.equal(await isValidDocx(invalid), false);
});
