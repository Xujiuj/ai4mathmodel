'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');

const MAX_DOCX_BYTES = 64 * 1024 * 1024;

const DOCX_CONVERTER_SOURCE = String.raw`from docx import Document
import re
import sys
from pathlib import Path

source = Path(sys.argv[1])
target = Path(sys.argv[2])
text = source.read_text(encoding='utf-8', errors='replace')
text = re.sub(r'(?m)(?<!\\)%.*$', '', text)

def clean(fragment):
    value = fragment
    for _ in range(4):
        value = re.sub(r'\\(?:textbf|textit|emph|underline|mathrm|mathbf)\s*\{([^{}]*)\}', r'\1', value)
    value = re.sub(r'\\(?:begin|end)\s*\{[^{}]*\}', '\n', value)
    value = re.sub(r'\\(?:cite|ref|label)\s*\{([^{}]*)\}', r'[\1]', value)
    value = re.sub(r'\\item\b', '\n- ', value)
    value = re.sub(r'\\[a-zA-Z@]+\*?(?:\s*\[[^]]*\])?', '', value)
    value = value.replace('\\\\', '\n')
    value = re.sub(r'[{}$]', '', value)
    value = re.sub(r'[ \t]+', ' ', value)
    value = re.sub(r'\n\s*\n+', '\n\n', value)
    return value.strip()

document = Document()
title = re.search(r'\\title\s*\{([^{}]*)\}', text)
document.add_heading(clean(title.group(1)) if title else 'Mathematical Modeling Report', level=0)

section_pattern = re.compile(r'\\(section|subsection|subsubsection)\*?\s*\{([^{}]*)\}')
cursor = 0
for match in section_pattern.finditer(text):
    body = clean(text[cursor:match.start()])
    if body:
        for paragraph in body.split('\n\n'):
            if paragraph.strip():
                document.add_paragraph(paragraph.strip())
    level = {'section': 1, 'subsection': 2, 'subsubsection': 3}[match.group(1)]
    heading = clean(match.group(2))
    if heading:
        document.add_heading(heading, level=level)
    cursor = match.end()

tail = clean(text[cursor:])
if tail:
    for paragraph in tail.split('\n\n'):
        if paragraph.strip():
            document.add_paragraph(paragraph.strip())

document.save(str(target))
Document(str(target))`;

async function isValidDocx(file) {
  const stat = await fsp.stat(file).catch(() => null);
  if (!stat?.isFile() || stat.size < 200 || stat.size > MAX_DOCX_BYTES) return false;
  const handle = await fsp.open(file, 'r');
  try {
    const header = Buffer.alloc(4);
    await handle.read(header, 0, header.length, 0);
    if (!header.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return false;
    const tailSize = Math.min(stat.size, 1024 * 1024);
    const tail = Buffer.alloc(tailSize);
    await handle.read(tail, 0, tailSize, stat.size - tailSize);
    return tail.includes(Buffer.from('word/document.xml'))
      && tail.includes(Buffer.from('[Content_Types].xml'))
      && tail.includes(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  } finally {
    await handle.close();
  }
}

async function convertPaperToDocx({ sourcePath, outputPath, runPython } = {}) {
  if (!path.isAbsolute(sourcePath || '') || !path.isAbsolute(outputPath || '') || typeof runPython !== 'function') {
    throw new TypeError('DOCX conversion requires absolute source/output paths and a Python runner.');
  }
  const temporary = `${outputPath}.${process.pid}.${Date.now()}.tmp.docx`;
  try {
    const result = await runPython(['-c', DOCX_CONVERTER_SOURCE, sourcePath, temporary]);
    if (result?.code !== 0) {
      await fsp.rm(outputPath, { force: true }).catch(() => {});
      return { ok: false, detail: `${result?.stderr || ''}${result?.stdout || ''}` };
    }
    if (!await isValidDocx(temporary)) {
      await fsp.rm(outputPath, { force: true }).catch(() => {});
      return { ok: false, detail: 'python-docx did not generate a valid DOCX package.' };
    }
    await fsp.rm(outputPath, { force: true });
    await fsp.rename(temporary, outputPath);
    return { ok: true, path: outputPath };
  } finally {
    await fsp.rm(temporary, { force: true }).catch(() => {});
  }
}

module.exports = {
  DOCX_CONVERTER_SOURCE,
  MAX_DOCX_BYTES,
  convertPaperToDocx,
  isValidDocx,
};
