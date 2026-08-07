import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  Cpu,
  File,
  FileArchive,
  FileCode2,
  FileImage,
  FileSpreadsheet,
  FileText,
  Files,
  Folder,
  FolderInput,
  FolderOpen,
  History,
  LayoutDashboard,
  LoaderCircle,
  PanelRightClose,
  Plus,
  Play,
  Search,
  Settings,
  Sigma,
  Trash2,
  Upload,
  UserRound,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { canonicalProjectRoot } from '../runState.js';

export function IconButton({ label, children, className = '', ...props }) {
  return (
    <button className={`icon-button ${className}`} title={label} aria-label={label} {...props}>
      {children}
    </button>
  );
}

export function CommandButton({ icon: Icon, children, tone = 'default', className = '', ...props }) {
  return (
    <button className={`command-button command-${tone} ${className}`} {...props}>
      {Icon ? <Icon size={15} strokeWidth={1.8} aria-hidden="true" /> : null}
      <span>{children}</span>
    </button>
  );
}

export function StatusPill({ status, children }) {
  return <span className={`status-pill status-${status}`}>{children}</span>;
}

export function AppSidebar({ projects, activeProject, stages, activeStage, onSelectProject, onSelectStage, onNew, onImport, onSettings, onAccount, onRemove, onOpenRuns, running, activeRuns = [], desktopAvailable = true }) {
  const [query, setQuery] = useState('');
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [collapsedProjects, setCollapsedProjects] = useState({});
  const visible = projects.filter((project) => project.name.toLowerCase().includes(query.toLowerCase()));
  const stageItems = stages || [];
  const runByRoot = new Map(
    activeRuns
      .map((item) => [canonicalProjectRoot(item.root), item])
      .filter(([root]) => Boolean(root)),
  );
  return (
    <aside className="app-sidebar" aria-label="应用导航">
      <div className="brand-row">
        <span className="brand-mark"><Sigma size={18} /></span>
        <span className="brand-copy"><strong>数模工坊</strong><small>Modeling Studio</small></span>
      </div>
      <nav className="sidebar-primary" aria-label="主要操作">
        <button aria-label="新建项目" onClick={onNew} disabled={!desktopAvailable}><Plus size={16} /><span>新建项目</span></button>
        <button aria-label="导入项目" onClick={onImport} disabled={!desktopAvailable}><FolderInput size={16} /><span>导入项目</span></button>
        <button aria-label="运行记录" onClick={onOpenRuns} className={running ? 'running' : ''}><History size={16} /><span>运行记录</span>{running ? <i /> : null}</button>
      </nav>

      <section className="sidebar-projects">
        <div className="sidebar-section-heading">
          <button className="section-toggle" onClick={() => setProjectsOpen((value) => !value)} aria-expanded={projectsOpen}>
            {projectsOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <span>项目</span>
            <small>{projects.length}</small>
          </button>
          <IconButton label="导入已有项目" onClick={onImport} disabled={!desktopAvailable}><FolderInput size={14} /></IconButton>
          <IconButton label="新建项目" onClick={onNew} disabled={!desktopAvailable}><Plus size={15} /></IconButton>
        </div>
        {projectsOpen ? (
          <>
            <label className="search-field">
              <Search size={13} aria-hidden="true" />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索项目" aria-label="搜索项目" />
            </label>
            <div className="project-tree">
              {visible.map((project) => {
                const active = project.id === activeProject?.id;
                const expanded = active && !collapsedProjects[project.id];
                const projectRun = runByRoot.get(canonicalProjectRoot(project.root));
                return (
                  <div className={`project-node ${active ? 'active' : ''}`} key={project.id}>
                    <div className="project-node-line">
                      <button className="project-select" aria-current={active ? 'page' : undefined} aria-expanded={active ? expanded : undefined} onClick={() => {
                        if (active) setCollapsedProjects((current) => ({ ...current, [project.id]: !current[project.id] }));
                        else {
                          setCollapsedProjects((current) => ({ ...current, [project.id]: false }));
                          onSelectProject(project);
                        }
                      }} title={project.root}>
                        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                        {active ? <FolderOpen size={15} /> : <Folder size={15} />}
                        <span>{project.name}</span>
                        {projectRun ? <small className="project-running">{projectRun.stage || '运行中'}</small> : null}
                      </button>
                      {active ? (
                        <IconButton
                          className="project-remove"
                          label={projectRun ? '任务运行中，无法移除项目' : '从列表移除项目'}
                          disabled={Boolean(projectRun)}
                          onClick={() => onRemove(project)}
                        ><Trash2 size={13} /></IconButton>
                      ) : null}
                    </div>
                    {expanded ? (
                      <nav className="stage-tree" aria-label={`${project.name} 阶段`}>
                        {stageItems.map((stage) => {
                          const status = stage.uiStatus || 'pending';
                          return (
                            <button key={stage.key} className={`${activeStage === stage.key ? 'active' : ''} ${status}`} onClick={() => onSelectStage(stage.key)} aria-current={activeStage === stage.key ? 'step' : undefined}>
                              <span className="stage-tree-icon">
                                {status === 'completed' ? <Check size={11} /> : status === 'attention' ? <AlertTriangle size={11} /> : <Circle size={8} fill={status === 'active' ? 'currentColor' : 'none'} />}
                              </span>
                              <span>{stage.label}</span>
                            </button>
                          );
                        })}
                      </nav>
                    ) : null}
                  </div>
                );
              })}
              {!visible.length ? <p className="sidebar-empty">没有匹配项目</p> : null}
            </div>
          </>
        ) : null}
      </section>

      <footer className="sidebar-footer">
        <button aria-label="账户与充值" onClick={onAccount} disabled={!onAccount}><UserRound size={16} /><span>账户与充值</span></button>
        <button aria-label="设置与模型" onClick={onSettings} disabled={!onSettings}><Settings size={16} /><span>设置与模型</span></button>
      </footer>
    </aside>
  );
}

export function ProjectSummary({ project, stages, activeStage, stats, onModels, modelLabel, onFiles, sidePanelOpen, running, onPrimary }) {
  const items = stages || [];
  const current = items.find((stage) => stage.key === activeStage) || items[0];
  const completed = items.filter((stage) => stage.uiStatus === 'completed').length;
  const progress = Math.round(((completed + (current?.uiStatus === 'active' ? 0.6 : 0)) / Math.max(items.length, 1)) * 100);
  const primaryLabel = running ? '正在完成求解' : '一键完成求解';
  return (
    <header className="project-summary">
      <div className="summary-context" title={project?.root || ''}>
        <span className="summary-kicker"><LayoutDashboard size={13} />当前工作区</span>
        <strong>{project?.name || '未选择项目'}</strong>
        <small>{current?.label || '等待阶段'} · {current?.uiStatus === 'completed' ? '已完成' : current?.uiStatus === 'attention' ? '需要处理' : current?.uiStatus === 'active' ? '进行中' : '待开始'}</small>
      </div>
      <div className="summary-progress">
        <span>项目进度 <strong>{completed}/{items.length}</strong></span>
        <div><i style={{ width: `${Math.min(progress, 100)}%` }} /></div>
      </div>
      <div className="summary-stats" aria-label="项目统计">
        <span><strong>{stats?.fileCount || 0}</strong>文件</span>
        <span><strong>{stats?.figureCount || 0}</strong>图</span>
        <span><strong>{stats?.tableCount || 0}</strong>表</span>
      </div>
      <div className="summary-actions">
        <button className="model-chip" aria-label="设置与模型" onClick={onModels} title="配置求解所需模型"><Cpu size={14} /><span>{modelLabel}</span></button>
        <IconButton className={sidePanelOpen ? 'active' : ''} label="项目文件" onClick={onFiles}><Files size={16} /></IconButton>
        <CommandButton tone="primary" icon={running ? LoaderCircle : Play} aria-label={primaryLabel} onClick={onPrimary} disabled={running} className={running ? 'is-running' : ''}>{primaryLabel}</CommandButton>
      </div>
    </header>
  );
}

export function UtilitySidebar({ open, onClose, onOpenRuns, running, children }) {
  return (
    <aside className={`utility-sidebar ${open ? 'open' : ''}`} aria-label="工作区工具">
      <nav className="utility-rail" aria-label="侧边工具">
        <IconButton className={open ? 'active' : ''} label="项目资料" onClick={onClose}><Files size={17} /></IconButton>
        <span className="utility-spacer" />
        <IconButton className={running ? 'running' : ''} label="运行记录" onClick={onOpenRuns}><History size={17} /></IconButton>
      </nav>
      {open ? (
        <div className="utility-panel">
          <header><strong>项目资料</strong><IconButton label="收起侧边栏" onClick={onClose}><PanelRightClose size={16} /></IconButton></header>
          <div className="utility-panel-content">{children}</div>
        </div>
      ) : null}
    </aside>
  );
}

function fileIcon(file) {
  if (['.png', '.jpg', '.jpeg', '.webp', '.pdf'].includes(file.ext)) return file.ext === '.pdf' ? FileText : FileImage;
  if (['.csv', '.xlsx', '.xls'].includes(file.ext)) return FileSpreadsheet;
  if (['.tex', '.py', '.yaml', '.yml', '.json'].includes(file.ext)) return FileCode2;
  if (['.zip', '.7z', '.rar'].includes(file.ext)) return FileArchive;
  return File;
}

function buildFileTree(files) {
  const root = { folders: new Map(), files: [] };
  files.forEach((file) => {
    const parts = file.relative.split('/').filter(Boolean);
    const name = parts.pop();
    let node = root;
    parts.forEach((part) => {
      if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), files: [] });
      node = node.folders.get(part);
    });
    node.files.push({ ...file, name: name || file.name });
  });
  return root;
}

export function OutlinePanel({ files = [], selectedFile, onSelect, onOpenExternal, onAddProblem, onAddTemplate, stats }) {
  const tree = useMemo(() => buildFileTree(files), [files]);
  const [collapsed, setCollapsed] = useState({});
  const [query, setQuery] = useState('');
  const visibleFiles = useMemo(() => files.filter((file) => `${file.name} ${file.relative}`.toLowerCase().includes(query.toLowerCase())), [files, query]);
  const renderFile = (file, flat = false) => {
    const Icon = fileIcon(file);
    return (
      <button
        key={file.path}
        className={`${selectedFile?.path === file.path ? 'selected' : ''} ${flat ? 'flat-file' : ''}`}
        onClick={() => onSelect(file)}
        onDoubleClick={() => onOpenExternal(file)}
        title={`${file.relative}\n双击使用系统程序打开`}
      >
        <Icon size={13} strokeWidth={1.7} />
        <span>{flat ? file.relative : file.name}</span>
        <Circle className="file-health" size={7} aria-hidden="true" />
      </button>
    );
  };
  const renderTree = (node, parent = '', depth = 0) => {
    const folders = [...node.folders.entries()].sort(([left], [right]) => left.localeCompare(right, 'zh-CN'));
    const sortedFiles = [...node.files].sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
    return <>
      {folders.map(([name, child]) => {
        const folderPath = parent ? `${parent}/${name}` : name;
        const isCollapsed = collapsed[folderPath];
        return <section className="file-tree-folder" key={folderPath}>
          <button className="file-tree-folder-toggle" style={{ paddingLeft: `${8 + depth * 14}px` }} onClick={() => setCollapsed((value) => ({ ...value, [folderPath]: !isCollapsed }))}>
            {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}{isCollapsed ? <Folder size={14} /> : <FolderOpen size={14} />}<span>{name}</span>
          </button>
          {!isCollapsed ? renderTree(child, folderPath, depth + 1) : null}
        </section>;
      })}
      {sortedFiles.map((file) => <div className="file-tree-file" style={{ paddingLeft: `${11 + depth * 14}px` }} key={file.path}>{renderFile(file)}</div>)}
    </>;
  };
  return (
    <aside className="outline-panel" aria-label="项目文件与文档大纲">
      <div className="outline-actions">
        <label className="outline-search"><Search size={12} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="筛选项目文件" /></label>
        <button onClick={onAddProblem}><Upload size={13} />添加赛题</button><button onClick={onAddTemplate}><FileCode2 size={13} />添加模板</button>
      </div>
      <div className="outline-tree">
        {query ? <div className="outline-files flat-file-list">{visibleFiles.map((file) => renderFile(file, true))}{!visibleFiles.length ? <p className="outline-empty">没有匹配文件</p> : null}</div> : <div className="file-tree">{renderTree(tree)}{!files.length ? <p className="outline-empty">项目中尚未发现文件</p> : null}</div>}
      </div>
      <div className="document-stats">
        <div><span>最近审计</span><strong>{stats?.auditScore == null ? '未运行' : `${stats.auditScore} 分`}</strong></div>
        {stats?.auditScore == null ? null : <div className="completion-track"><i style={{ width: `${Math.max(0, Math.min(stats.auditScore, 100))}%` }} /></div>}
        <p>{stats?.fileCount || 0} 个文件 · {stats?.figureCount || 0} 幅图 · {stats?.tableCount || 0} 张表{stats?.hardGate ? ' · 门禁通过' : ''}</p>
      </div>
    </aside>
  );
}

export function EmptyProject({ desktopAvailable, onNew, onImport }) {
  return (
    <main className="empty-project">
      <FolderOpen size={34} strokeWidth={1.4} />
      <h1>{desktopAvailable ? '开始一个数学建模项目' : '请在桌面端打开工作区'}</h1>
      <p>{desktopAvailable ? '创建标准工作区，或导入包含 inputs 与 work 的现有项目。' : '浏览器预览不访问本机文件系统，也不会生成演示项目或虚构运行结果。'}</p>
      {desktopAvailable ? <div><CommandButton tone="primary" icon={Plus} onClick={onNew}>新建项目</CommandButton><CommandButton icon={Folder} onClick={onImport}>导入项目</CommandButton></div> : null}
    </main>
  );
}
