const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  DOCUMENT_INSPECTOR,
  MAX_DOCUMENT_CHARS,
  isSupportedDocumentExtension,
  parseInspectorOutput,
} = require('../electron/document-inspector.cjs');

function pythonTestEnvironment(cacheKey = 'shared') {
  return {
    ...process.env,
    PYTHONUTF8: '1',
    PYTHONNOUSERSITE: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONPYCACHEPREFIX: path.join(os.tmpdir(), `document-inspector-pycache-${cacheKey}`),
  };
}

test('document inspector accepts only PDF and DOCX extensions', () => {
  assert.equal(isSupportedDocumentExtension('.pdf'), true);
  assert.equal(isSupportedDocumentExtension('.DOCX'), true);
  assert.equal(isSupportedDocumentExtension('.txt'), false);
  assert.equal(isSupportedDocumentExtension(''), false);
});

test('document inspector parses the final JSON payload after runtime diagnostics', () => {
  const parsed = parseInspectorOutput([
    'RapidOCR: loading bundled models',
    JSON.stringify({ ok: true, text: '题目正文', truncated: false, ocrPages: [2] }),
  ].join('\n'));

  assert.deepEqual(parsed, {
    ok: true,
    text: '题目正文',
    truncated: false,
    ocrPages: [2],
  });
});

test('document inspector enforces the bounded text contract and rejects malformed output', () => {
  const oversized = 'x'.repeat(MAX_DOCUMENT_CHARS + 25);
  const parsed = parseInspectorOutput(JSON.stringify({ ok: true, text: oversized, truncated: false }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.text.length, MAX_DOCUMENT_CHARS);
  assert.equal(parsed.truncated, true);
  assert.equal(parseInspectorOutput('not json'), null);
  assert.equal(parseInspectorOutput(JSON.stringify({ ok: false })), null);
});

test('bundled inspector script preserves OCR and DOCX table extraction paths', () => {
  assert.match(DOCUMENT_INSPECTOR, /from rapidocr_onnxruntime import RapidOCR/);
  assert.match(DOCUMENT_INSPECTOR, /from docx import Document/);
  assert.match(DOCUMENT_INSPECTOR, /document\.tables/);
  assert.match(DOCUMENT_INSPECTOR, /pymupdf\.Matrix\(2, 2\)/);
  assert.match(DOCUMENT_INSPECTOR, /MAX_CHARS = 120000/);
});

test('embedded Python inspector compiles with the bundled runtime', (context) => {
  const python = path.join(__dirname, '..', 'runtime', 'python', 'python.exe');
  if (!fs.existsSync(python)) {
    context.skip('bundled Python runtime is not present in this checkout');
    return;
  }
  const result = spawnSync(python, ['-c', 'import sys; compile(sys.stdin.read(), "<document-inspector>", "exec")'], {
    input: DOCUMENT_INSPECTOR,
    encoding: 'utf8',
    env: pythonTestEnvironment('compile'),
    windowsHide: true,
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('bundled Python inspector extracts DOCX paragraphs and tables', async (context) => {
  const python = path.join(__dirname, '..', 'runtime', 'python', 'python.exe');
  if (!fs.existsSync(python)) {
    context.skip('bundled Python runtime is not present in this checkout');
    return;
  }
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'document-inspector-'));
  context.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'problem.docx');
  const create = spawnSync(python, ['-c', [
    'from docx import Document',
    'import sys',
    'd = Document()',
    'd.add_paragraph("题目正文")',
    't = d.add_table(rows=2, cols=2)',
    't.cell(0, 0).text = "变量"',
    't.cell(0, 1).text = "值"',
    't.cell(1, 0).text = "x"',
    't.cell(1, 1).text = "42"',
    'd.save(sys.argv[1])',
  ].join('; '), source], {
    encoding: 'utf8',
    env: pythonTestEnvironment('docx'),
    windowsHide: true,
    timeout: 30_000,
  });
  assert.equal(create.status, 0, create.stderr || create.stdout);

  const inspected = spawnSync(python, ['-c', DOCUMENT_INSPECTOR, source], {
    encoding: 'utf8',
    env: pythonTestEnvironment('docx'),
    windowsHide: true,
    timeout: 60_000,
  });
  assert.equal(inspected.status, 0, inspected.stderr || inspected.stdout);
  const payload = JSON.parse(inspected.stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(payload.ok, true);
  assert.match(payload.text, /题目正文/);
  assert.match(payload.text, /\| 变量 \| 值 \|/);
  assert.match(payload.text, /\| x \| 42 \|/);
});

test('bundled Python inspector keeps a usable PDF text layer without OCR', async (context) => {
  const python = path.join(__dirname, '..', 'runtime', 'python', 'python.exe');
  if (!fs.existsSync(python)) {
    context.skip('bundled Python runtime is not present in this checkout');
    return;
  }
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'document-inspector-pdf-'));
  context.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'problem.pdf');
  const create = spawnSync(python, ['-c', [
    'import pymupdf',
    'import sys',
    'd = pymupdf.open()',
    'p = d.new_page()',
    'p.insert_text((72, 72), "This PDF contains an authoritative text layer for inspection.")',
    'd.save(sys.argv[1])',
    'd.close()',
  ].join('; '), source], {
    encoding: 'utf8',
    env: pythonTestEnvironment('pdf'),
    windowsHide: true,
    timeout: 30_000,
  });
  assert.equal(create.status, 0, create.stderr || create.stdout);

  const inspected = spawnSync(python, ['-c', DOCUMENT_INSPECTOR, source], {
    encoding: 'utf8',
    env: pythonTestEnvironment('pdf'),
    windowsHide: true,
    timeout: 60_000,
  });
  assert.equal(inspected.status, 0, inspected.stderr || inspected.stdout);
  const payload = JSON.parse(inspected.stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(payload.ok, true);
  assert.match(payload.text, /authoritative text layer/);
  assert.deepEqual(payload.ocrPages, []);
});
