'use strict';

const MAX_DOCUMENT_CHARS = 120_000;
const SUPPORTED_DOCUMENT_EXTENSIONS = Object.freeze(new Set(['.pdf', '.docx']));

// The Python runtime is bundled with the desktop app. Keep this script self-contained
// so it can run through the existing isolated Python process launcher.
const DOCUMENT_INSPECTOR = String.raw`import json, sys
from pathlib import Path

MAX_CHARS = 120000
MIN_PAGE_TEXT = 24
MIN_DOCUMENT_TEXT = 48

source = Path(sys.argv[1])
suffix = source.suffix.lower()

def normalise(value):
    return ' '.join(str(value or '').replace('\u00a0', ' ').split())

def clipped(value):
    value = str(value or '')
    return value[:MAX_CHARS], len(value) > MAX_CHARS

def extract_docx():
    from docx import Document
    document = Document(str(source))
    sections = []
    for paragraph in document.paragraphs:
        text = paragraph.text.strip()
        if text:
            sections.append(text)
    for table_index, table in enumerate(document.tables, 1):
        rows = []
        for row in table.rows:
            cells = [normalise(cell.text) for cell in row.cells]
            if any(cells):
                rows.append('| ' + ' | '.join(cells) + ' |')
        if rows:
            sections.append('Table %d:' % table_index)
            sections.extend(rows)
    return '\n\n'.join(sections)

def ocr_page(page, engine):
    import pymupdf
    pixmap = page.get_pixmap(matrix=pymupdf.Matrix(2, 2), alpha=False)
    result, _ = engine(pixmap.tobytes('png'))
    lines = []
    for item in result or []:
        if len(item) < 2:
            continue
        text = str(item[1] or '').strip()
        score = float(item[2]) if len(item) > 2 else 1.0
        if text and score >= 0.35:
            lines.append(text)
    return '\n'.join(lines)

def extract_pdf():
    try:
        from pypdf import PdfReader
        reader = PdfReader(str(source))
        page_texts = [page.extract_text() or '' for page in reader.pages]
    except Exception:
        page_texts = []
    page_count = len(page_texts)

    # Some malformed PDFs expose no usable text through pypdf; use PyMuPDF's
    # text layer before paying the OCR cost.
    if page_count == 0 or not any(normalise(text) for text in page_texts):
        import pymupdf
        with pymupdf.open(str(source)) as document:
            page_texts = [page.get_text('text') or '' for page in document]
            page_count = len(page_texts)

    joined = '\n\n'.join(page_texts)
    sparse_pages = [index for index, text in enumerate(page_texts) if len(normalise(text)) < MIN_PAGE_TEXT]
    if len(normalise(joined)) < MIN_DOCUMENT_TEXT:
        sparse_pages = list(range(page_count))

    ocr_pages = []
    if sparse_pages:
        try:
            import pymupdf
            from rapidocr_onnxruntime import RapidOCR
            engine = RapidOCR()
        except Exception:
            return '\n\n'.join(page_texts), ocr_pages
        with pymupdf.open(str(source)) as document:
            for index in sparse_pages:
                if index >= len(document):
                    continue
                try:
                    ocr_text = ocr_page(document[index], engine)
                except Exception:
                    continue
                if len(normalise(ocr_text)) > len(normalise(page_texts[index])):
                    page_texts[index] = ocr_text
                    ocr_pages.append(index + 1)
    return '\n\n'.join(page_texts), ocr_pages

if suffix == '.pdf':
    text, ocr_pages = extract_pdf()
    payload = {'ok': True, 'text': clipped(text)[0], 'truncated': clipped(text)[1], 'ocrPages': ocr_pages}
elif suffix == '.docx':
    text = extract_docx()
    payload = {'ok': True, 'text': clipped(text)[0], 'truncated': clipped(text)[1], 'ocrPages': []}
else:
    raise ValueError('unsupported document type')

print(json.dumps(payload, ensure_ascii=False))`;

function isSupportedDocumentExtension(extension) {
  return SUPPORTED_DOCUMENT_EXTENSIONS.has(String(extension || '').toLowerCase());
}

function parseInspectorOutput(output) {
  const lines = String(output || '').trim().split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index]);
      if (!parsed || parsed.ok !== true) continue;
      return {
        ok: true,
        text: String(parsed.text || '').slice(0, MAX_DOCUMENT_CHARS),
        truncated: Boolean(parsed.truncated) || String(parsed.text || '').length > MAX_DOCUMENT_CHARS,
        ocrPages: Array.isArray(parsed.ocrPages) ? parsed.ocrPages : [],
      };
    } catch {
      // Runtime libraries may write diagnostic lines before the JSON payload.
    }
  }
  return null;
}

module.exports = {
  DOCUMENT_INSPECTOR,
  MAX_DOCUMENT_CHARS,
  SUPPORTED_DOCUMENT_EXTENSIONS,
  isSupportedDocumentExtension,
  parseInspectorOutput,
};
