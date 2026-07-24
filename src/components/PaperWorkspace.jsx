import CodeMirror from '@uiw/react-codemirror';
import {
  Braces,
  Check,
  Columns2,
  Download,
  ExternalLink,
  FileCheck2,
  FileCode2,
  FileText,
  FolderOpen,
  Maximize2,
  Minus,
  Plus,
  RefreshCw,
  Save,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { CommandButton, IconButton, StatusPill } from './Shell.jsx';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']);
const TEXT_EXTENSIONS = new Set(['.tex', '.md', '.py', '.yaml', '.yml', '.bib', '.json', '.csv', '.txt', '.log', '.js', '.jsx', '.ts', '.tsx', '.r', '.m', '.c', '.cc', '.cpp', '.h', '.hpp', '.java', '.sh', '.ps1', '.bat', '.cmd', '.toml', '.ini', '.cfg', '.conf', '.xml', '.html', '.css', '.sql', '.rst']);
const SPREADSHEET_EXTENSIONS = new Set(['.csv', '.xlsx']);

function PreviewToolbar({ imagePreview, previewLabel, zoom, setZoom, onOpenFile, canOpen }) {
  return (
    <div className="preview-toolbar">
      <div><span className="preview-mode-label">{previewLabel}</span></div>
      <div className="preview-center-controls">
        <IconButton label="缩小" onClick={() => setZoom((value) => Math.max(30, value - 10))} disabled={!imagePreview}><Minus size={14} /></IconButton>
        <button className="zoom-value" onClick={() => setZoom(100)} disabled={!imagePreview} title="恢复 100%">{zoom}%</button>
        <IconButton label="放大" onClick={() => setZoom((value) => Math.min(200, value + 10))} disabled={!imagePreview}><Plus size={14} /></IconButton>
        <IconButton label="适合页面" onClick={() => setZoom(100)} disabled={!imagePreview}><Maximize2 size={15} /></IconButton>
      </div>
      <div>
        <IconButton label="使用系统程序打开" onClick={onOpenFile} disabled={!canOpen}><ExternalLink size={15} /></IconButton>
      </div>
    </div>
  );
}

function SpreadsheetPreview({ spreadsheet, selectedFile, onOpenFile }) {
  const [sheetIndex, setSheetIndex] = useState(0);
  useEffect(() => setSheetIndex(0), [selectedFile?.path]);
  const sheet = spreadsheet?.sheets?.[sheetIndex];
  if (!sheet) return <PreviewEmpty file={selectedFile} onOpenFile={onOpenFile} />;
  const [headers = [], ...body] = sheet.rows;
  return (
    <div className="spreadsheet-preview">
      <header className="spreadsheet-toolbar">
        <div className="spreadsheet-tabs" role="tablist" aria-label="工作表">
          {spreadsheet.sheets.map((item, index) => <button key={item.name} role="tab" aria-selected={index === sheetIndex} className={index === sheetIndex ? 'active' : ''} onClick={() => setSheetIndex(index)}>{item.name}</button>)}
        </div>
        <span>{sheet.totalRows} 行 · {sheet.totalColumns} 列{sheet.truncated ? ` · 仅显示前 ${spreadsheet.limits.rows} 行和 ${spreadsheet.limits.columns} 列` : ''}</span>
      </header>
      <div className="spreadsheet-grid-scroll">
        <table className="spreadsheet-grid">
          <thead><tr><th scope="col">#</th>{headers.map((value, index) => <th scope="col" key={index}>{value || `列 ${index + 1}`}</th>)}</tr></thead>
          <tbody>{body.map((row, rowIndex) => <tr key={rowIndex}><th scope="row">{rowIndex + 2}</th>{headers.map((_, columnIndex) => <td key={columnIndex}>{row[columnIndex] || ''}</td>)}</tr>)}</tbody>
        </table>
      </div>
      {spreadsheet.truncatedSheets ? <p className="spreadsheet-note">工作簿包含更多工作表，当前仅显示前 12 个。</p> : null}
    </div>
  );
}

function PreviewEmpty({ file, onOpenFile }) {
  return (
    <div className="file-preview-empty">
      <FileText size={28} strokeWidth={1.4} />
      <strong>{file?.name || '未选择文件'}</strong>
      <p>{file ? '该文件可通过系统关联程序打开；文本、图片和 PDF 可在工作区直接预览。' : '请从项目资料中选择一个文件。'}</p>
      {file ? <CommandButton icon={ExternalLink} onClick={onOpenFile}>使用系统程序打开</CommandButton> : null}
    </div>
  );
}

export function PaperWorkspace({
  view,
  setView,
  selectedFile,
  compareSourceFile,
  latex,
  setLatex,
  onSave,
  paper,
  figureUrl,
  spreadsheet,
  pdfUrl,
  onOpenPdf,
  onOpenSelectedFile,
  autoSave,
  theme,
}) {
  const [dirty, setDirty] = useState(false);
  const [zoom, setZoom] = useState(100);
  const extension = selectedFile?.ext?.toLowerCase() || '';
  const isImage = IMAGE_EXTENSIONS.has(extension);
  const isSpreadsheet = SPREADSHEET_EXTENSIONS.has(extension);
  const isText = selectedFile?.previewKind === 'text' || TEXT_EXTENSIONS.has(extension);
  const isPdf = extension === '.pdf';
  const canCompare = Boolean(compareSourceFile && pdfUrl);
  const previewLabel = isSpreadsheet ? '表格预览' : isImage ? '图像预览' : '原始文件预览';

  useEffect(() => setDirty(false), [selectedFile?.path]);

  const updateLatex = (value) => {
    setLatex(value);
    setDirty(true);
  };
  const save = useCallback(async () => {
    await onSave();
    setDirty(false);
  }, [onSave]);

  useEffect(() => {
    if (!dirty || !autoSave) return undefined;
    const timer = window.setTimeout(() => save(), 1200);
    return () => window.clearTimeout(timer);
  }, [autoSave, dirty, latex, save]);

  return (
    <section className="document-workspace" aria-label="论文工作区">
      <div className="document-tabs">
        <button className={view === 'preview' ? 'active' : ''} onClick={() => setView('preview')}><FileText size={14} />文件预览</button>
        <button className={view === 'source' ? 'active' : ''} onClick={() => isText && setView('source')} disabled={!isText}><FileCode2 size={14} />文本编辑</button>
        <button className={view === 'compare' ? 'active' : ''} onClick={() => canCompare && setView('compare')} disabled={!canCompare}><Columns2 size={14} />对照模式</button>
        <div className="document-tab-status">
          {isText ? (dirty ? <StatusPill status="warning">未保存</StatusPill> : <StatusPill status="success"><Check size={11} />已同步</StatusPill>) : null}
          <span>{selectedFile?.relative || paper?.pdf?.relative || '未选择文件'}</span>
        </div>
      </div>

      {view === 'preview' ? (
        <div className="preview-surface">
          <PreviewToolbar imagePreview={isImage && Boolean(figureUrl)} previewLabel={previewLabel} zoom={zoom} setZoom={setZoom} onOpenFile={isPdf ? onOpenPdf : onOpenSelectedFile} canOpen={Boolean(selectedFile)} />
          <div className="paper-scroll">
            {isPdf && pdfUrl ? <iframe className="native-pdf" src={pdfUrl} title={selectedFile?.name || 'PDF 预览'} /> : null}
            {isImage && figureUrl ? <div className="image-preview-canvas"><img src={figureUrl} alt={selectedFile?.name || '项目图片'} style={{ width: `${zoom}%` }} /></div> : null}
            {isSpreadsheet && spreadsheet ? <SpreadsheetPreview spreadsheet={spreadsheet} selectedFile={selectedFile} onOpenFile={onOpenSelectedFile} /> : null}
            {(!isPdf || !pdfUrl) && (!isImage || !figureUrl) && (!isSpreadsheet || !spreadsheet) ? <PreviewEmpty file={selectedFile} onOpenFile={onOpenSelectedFile} /> : null}
          </div>
        </div>
      ) : null}

      {view === 'source' ? (
        <div className="source-surface">
          {isText ? <><div className="source-toolbar">
            <div><Braces size={14} /><span>{selectedFile?.relative}</span></div>
            <CommandButton icon={Save} tone={dirty ? 'primary' : 'default'} onClick={save}>保存</CommandButton>
          </div>
          <CodeMirror value={latex} height="100%" theme={theme} onChange={updateLatex} basicSetup={{ lineNumbers: true, foldGutter: true, highlightActiveLine: true }} /></> : <PreviewEmpty file={selectedFile} onOpenFile={onOpenSelectedFile} />}
        </div>
      ) : null}

      {view === 'compare' ? (
        <div className="compare-surface">
          <div className="compare-preview">{pdfUrl ? <iframe className="native-pdf" src={pdfUrl} title="PDF 对照预览" /> : <PreviewEmpty file={paper?.pdf} onOpenFile={onOpenPdf} />}</div>
          <div className="compare-source">
            <div className="source-toolbar"><span>{compareSourceFile?.relative}</span><IconButton label="保存" onClick={save}><Save size={15} /></IconButton></div>
            <CodeMirror value={latex} height="100%" theme={theme} onChange={updateLatex} basicSetup={{ lineNumbers: true, foldGutter: false }} />
          </div>
        </div>
      ) : null}
    </section>
  );
}

export function PaperCommandBar({ onCompile, onAudit, onExportPdf, onExportTex, onReveal, onOpen, running, hasPdf, hasTex }) {
  return (
    <footer className="paper-command-bar">
      <div className="command-cluster primary-cluster">
        <span>编译</span>
        <CommandButton tone="primary" icon={RefreshCw} onClick={onCompile} disabled={running}>{running ? '运行中' : '编译论文'}</CommandButton>
      </div>
      <div className="command-cluster">
        <span>审查</span>
        <CommandButton icon={FileCheck2} onClick={onAudit} disabled={running}>运行全部检查</CommandButton>
      </div>
      <div className="command-cluster export-cluster">
        <span>导出</span>
        <CommandButton icon={Download} onClick={onExportPdf} disabled={!hasPdf} title={hasPdf ? undefined : '尚未生成 PDF'}>导出PDF</CommandButton>
        <CommandButton icon={FileCode2} onClick={onExportTex} disabled={!hasTex} title={hasTex ? undefined : '尚未生成 LaTeX 源文件'}>导出LaTeX</CommandButton>
      </div>
      <div className="command-cluster reveal-cluster">
        <span>打开位置</span>
        <CommandButton icon={FolderOpen} onClick={onReveal} disabled={!hasPdf} title={hasPdf ? undefined : '尚未生成 PDF'}>输出文件夹</CommandButton>
        <CommandButton icon={ExternalLink} onClick={onOpen} disabled={!hasPdf} title={hasPdf ? undefined : '尚未生成 PDF'}>打开PDF</CommandButton>
      </div>
    </footer>
  );
}
