import {
  BookOpenCheck,
  Check,
  ChevronRight,
  FileImage,
  FileSearch,
  FileText,
  Play,
  ShieldCheck,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { IconButton, StatusPill } from './Shell.jsx';

const inspectorTabs = [
  ['provenance', '项目数据'],
  ['figures', '图表文件'],
  ['citations', '参考文献'],
  ['compile', '审计报告'],
];

const DATA_EXTENSIONS = new Set(['.csv', '.json', '.yaml', '.yml', '.xlsx', '.xls']);

function formatBytes(size) {
  if (!Number.isFinite(size)) return '大小未知';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function EmptyInspection({ title, detail }) {
  return <div className="inspection-empty"><FileSearch size={24} strokeWidth={1.4} /><strong>{title}</strong><p>{detail}</p></div>;
}

function ProvenancePanel({ selectedEvidence, onSelect, files, onOpenFile }) {
  const records = files.filter((file) => DATA_EXTENSIONS.has(file.ext)).slice(0, 40);
  const current = records.find((item) => item.path === selectedEvidence) || records[0];
  if (!records.length) return <EmptyInspection title="未找到结构化数据文件" detail="运行求解阶段后，CSV、YAML、JSON 和表格数据会显示在这里。" />;
  return (
    <div className="inspector-content">
      <section className="selected-claim">
        <header><span>当前数据文件</span><StatusPill status="neutral">项目文件</StatusPill></header>
        <p><strong>{current.name}</strong><br />{current.relative}<br />{formatBytes(current.size)}</p>
      </section>
      <section className="inspector-section">
        <h3>可用数据</h3>
        <div className="provenance-chain">
          {records.map((item, index) => (
            <button key={item.path} className={item.path === current.path ? 'active' : ''} onClick={() => { onSelect(item.path); onOpenFile(item); }}>
              <span className="chain-index">{index + 1}</span>
              <span className="chain-copy"><strong>{item.name}</strong><small>{item.relative}</small><em>{formatBytes(item.size)} · {new Date(item.modifiedAt).toLocaleString('zh-CN')}</em></span>
              <ChevronRight size={14} />
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function FiguresPanel({ figures = [], onSelectFigure, onOpenReview }) {
  if (!figures.length) return <EmptyInspection title="未找到图表文件" detail="论文目录中的图片将在这里列出，可直接在工作区预览。" />;
  return (
    <div className="inspector-content figure-inspector">
      <div className="inspector-summary"><ShieldCheck size={17} /><div><strong>{figures.length} 幅图已找到</strong><span>状态以质量审计报告为准</span></div></div>
      {figures.slice(0, 24).map((figure, index) => (
        <button key={figure.path || figure.name} className="figure-review-row" onClick={() => onSelectFigure?.(figure)}>
          <div className="figure-thumb">{figure.url ? <img src={figure.url} alt="" /> : <FileImage size={22} />}</div>
          <div><strong>图 {index + 1} {figure.name.replace(/\.[^.]+$/, '')}</strong><small>{figure.relative || figure.name}</small></div>
          <StatusPill status="neutral">可预览</StatusPill>
        </button>
      ))}
      <button className="inspector-full-action" onClick={onOpenReview}><FileImage size={14} />打开图表审阅器</button>
    </div>
  );
}

function CitationsPanel({ files, onOpenFile }) {
  const bibliography = files.find((file) => file.ext === '.bib');
  return (
    <div className="inspector-content">
      <div className="inspector-summary"><BookOpenCheck size={17} /><div><strong>{bibliography ? '已找到参考文献文件' : '未找到参考文献文件'}</strong><span>{bibliography ? bibliography.relative : '将 .bib 文件置于项目目录后可在此查看。'}</span></div></div>
      <section className="quality-list">
        <article><FileText /><div><strong>质量结论由审计生成</strong><small>引用数量、期刊会议占比与占位符检查不会在界面中预置。</small></div></article>
      </section>
      <button className="inspector-full-action" onClick={() => bibliography && onOpenFile(bibliography)} disabled={!bibliography}><BookOpenCheck size={14} />{bibliography ? '查看参考文献清单' : '未找到参考文献文件'}</button>
    </div>
  );
}

function CompilePanel({ auditText, onRunAudit }) {
  if (!auditText?.trim()) {
    return <div className="inspector-content"><EmptyInspection title="尚未生成审计报告" detail="运行“全部检查”后，此处会显示项目实际产生的审计结果。" /><button className="inspector-full-action" onClick={onRunAudit}><Play size={14} />运行全部检查</button></div>;
  }
  return (
    <div className="inspector-content">
      <div className="inspector-summary"><Check size={17} /><div><strong>项目审计报告</strong><span>以下内容直接读取自项目中的审计文件</span></div></div>
      <div className="audit-markdown"><ReactMarkdown>{auditText}</ReactMarkdown></div>
      <button className="inspector-full-action" onClick={onRunAudit}><Play size={14} />重新运行全部检查</button>
    </div>
  );
}

export function Inspector({ activeTab, setActiveTab, selectedEvidence, onEvidenceSelect, figures, auditText, files = [], onOpenFile, onSelectFigure, onOpenFigureReview, onRunAudit }) {
  return (
    <aside className="inspector-panel" aria-label="项目检查器">
      <div className="inspector-tabs">
        {inspectorTabs.map(([key, label]) => <button key={key} className={activeTab === key ? 'active' : ''} onClick={() => setActiveTab(key)}>{label}</button>)}
      </div>
      {activeTab === 'provenance' ? <ProvenancePanel selectedEvidence={selectedEvidence} onSelect={onEvidenceSelect} files={files} onOpenFile={onOpenFile} /> : null}
      {activeTab === 'figures' ? <FiguresPanel figures={figures} onSelectFigure={onSelectFigure} onOpenReview={onOpenFigureReview} /> : null}
      {activeTab === 'citations' ? <CitationsPanel files={files} onOpenFile={onOpenFile} /> : null}
      {activeTab === 'compile' ? <CompilePanel auditText={auditText} onRunAudit={onRunAudit} /> : null}
    </aside>
  );
}
