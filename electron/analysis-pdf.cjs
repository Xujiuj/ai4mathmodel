const fsp = require('node:fs/promises');
const path = require('node:path');

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function inlineMarkdown(value) {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

function markdownToPrintHtml(markdown) {
  const blocks = [];
  const codeLines = [];
  let inCode = false;
  const flushCode = () => {
    if (!codeLines.length) return;
    blocks.push(`<pre class="code">${escapeHtml(codeLines.join('\n'))}</pre>`);
    codeLines.length = 0;
  };

  for (const line of String(markdown || '').replaceAll('\r\n', '\n').split('\n')) {
    if (/^```/.test(line.trim())) {
      if (inCode) flushCode();
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = Math.min(6, heading[1].length);
      blocks.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }
    const bullet = line.match(/^\s*[-*+]\s+(.+)$/);
    if (bullet) {
      blocks.push(`<p class="bullet">${inlineMarkdown(bullet[1])}</p>`);
      continue;
    }
    const numbered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (numbered) {
      blocks.push(`<p class="numbered">${inlineMarkdown(numbered[1])}</p>`);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      blocks.push(`<pre class="table">${escapeHtml(line)}</pre>`);
      continue;
    }
    if (line.trim()) blocks.push(`<p>${inlineMarkdown(line)}</p>`);
  }
  if (inCode) flushCode();

  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
@page { size: A4; margin: 17mm 16mm; }
body { color: #141a22; font-family: "Microsoft YaHei", "Noto Sans CJK SC", Arial, sans-serif; font-size: 10.5pt; line-height: 1.62; }
h1 { font-size: 20pt; margin: 0 0 12pt; } h2 { font-size: 15pt; margin: 20pt 0 8pt; } h3 { font-size: 12pt; margin: 16pt 0 6pt; }
h4, h5, h6 { font-size: 10.5pt; margin: 12pt 0 4pt; } p { margin: 0 0 7pt; } .bullet, .numbered { padding-left: 14pt; text-indent: -10pt; }
.bullet::before { content: "- "; } .numbered::before { content: "# "; } code, .code, .table { font-family: Consolas, "Courier New", monospace; }
.code, .table { white-space: pre-wrap; background: #f4f6f8; border: 1px solid #d6dce3; padding: 7pt; margin: 8pt 0; font-size: 8.5pt; line-height: 1.4; }
</style></head><body>${blocks.join('\n')}</body></html>`;
}

async function renderAnalysisPdf({ sourcePath, outputPath, createWindow }) {
  const source = await fsp.readFile(sourcePath, 'utf8');
  const window = createWindow();
  if (!window?.webContents || typeof window.loadURL !== 'function') throw new Error('PDF_RENDERER_UNAVAILABLE');
  try {
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(markdownToPrintHtml(source))}`);
    if (typeof window.webContents.executeJavaScript === 'function') {
      await window.webContents.executeJavaScript('document.fonts ? document.fonts.ready : Promise.resolve()', true);
    }
    const pdf = await window.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
    });
    if (!Buffer.isBuffer(pdf) || pdf.length < 1024 || pdf.subarray(0, 5).toString('ascii') !== '%PDF-') {
      throw new Error('PDF_RENDER_FAILED');
    }
    await fsp.mkdir(path.dirname(outputPath), { recursive: true });
    await fsp.writeFile(outputPath, pdf);
    return { path: outputPath, bytes: pdf.length };
  } finally {
    if (typeof window.destroy === 'function' && !window.isDestroyed?.()) window.destroy();
  }
}

module.exports = {
  escapeHtml,
  markdownToPrintHtml,
  renderAnalysisPdf,
};
