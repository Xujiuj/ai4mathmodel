const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { markdownToPrintHtml, renderAnalysisPdf } = require('../electron/analysis-pdf.cjs');

test('analysis PDF markup escapes model-authored HTML and preserves readable structure', () => {
  const html = markdownToPrintHtml('# Analysis\n\n- **Method** <script>bad()</script>\n\n```py\nprint(1)\n```');

  assert.match(html, /<h1>Analysis<\/h1>/);
  assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>bad\(\)<\/script>/);
  assert.match(html, /<pre class="code">print\(1\)<\/pre>/);
});

test('analysis PDF renderer writes a valid local PDF through the supplied window', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'analysis-pdf-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sourcePath = path.join(directory, 'analysis.md');
  const outputPath = path.join(directory, 'analysis.pdf');
  await fs.writeFile(sourcePath, '# Analysis\n\nA local report.', 'utf8');
  let destroyed = false;
  const fakeWindow = {
    loadURL: async () => {},
    webContents: {
      executeJavaScript: async () => {},
      printToPDF: async () => Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2048)]),
    },
    isDestroyed: () => destroyed,
    destroy: () => {
      destroyed = true;
    },
  };

  const result = await renderAnalysisPdf({ sourcePath, outputPath, createWindow: () => fakeWindow });

  assert.equal(result.path, outputPath);
  assert.equal(destroyed, true);
  const pdf = await fs.readFile(outputPath);
  assert.equal(pdf.subarray(0, 5).toString('ascii'), '%PDF-');
});
