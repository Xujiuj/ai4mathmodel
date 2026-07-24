import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Circle,
  Plus,
  Pause,
  Play,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { useEffect, useRef } from 'react';
import { CommandButton, IconButton } from './Shell.jsx';

const tabs = [['logs', '运行日志'], ['restore', '恢复与回滚']];

function logIcon(level) {
  if (level === 'warning' || level === 'stderr') return <AlertTriangle size={13} />;
  if (level === 'success') return <CheckCircle2 size={13} />;
  return <Circle size={8} fill="currentColor" />;
}

export function RunDrawer({ open, setOpen, tab, setTab, logs, running, onStop, onRestart, onClear, checkpoints = [], onCreateCheckpoint, onRestoreCheckpoint }) {
  const drawerRef = useRef(null);
  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => drawerRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);
  if (!open) {
    return (
      <button className="drawer-collapsed" onClick={() => setOpen(true)}>
        <ChevronUp size={14} /><span>运行与检查</span><em>{running ? '正在运行' : `${logs.length} 条记录`}</em>
      </button>
    );
  }
  return (
    <section className="run-drawer" aria-label="运行日志与恢复" tabIndex={-1} ref={drawerRef}>
      <div className="drawer-tabs">
        {tabs.map(([key, label]) => <button key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}</button>)}
        <div className="drawer-tabs-actions"><IconButton label="清空日志" onClick={onClear}><Trash2 size={14} /></IconButton><IconButton label="收起" onClick={() => setOpen(false)}><ChevronDown size={14} /></IconButton></div>
      </div>
      {tab === 'logs' ? (
        <div className="drawer-body logs-body">
          <div className="log-list">
            {logs.length ? logs.slice(-30).map((log, index) => (
              <div key={`${log.at}-${index}`} className={`log-row log-${log.level || log.stream || 'info'}`}>
                <time>{log.at}</time><span className="log-kind">{logIcon(log.level || log.stream)}</span><p>{log.text}</p>
              </div>
            )) : <p className="drawer-empty">当前没有运行记录。</p>}
          </div>
          <aside className="drawer-actions">
            <strong>{running ? '任务执行中' : '执行器空闲'}</strong>
            <CommandButton icon={Pause} onClick={onStop} disabled={!running}>安全停止</CommandButton>
            <CommandButton icon={Play} tone="primary" onClick={onRestart} disabled={running}>重新开始求解</CommandButton>
            <CommandButton icon={RotateCcw} onClick={() => setTab('restore')}>从检查点恢复</CommandButton>
          </aside>
        </div>
      ) : null}
      {tab === 'restore' ? (
        <div className="drawer-body restore-list">
          <div className="restore-toolbar"><span>仅备份论文文本源文件</span><CommandButton icon={Plus} onClick={onCreateCheckpoint}>创建检查点</CommandButton></div>
          {checkpoints.map((item, index) => (
            <article key={item.id}><span className="restore-index">#{checkpoints.length - index}</span><div><strong>{item.label}</strong><small>{new Date(item.createdAt).toLocaleString('zh-CN', { hour12: false })} · {item.fileCount} 个文件</small></div><button onClick={() => onRestoreCheckpoint(item)}><RotateCcw size={13} />恢复</button></article>
          ))}
          {!checkpoints.length ? <p className="drawer-empty">尚未创建论文源文件检查点。</p> : null}
        </div>
      ) : null}
    </section>
  );
}
