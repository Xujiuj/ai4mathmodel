import {
  ArrowRight,
  FileInput,
  FolderOpen,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { StatusPill } from './Shell.jsx';

const stageContent = {
  analysis: { title: '赛题解析', description: '集中查看赛题材料、问题拆解和建模方案。', prefixes: ['inputs/', 'work/01_analysis/'] },
  solving: { title: '模型求解', description: '集中查看关键代码、实验数据、结果表与图。', prefixes: ['work/01_analysis/', 'work/02_solving/'] },
  paper: { title: '论文撰写', description: '集中查看论文源文件、证据清单、参考文献与编译结果。', prefixes: ['work/01_analysis/literature/', 'work/02_solving/', 'work/03_paper/'] },
  review: { title: '质量审查', description: '集中查看论文、编译结果和最终质量报告。', prefixes: ['work/03_paper/', 'work/04_review/'] },
};

function formatBytes(size) {
  if (!Number.isFinite(size)) return '大小未知';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function StageWorkspace({ project, stage, snapshot, onOpenFile, onPickFiles, onDropFiles }) {
  const content = stageContent[stage] || stageContent.analysis;
  const [dragging, setDragging] = useState(false);
  const files = useMemo(() => (snapshot?.files || []).filter((file) => content.prefixes.some((prefix) => file.relative.startsWith(prefix))).slice(0, 100), [content.prefixes, snapshot?.files]);
  const status = snapshot?.stages?.find((item) => item.key === stage)?.uiStatus || 'pending';
  return (
    <section className="stage-workspace">
      <header className="stage-workspace-header">
        <div><span className="stage-kicker">{project?.name || '当前项目'} · 求解进度</span><h1>{content.title}</h1><p>{content.description}</p></div>
        <StatusPill status={status === 'completed' ? 'success' : status === 'active' ? 'active' : 'neutral'}>{status === 'completed' ? '已完成' : status === 'active' ? '进行中' : '等待处理'}</StatusPill>
      </header>
      <div className="work-items-table">
        <div className="work-table-header"><span>#</span><span>项目文件</span><span>相对路径</span><span>修改时间</span><span>大小</span><span>阶段状态</span><span>操作</span></div>
        {files.map((file, index) => (
          <article key={file.path}>
            <span>{index + 1}</span>
            <div><strong>{file.name}</strong><small>{file.ext || '无扩展名'}</small></div>
            <span className="work-file"><FileInput size={14} />{file.relative}</span>
            <span className="work-file">{new Date(file.modifiedAt).toLocaleString('zh-CN')}</span>
            <span className="checkpoint">{formatBytes(file.size)}</span>
            <StatusPill status={status === 'completed' ? 'success' : status === 'active' ? 'active' : 'neutral'}>{status === 'completed' ? '已完成' : status === 'active' ? '进行中' : '待运行'}</StatusPill>
            <button className="row-action" onClick={() => onOpenFile(file)}>打开<ArrowRight size={13} /></button>
          </article>
        ))}
        {!files.length ? <div className="stage-file-empty">当前阶段尚未生成或收录文件。</div> : null}
      </div>
      <div
        className={`stage-drop-zone ${dragging ? 'dragging' : ''}`}
        onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false); }}
        onDrop={(event) => { event.preventDefault(); setDragging(false); onDropFiles([...event.dataTransfer.files]); }}
      >
        <FolderOpen size={17} />
        <span>{dragging ? '松开以导入项目输入文件' : '将文件拖到此处导入项目输入，或'}</span>
        <div className="stage-drop-actions">
          <button onClick={() => onPickFiles?.('problem')}>选择赛题</button>
          <button onClick={() => onPickFiles?.('template')}>选择模板</button>
        </div>
      </div>
    </section>
  );
}
