import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Circle,
  History,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { CommandButton, IconButton } from './Shell.jsx';

const tabs = [['logs', '运行日志'], ['history', '历史运行'], ['restore', '恢复与回滚']];
const resumableStatuses = new Set(['paused', 'running']);
const statusLabels = {
  completed: '已完成',
  running: '执行中',
  paused: '已暂停',
  cancelled: '已取消',
  failed: '失败',
  unknown: '状态未知',
};

function logIcon(level) {
  if (level === 'warning' || level === 'stderr') return <AlertTriangle size={13} />;
  if (level === 'success') return <CheckCircle2 size={13} />;
  return <Circle size={8} fill="currentColor" />;
}

function dateLabel(value) {
  if (!value) return '时间未知';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString('zh-CN', { hour12: false });
}

export function RunDrawer({
  open,
  setOpen,
  tab,
  setTab,
  logs,
  running,
  onStop,
  onRestart,
  onClear,
  runs = [],
  selectedRunId = '',
  historyLoading = false,
  onSelectRun,
  onReplayRun,
  onResumeRun,
  checkpoints = [],
  onCreateCheckpoint,
  onRestoreCheckpoint,
}) {
  const drawerRef = useRef(null);
  const selectedRun = useMemo(
    () => runs.find((item) => item.runId === selectedRunId) || runs[0] || null,
    [runs, selectedRunId],
  );

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      const drawer = drawerRef.current;
      if (drawer && !drawer.contains(document.activeElement)) drawer.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, tab]);

  if (!open) {
    return (
      <button className="drawer-collapsed" onClick={() => setOpen(true)}>
        <ChevronUp size={14} /><span>运行与检查</span><em>{running ? '正在运行' : `${runs.length || logs.length} 条记录`}</em>
      </button>
    );
  }

  return (
    <section className="run-drawer" aria-label="运行日志与恢复" tabIndex={-1} ref={drawerRef}>
      <div className="drawer-tabs">
        {tabs.map(([key, label]) => <button key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}</button>)}
        <div className="drawer-tabs-actions"><IconButton label="清空当前日志" onClick={onClear}><Trash2 size={14} /></IconButton><IconButton label="收起" onClick={() => setOpen(false)}><ChevronDown size={14} /></IconButton></div>
      </div>

      {tab === 'logs' ? (
        <div className="drawer-body logs-body">
          <div className="log-list">
            {logs.length ? logs.map((log, index) => (
              <div key={`${log.at}-${index}`} className={`log-row log-${log.level || log.stream || 'info'}`}>
                <time>{log.at}</time><span className="log-kind">{logIcon(log.level || log.stream)}</span><p>{log.text}</p>
              </div>
            )) : <p className="drawer-empty">当前没有运行记录。</p>}
          </div>
          <aside className="drawer-actions">
            <strong>{running ? '任务执行中' : '执行器空闲'}</strong>
            <CommandButton icon={Pause} onClick={onStop} disabled={!running}>安全停止</CommandButton>
            <CommandButton icon={Play} tone="primary" onClick={onRestart} disabled={running}>重新开始求解</CommandButton>
            <CommandButton icon={History} onClick={() => setTab('history')}>选择历史运行</CommandButton>
          </aside>
        </div>
      ) : null}

      {tab === 'history' ? (
        <div className="drawer-body run-history-body">
          <div className="run-history-list" role="list" aria-label="历史运行">
            {runs.map((item) => (
              <button
                key={item.runId}
                type="button"
                role="listitem"
                className={item.runId === selectedRun?.runId ? 'active' : ''}
                onClick={() => onSelectRun?.(item.runId)}
              >
                <span><strong>{statusLabels[item.status] || item.status || statusLabels.unknown}</strong><small>{item.stage || '未进入阶段'}</small></span>
                <time>{dateLabel(item.updatedAt || item.completedAt || item.startedAt)}</time>
                <code>{item.runId.slice(0, 12)}</code>
              </button>
            ))}
            {historyLoading ? <p className="drawer-empty">正在读取运行记录…</p> : null}
            {!historyLoading && !runs.length ? <p className="drawer-empty">尚无可恢复的历史运行。</p> : null}
          </div>
          <aside className="drawer-actions run-history-actions">
            <strong>{selectedRun ? statusLabels[selectedRun.status] || selectedRun.status : '未选择运行'}</strong>
            <span>{selectedRun ? `${selectedRun.stage || '未进入阶段'} · ${dateLabel(selectedRun.updatedAt || selectedRun.startedAt)}` : '选择一条记录查看日志或继续执行。'}</span>
            <CommandButton icon={History} onClick={() => setTab('logs')} disabled={!selectedRun}>查看所选日志</CommandButton>
            <CommandButton icon={RotateCcw} onClick={() => onResumeRun?.(selectedRun)} disabled={running || !selectedRun || !resumableStatuses.has(selectedRun.status)}>从断点继续</CommandButton>
            <CommandButton icon={Play} tone="primary" onClick={() => onReplayRun?.(selectedRun)} disabled={running || !selectedRun}>重新运行</CommandButton>
          </aside>
        </div>
      ) : null}

      {tab === 'restore' ? (
        <div className="drawer-body restore-list">
          <div className="restore-toolbar"><span>仅备份论文文本源文件</span><CommandButton icon={Plus} onClick={onCreateCheckpoint}>创建检查点</CommandButton></div>
          {checkpoints.map((item, index) => (
            <article key={item.id}><span className="restore-index">#{checkpoints.length - index}</span><div><strong>{item.label}</strong><small>{dateLabel(item.createdAt)} · {item.fileCount} 个文件</small></div><button onClick={() => onRestoreCheckpoint(item)}><RotateCcw size={13} />恢复</button></article>
          ))}
          {!checkpoints.length ? <p className="drawer-empty">尚未创建论文源文件检查点。</p> : null}
        </div>
      ) : null}
    </section>
  );
}
