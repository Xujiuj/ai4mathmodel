import CodeMirror from '@uiw/react-codemirror';
import ReactMarkdown from 'react-markdown';
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
import { useCallback, useEffect, useRef, useState } from 'react';
import { IMAGE_PREVIEW_EXTENSIONS } from '../fileTypes.js';
import { CommandButton, IconButton, StatusPill } from './Shell.jsx';

const TEXT_EXTENSIONS = new Set(['.tex', '.md', '.py', '.yaml', '.yml', '.bib', '.json', '.csv', '.txt', '.log', '.js', '.jsx', '.ts', '.tsx', '.r', '.m', '.c', '.cc', '.cpp', '.h', '.hpp', '.java', '.sh', '.ps1', '.bat', '.cmd', '.toml', '.ini', '.cfg', '.conf', '.xml', '.html', '.css', '.sql', '.rst']);
const SPREADSHEET_EXTENSIONS = new Set(['.csv', '.xlsx']);

const PDF_LOAD_TIMEOUT_MS = 8000;

function NativePdfPreview({ src, title, onOpenFile }) {
  const [state, setState] = useState('loading');
  const frameRef = useRef(null);
  const timeoutRef = useRef(null);

  useEffect(() => {
    setState('loading');
    timeoutRef.current = window.setTimeout(() => {
      timeoutRef.current = null;
      setState('timeout');
    }, PDF_LOAD_TIMEOUT_MS);
    return () => {
      if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    };
  }, [src]);

  const markLoaded = () => {
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
    setState('loaded');
  };
  const markFailed = () => {
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
    setState('error');
  };
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return undefined;
    frame.addEventListener('error', markFailed);
    return () => frame.removeEventListener('error', markFailed);
  }, [src]);
  const statusCopy = state === 'timeout'
    ? { heading: 'PDF 加载超时', detail: '预览仍未响应，请使用系统程序打开文件。' }
    : state === 'error'
      ? { heading: 'PDF 无法加载', detail: '预览窗口无法读取此文件，请使用系统程序打开文件。' }
      : { heading: 'PDF 正在加载', detail: '正在准备文档预览，请稍候。' };

  return (
    <div className="native-pdf-preview" data-pdf-state={state} data-pdf-timeout-ms={PDF_LOAD_TIMEOUT_MS} aria-busy={state === 'loading'}>
      <iframe ref={frameRef} className="native-pdf" src={src} title={title} onLoadStart={() => setState('loading')} onLoad={markLoaded} onError={markFailed} />
      {state !== 'loaded' ? (
        <div className={`native-pdf-status native-pdf-status-${state}`} role={state === 'loading' ? 'status' : 'alert'} aria-live={state === 'loading' ? 'polite' : 'assertive'}>
          <FileText size={25} strokeWidth={1.4} aria-hidden="true" />
          <strong>{statusCopy.heading}</strong>
          <p>{statusCopy.detail}</p>
          {state === 'error' || state === 'timeout' ? <CommandButton className="native-pdf-recovery" icon={ExternalLink} onClick={onOpenFile}>使用系统程序打开 PDF</CommandButton> : null}
        </div>
      ) : null}
    </div>
  );
}

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
  onSaveError,
  paper,
  figureUrl,
  spreadsheet,
  pdfUrl,
  onOpenPdf,
  onOpenSelectedFile,
  autoSave,
  theme,
  pdfFocus = false,
}) {
  const [dirty, setDirty] = useState(false);
  const [zoom, setZoom] = useState(100);
  const extension = selectedFile?.ext?.toLowerCase() || '';
  const isImage = IMAGE_PREVIEW_EXTENSIONS.has(extension);
  const isSpreadsheet = SPREADSHEET_EXTENSIONS.has(extension);
  const isText = selectedFile?.previewKind === 'text' || TEXT_EXTENSIONS.has(extension);
  const isPdf = extension === '.pdf';
  const isMarkdown = extension === '.md';
  const canCompare = Boolean(compareSourceFile && pdfUrl);
  const previewLabel = isSpreadsheet ? '表格预览' : isImage ? '图像预览' : isMarkdown ? 'Markdown 预览' : '原始文件预览';

  useEffect(() => setDirty(false), [selectedFile?.path]);

  const updateLatex = (value) => {
    setLatex(value);
    setDirty(true);
  };
  const save = useCallback(async () => {
    try {
      await onSave();
      setDirty(false);
    } catch (error) {
      onSaveError?.(error);
    }
  }, [onSave, onSaveError]);

  useEffect(() => {
    if (!dirty || !autoSave) return undefined;
    const timer = window.setTimeout(() => { void save(); }, 1200);
    return () => window.clearTimeout(timer);
  }, [autoSave, dirty, latex, save]);

  if (pdfFocus && pdfUrl) {
    return (
      <section className="document-workspace pdf-document-workspace" aria-label="PDF 预览">
        <NativePdfPreview key={pdfUrl} src={pdfUrl} title={selectedFile?.name || 'PDF 预览'} onOpenFile={onOpenPdf} />
      </section>
    );
  }

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
            {isPdf && pdfUrl ? <NativePdfPreview key={pdfUrl} src={pdfUrl} title={selectedFile?.name || 'PDF 预览'} onOpenFile={onOpenPdf} /> : null}
            {isImage && figureUrl ? <div className="image-preview-canvas"><img src={figureUrl} alt={selectedFile?.name || '项目图片'} style={{ width: `${zoom}%` }} /></div> : null}
            {isSpreadsheet && spreadsheet ? <SpreadsheetPreview spreadsheet={spreadsheet} selectedFile={selectedFile} onOpenFile={onOpenSelectedFile} /> : null}
            {isMarkdown ? <article className="markdown-paper"><ReactMarkdown>{latex}</ReactMarkdown></article> : null}
            {(!isPdf || !pdfUrl) && (!isImage || !figureUrl) && (!isSpreadsheet || !spreadsheet) && !isMarkdown ? <PreviewEmpty file={selectedFile} onOpenFile={onOpenSelectedFile} /> : null}
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
          <div className="compare-preview">{pdfUrl ? <NativePdfPreview key={pdfUrl} src={pdfUrl} title="PDF 对照预览" onOpenFile={onOpenPdf} /> : <PreviewEmpty file={paper?.pdf} onOpenFile={onOpenPdf} />}</div>
          <div className="compare-source">
            <div className="source-toolbar"><span>{compareSourceFile?.relative}</span><IconButton label="保存" onClick={save}><Save size={15} /></IconButton></div>
            <CodeMirror value={latex} height="100%" theme={theme} onChange={updateLatex} basicSetup={{ lineNumbers: true, foldGutter: false }} />
          </div>
        </div>
      ) : null}
    </section>
  );
}

export function PaperCommandBar({ onCompile, onAudit, onExportPdf, onExportTex, onExportMarkdown, onExportDocx, onReveal, onOpen, running, hasPdf, hasTex, hasMarkdown, hasDocx, markdownEnabled }) {
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
        {markdownEnabled || hasMarkdown ? <CommandButton icon={FileText} onClick={onExportMarkdown} disabled={!hasMarkdown} title={hasMarkdown ? undefined : '尚未生成 Markdown 源文件'}>导出Markdown</CommandButton> : null}
        <CommandButton icon={FileText} onClick={onExportDocx} disabled={!hasDocx} title={hasDocx ? undefined : '尚未生成 DOCX 文件'}>导出DOCX</CommandButton>
      </div>
      <div className="command-cluster reveal-cluster">
        <span>打开位置</span>
        <CommandButton icon={FolderOpen} onClick={onReveal} disabled={!hasPdf} title={hasPdf ? undefined : '尚未生成 PDF'}>输出文件夹</CommandButton>
        <CommandButton icon={ExternalLink} onClick={onOpen} disabled={!hasPdf} title={hasPdf ? undefined : '尚未生成 PDF'}>打开PDF</CommandButton>
      </div>
    </footer>
  );
}
