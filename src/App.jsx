import {
  CheckCircle2,
  CircleAlert,
  Cpu,
  Database,
  HardDrive,
  LoaderCircle,
  RefreshCw,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { desktopApi, isDesktopRuntime } from './api.js';
import { ConfirmModal, ConnectionSettingsModal, CreateProjectModal, HostedAccountModal } from './components/Modals.jsx';
import { PaperCommandBar, PaperWorkspace } from './components/PaperWorkspace.jsx';
import { RunDrawer } from './components/RunDrawer.jsx';
import { AppSidebar, EmptyProject, OutlinePanel, ProjectSummary, UtilitySidebar } from './components/Shell.jsx';
import { StageWorkspace } from './components/StageWorkspace.jsx';
import { DEFAULT_SETTINGS, modelSummary } from './modelConfig.js';

const TEXT_EXTENSIONS = new Set(['.tex', '.md', '.py', '.yaml', '.yml', '.bib', '.json', '.csv', '.txt', '.log', '.js', '.jsx', '.ts', '.tsx', '.r', '.m', '.c', '.cc', '.cpp', '.h', '.hpp', '.java', '.sh', '.ps1', '.bat', '.cmd', '.toml', '.ini', '.cfg', '.conf', '.xml', '.html', '.css', '.sql', '.rst']);
const SPREADSHEET_EXTENSIONS = new Set(['.csv', '.xlsx']);
const EXTERNAL_ONLY_EXTENSIONS = new Set(['.doc', '.docx', '.xls', '.ppt', '.pptx', '.pages', '.numbers']);

function hasPipelineInputs(projectSnapshot) {
  const files = projectSnapshot?.files || [];
  return files.some((file) => file.relative.startsWith('inputs/problem/'))
    && files.some((file) => file.relative.startsWith('inputs/template/'));
}

function isTextPreview(file) {
  return Boolean(file?.previewKind === 'text' || TEXT_EXTENSIONS.has(file?.ext));
}

function matchingFile(files, file, extension) {
  if (!file) return null;
  const slash = file.relative.lastIndexOf('/');
  const directory = slash >= 0 ? file.relative.slice(0, slash) : '';
  const stem = file.name.replace(/\.[^.]+$/, '').toLocaleLowerCase();
  return files.find((item) => {
    const itemSlash = item.relative.lastIndexOf('/');
    const itemDirectory = itemSlash >= 0 ? item.relative.slice(0, itemSlash) : '';
    return item.ext === extension
      && itemDirectory === directory
      && item.name.replace(/\.[^.]+$/, '').toLocaleLowerCase() === stem;
  }) || null;
}

function nowLabel(timestamp = Date.now()) {
  return new Date(timestamp).toLocaleTimeString('zh-CN', { hour12: false });
}

function formatSpendAmount(value, currency = 'CNY') {
  const code = String(currency || 'CNY').toUpperCase();
  return `${code === 'CNY' ? '¥' : `${code} `}${Number(value || 0).toFixed(2)}`;
}

function mergeSettings(stored = {}) {
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    connections: Object.fromEntries(Object.keys(DEFAULT_SETTINGS.connections).map((key) => [key, {
      ...DEFAULT_SETTINGS.connections[key],
      ...stored.connections?.[key],
    }])),
  };
}

function StatusBar({ project, running, appInfo, settings, activeStage, spend }) {
  return (
    <footer className="status-bar">
      <span><Cpu size={12} />运行环境：{appInfo?.platform === 'browser-preview' ? '浏览器预览' : '桌面端'}</span>
      <span><Database size={12} />自动保存：{settings.autoSave ? '已开启' : '已关闭'}</span>
      <span><HardDrive size={12} />工作区：{project?.root || '未打开'}</span>
      <span className="status-spacer" />
      {spend?.tokens > 0 ? (
        <span className={spend.pricingUnknown ? 'pricing-unknown' : 'spend-indicator'}>
          {spend.tokens.toLocaleString()} tokens
          {!spend.pricingUnknown ? ` · ${spend.authoritative ? '' : '约 '}${formatSpendAmount(spend.cost, spend.currency)}` : ''}
          {!spend.pricingUnknown && typeof spend.balance === 'number' ? ` · 余额 ${formatSpendAmount(spend.balance, spend.currency)}` : ''}
        </span>
      ) : null}
      <span className="status-model"><Cpu size={12} />{modelSummary(settings, activeStage)}</span>
      <span className={running ? 'status-running' : 'status-ready'}>{running ? <CircleAlert size={12} /> : <CheckCircle2 size={12} />}{running ? '任务运行中' : '项目就绪'}</span>
      <span>v{appInfo?.version || '0.1.0'}</span>
    </footer>
  );
}

function WorkspaceState({ project, loading, error, onRetry }) {
  return (
    <main className="workspace-state" aria-live="polite" aria-busy={loading}>
      {loading ? <LoaderCircle className="workspace-state-icon spinning" size={30} /> : <CircleAlert className="workspace-state-icon" size={30} />}
      <h1>{loading ? '正在载入项目工作区' : '项目工作区暂时不可用'}</h1>
      <p>{loading ? `${project?.name || '当前项目'} · 正在读取阶段状态、论文文件和检查点` : error}</p>
      {!loading ? <button className="command-button command-primary" onClick={onRetry}><RefreshCw size={15} />重新加载</button> : null}
    </main>
  );
}

export function App() {
  const [projects, setProjects] = useState([]);
  const [activeProject, setActiveProject] = useState(null);
  const [snapshot, setSnapshot] = useState(null);
  const [activeStage, setActiveStage] = useState('paper');
  const [selectedFile, setSelectedFile] = useState(null);
  const [compareSourceFile, setCompareSourceFile] = useState(null);
  const [documentView, setDocumentView] = useState('preview');
  const [latex, setLatex] = useState('');
  const [figureUrl, setFigureUrl] = useState('');
  const [spreadsheet, setSpreadsheet] = useState(null);
  const [pdfUrl, setPdfUrl] = useState('');
  const [logs, setLogs] = useState([]);
  // Keep activity available without letting it compete with the paper canvas.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerTab, setDrawerTab] = useState('logs');
  const [sidePanelOpen, setSidePanelOpen] = useState(true);
  const [running, setRunning] = useState(false);
  const [activeRuns, setActiveRuns] = useState([]);
  const [spend, setSpend] = useState({ cost: 0, tokens: 0, pricingUnknown: false, authoritative: false, balance: null, currency: 'CNY' });
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [resolvedTheme, setResolvedTheme] = useState('light');
  const [appInfo, setAppInfo] = useState(null);
  const [modal, setModal] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [checkpoints, setCheckpoints] = useState([]);
  const [toast, setToast] = useState(null);
  const [projectLoading, setProjectLoading] = useState(false);
  const [projectLoadError, setProjectLoadError] = useState('');
  const loadRequestRef = useRef(0);
  const fileRequestRef = useRef(0);
  const activeProjectRef = useRef(null);
  const loadedProjectRootRef = useRef('');
  const toastTimerRef = useRef(null);

  useEffect(() => {
    activeProjectRef.current = activeProject;
    fileRequestRef.current += 1;
  }, [activeProject]);

  const notify = useCallback((message, tone = 'default') => {
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    setToast({ message, tone });
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, 3000);
  }, []);

  useEffect(() => () => {
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
  }, []);

  useEffect(() => {
    const preference = window.matchMedia?.('(prefers-color-scheme: dark)');
    const applyTheme = () => {
      const appearance = settings.appearance || 'light';
      const resolved = appearance === 'system' ? (preference?.matches ? 'dark' : 'light') : appearance;
      document.documentElement.dataset.theme = resolved;
      document.documentElement.style.colorScheme = resolved;
      setResolvedTheme(resolved);
    };
    applyTheme();
    preference?.addEventListener?.('change', applyTheme);
    return () => preference?.removeEventListener?.('change', applyTheme);
  }, [settings.appearance]);

  const refreshProjects = useCallback(async (preferredId = undefined) => {
    const items = await desktopApi.listProjects();
    setProjects(items);
    setActiveProject((current) => {
      const targetId = preferredId === undefined ? current?.id : preferredId;
      return items.find((project) => project.id === targetId) || items[0] || null;
    });
    return items;
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([refreshProjects(), desktopApi.getSettings(), desktopApi.appInfo()]).then(([, storedSettings, info]) => {
      if (cancelled) return;
      setSettings(mergeSettings(storedSettings));
      setAppInfo(info);
    }).catch((error) => {
      if (!cancelled) notify(error.message || '初始化工作区失败。', 'error');
    });
    desktopApi.activeRun(activeProjectRef.current?.root).then((active) => {
      if (cancelled) return;
      if (active) {
        setRunning(true);
        setDrawerOpen(true);
        setLogs((items) => [...items, { at: nowLabel(active.startedAt), level: 'info', text: `已连接正在执行的 ${active.stage} 任务` }]);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [notify, refreshProjects]);

  const resetWorkspace = useCallback(() => {
    setSnapshot(null);
    setSelectedFile(null);
    setCompareSourceFile(null);
    setLatex('');
    setFigureUrl('');
    setSpreadsheet(null);
    setPdfUrl('');
    setCheckpoints([]);
    setDocumentView('preview');
  }, []);

  const loadProject = useCallback(async (project) => {
    const requestId = ++loadRequestRef.current;
    if (!project) {
      loadedProjectRootRef.current = '';
      resetWorkspace();
      setProjectLoading(false);
      setProjectLoadError('');
      return null;
    }

    const projectChanged = loadedProjectRootRef.current !== project.root;
    setProjectLoading(true);
    setProjectLoadError('');
    resetWorkspace();
    try {
      const [next, savedCheckpoints] = await Promise.all([
        desktopApi.snapshot(project.root),
        desktopApi.listCheckpoints(project.root),
      ]);
      if (requestId !== loadRequestRef.current) return null;

      const readOptional = (file, fallback = '') => file
        ? desktopApi.readFile(file.path).catch(() => fallback)
        : Promise.resolve(fallback);
      const urlOptional = (file) => file
        ? desktopApi.fileUrl(file.path).catch(() => '')
        : Promise.resolve('');
      const initialFile = next.paper?.pdf || next.paper?.tex || next.files?.[0] || null;
      const initialSource = initialFile?.ext === '.pdf'
        ? matchingFile(next.files || [], initialFile, '.tex')
        : initialFile?.ext === '.tex' ? initialFile : null;
      const initialPdf = initialFile?.ext === '.tex'
        ? matchingFile(next.files || [], initialFile, '.pdf')
        : initialFile?.ext === '.pdf' ? initialFile : null;
      const [nextLatex, nextPdfUrl] = await Promise.all([
        readOptional(initialSource),
        urlOptional(initialPdf),
      ]);
      if (requestId !== loadRequestRef.current) return null;

      setSnapshot(next);
      setCheckpoints(savedCheckpoints);
      setSelectedFile(initialFile);
      setCompareSourceFile(initialSource);
      setLatex(nextLatex);
      setPdfUrl(nextPdfUrl);
      if (projectChanged) {
        const detectedStage = next.stages?.find((stage) => stage.uiStatus === 'active')?.key
          || (next.paper?.tex || next.paper?.pdf ? 'paper' : next.stages?.[0]?.key || 'analysis');
        setActiveStage(detectedStage);
      }
      loadedProjectRootRef.current = project.root;
      return next;
    } catch (error) {
      if (requestId !== loadRequestRef.current) return null;
      setSnapshot(null);
      setProjectLoadError(error.message || '读取项目工作区失败。');
      throw error;
    } finally {
      if (requestId === loadRequestRef.current) setProjectLoading(false);
    }
  }, [resetWorkspace]);

  useEffect(() => {
    loadProject(activeProject).catch((error) => notify(error.message, 'error'));
  }, [activeProject, loadProject, notify]);

  useEffect(() => {
    if (!isDesktopRuntime) return undefined;
    let cancelled = false;
    const refreshRuns = () => {
      desktopApi.activeRuns?.().then((items) => {
        if (!cancelled) setActiveRuns(Array.isArray(items) ? items : []);
      }).catch(() => {});
    };
    refreshRuns();
    const timer = window.setInterval(refreshRuns, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [running]);

  useEffect(() => {
    return desktopApi.onRunEvent((event) => {
      const currentRoot = activeProjectRef.current?.root;
      if (event.root && currentRoot && event.root !== currentRoot) return;
      if (event.type === 'pipeline-progress') {
        setRunning(true);
        setActiveStage(event.stage || 'analysis');
        setDrawerOpen(true);
        setDrawerTab('logs');
        setLogs((items) => [...items, { at: nowLabel(event.at), level: event.status === 'recovering' ? 'warning' : 'info', text: event.message }]);
      }
      if (event.type === 'stage-progress') {
        setRunning(true);
        if (event.stage) setActiveStage(event.stage);
        setDrawerOpen(true);
        setDrawerTab('logs');
        const level = event.status === 'completed' ? 'success' : event.status === 'recovering' ? 'warning' : 'info';
        setLogs((items) => [...items, { at: nowLabel(event.at), level, text: event.message }]);
      }
      if (event.type === 'usage-progress') {
        setSpend({
          cost: Number(event.cost) || 0,
          tokens: Number(event.tokens) || 0,
          pricingUnknown: Boolean(event.pricingUnknown),
          authoritative: Boolean(event.authoritative),
          balance: typeof event.balance === 'number' ? event.balance : null,
          currency: String(event.currency || 'CNY'),
        });
      }
      if (event.type === 'pipeline-complete') {
        setRunning(false);
        if (event.status === 'completed') setActiveStage('paper');
        setLogs((items) => [...items, { at: nowLabel(event.at), level: event.status === 'completed' ? 'success' : 'warning', text: event.message }]);
        if (activeProject) loadProject(activeProject).catch(() => {});
      }
    });
  }, [activeProject, loadProject]);

  const runPaperAction = useCallback(async (action) => {
    if (!activeProject || running) return;
    setRunning(true);
    try {
      const result = action === 'compile'
        ? await desktopApi.compilePaper(activeProject.root)
        : await desktopApi.checkPaper(activeProject.root);
      if (result?.code != null && result.code !== 0) throw new Error('论文编译未完成，请检查 TeX 内容。');
      if (result?.status === 'paused') throw new Error('论文检查暂时无法完成，请检查模型连接后重试。');
      await loadProject(activeProject);
      notify(action === 'compile' ? '论文编译完成' : '论文检查完成', 'success');
    } catch (error) {
      notify(error.message || '论文操作未完成。', 'error');
    } finally {
      setRunning(false);
    }
  }, [activeProject, loadProject, notify, running]);

  const runFullPipeline = useCallback(async (project = activeProject, projectSnapshot = snapshot) => {
    if (!project || running) return;
    if (!hasPipelineInputs(projectSnapshot)) {
      notify('请先同时添加赛题文件和论文模板。', 'error');
      return;
    }
    if (settings.mode === 'hosted' && isDesktopRuntime) {
      try {
        const account = await desktopApi.getAccount();
        if (!account.configured) {
          notify('当前版本未配置托管服务。', 'error');
          setModal('account');
          return;
        }
        if (!account.signedIn) {
          notify('请先登录托管账户。', 'error');
          setModal('account');
          return;
        }
      } catch (error) {
        notify(error.message || '无法确认托管账户状态。', 'error');
        setModal('account');
        return;
      }
    }
    const modelsReady = settings.mode === 'hosted'
      || ['reasoning', 'writing'].every((key) => settings.connections?.[key]?.baseUrl && settings.connections?.[key]?.model);
    if (!modelsReady) {
      notify('请先完成推理与代码模型、文本模型配置。', 'error');
      setModal('settings');
      return;
    }
    setRunning(true);
    setActiveStage('analysis');
    setDrawerOpen(true);
    setDrawerTab('logs');
    try {
      const result = await desktopApi.runFullPipeline(project.root);
      if (result?.status === 'paused') notify('流程暂时无法继续，请检查模型连接后重试。', 'error');
    } catch (error) {
      setRunning(false);
      notify(error.message || '完整流程启动失败。', 'error');
    }
  }, [activeProject, notify, running, settings, snapshot]);

  const stopStage = async () => {
    if (!activeProject?.root) return;
    await desktopApi.stopStage(activeProject.root);
    notify('已请求停止，当前进度将安全保存。');
  };

  const saveDocument = useCallback(async () => {
    const target = selectedFile && isTextPreview(selectedFile) ? selectedFile : compareSourceFile || snapshot?.paper?.tex;
    if (!target) return notify('当前没有可保存的文本文件。', 'error');
    await desktopApi.writeFile(target.path, latex);
    notify(`${target.name} 已保存`, 'success');
    return target;
  }, [compareSourceFile, latex, notify, selectedFile, snapshot?.paper?.tex]);

  useEffect(() => {
    const shortcuts = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        saveDocument();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        runPaperAction('compile');
      }
    };
    window.addEventListener('keydown', shortcuts);
    return () => window.removeEventListener('keydown', shortcuts);
  }, [runPaperAction, saveDocument]);

  const selectFile = async (file) => {
    if (!file) return;
    const requestId = ++fileRequestRef.current;
    const projectRoot = activeProject?.root;
    setSelectedFile(file);
    setSpreadsheet(null);
    setCompareSourceFile(null);
    if (SPREADSHEET_EXTENSIONS.has(file.ext)) {
      try {
        const preview = await desktopApi.readSpreadsheet(file.path);
        if (requestId === fileRequestRef.current && projectRoot === activeProjectRef.current?.root) setSpreadsheet(preview);
      } catch (error) {
        if (requestId === fileRequestRef.current && projectRoot === activeProjectRef.current?.root) notify(error.message || '无法读取表格文件。', 'error');
      }
      setDocumentView('preview');
    } else if (TEXT_EXTENSIONS.has(file.ext)) {
      setSelectedFile({ ...file, previewKind: 'text' });
      const pairedPdf = file.ext === '.tex' ? matchingFile(snapshot?.files || [], file, '.pdf') : null;
      setCompareSourceFile(file.ext === '.tex' ? file : null);
      try {
        const content = await desktopApi.readFile(file.path);
        if (requestId === fileRequestRef.current && projectRoot === activeProjectRef.current?.root) setLatex(content);
      } catch {
        if (requestId === fileRequestRef.current && projectRoot === activeProjectRef.current?.root) setLatex('');
      }
      if (pairedPdf) {
        try {
          const url = await desktopApi.fileUrl(pairedPdf.path);
          if (requestId === fileRequestRef.current && projectRoot === activeProjectRef.current?.root) setPdfUrl(url || '');
        } catch { if (requestId === fileRequestRef.current && projectRoot === activeProjectRef.current?.root) setPdfUrl(''); }
      } else if (file.ext === '.tex') {
        setPdfUrl('');
      }
      setDocumentView('source');
    } else if (['.png', '.jpg', '.jpeg', '.webp'].includes(file.ext)) {
      try {
        const url = await desktopApi.fileUrl(file.path);
        if (requestId === fileRequestRef.current && projectRoot === activeProjectRef.current?.root) setFigureUrl(url || '');
      } catch { if (requestId === fileRequestRef.current && projectRoot === activeProjectRef.current?.root) setFigureUrl(''); }
      setDocumentView('preview');
    } else if (file.ext === '.pdf') {
      const pairedTex = matchingFile(snapshot?.files || [], file, '.tex');
      setCompareSourceFile(pairedTex);
      try {
        const url = await desktopApi.fileUrl(file.path);
        if (requestId === fileRequestRef.current && projectRoot === activeProjectRef.current?.root) setPdfUrl(url || '');
      } catch { if (requestId === fileRequestRef.current && projectRoot === activeProjectRef.current?.root) setPdfUrl(''); }
      if (pairedTex) {
        try {
          const content = await desktopApi.readFile(pairedTex.path);
          if (requestId === fileRequestRef.current && projectRoot === activeProjectRef.current?.root) setLatex(content);
        } catch { if (requestId === fileRequestRef.current && projectRoot === activeProjectRef.current?.root) setLatex(''); }
      }
      setDocumentView('preview');
    } else if (EXTERNAL_ONLY_EXTENSIONS.has(file.ext)) {
      setDocumentView('preview');
    } else {
      try {
        const content = await desktopApi.readFile(file.path);
        if (requestId !== fileRequestRef.current || projectRoot !== activeProjectRef.current?.root) return;
        setSelectedFile({ ...file, previewKind: 'text' });
        setLatex(content);
        setDocumentView('source');
      } catch {
        setDocumentView('preview');
        notify(`${file.ext || '该二进制格式'} 暂不支持内嵌预览，可使用系统程序打开。`);
      }
    }
  };

  const openWorkspaceFile = async (file) => {
    if (!file) return notify('项目中未找到对应文件。', 'error');
    setActiveStage('paper');
    await selectFile(file);
  };

  const openExternal = async (file) => {
    if (!file) return;
    const error = await desktopApi.openPath(file.path);
    if (error) notify(error, 'error');
  };

  const addProject = async () => {
    try {
      const project = await desktopApi.addProject();
      if (!project) return;
      await refreshProjects(project.id);
      notify('项目已加入工作区', 'success');
    } catch (error) {
      notify(error.message || '导入项目失败。', 'error');
    }
  };

  const createProject = async (name) => {
    try {
      const project = await desktopApi.createProject(name);
      if (!project) return;
      setModal(null);
      await refreshProjects(project.id);
      notify('项目工作区已创建', 'success');
    } catch (error) {
      notify(error.message || '创建项目失败。', 'error');
    }
  };

  const addInputs = async (kind) => {
    if (!activeProject) return;
    try {
      const files = await desktopApi.addInputs(activeProject.root, kind);
      if (files?.length) {
        const next = await loadProject(activeProject);
        if (hasPipelineInputs(next)) {
          notify(`已添加 ${files.length} 个文件，赛题与模板齐全，开始完整流程。`, 'success');
          runFullPipeline(activeProject, next);
        } else {
          notify(`已添加 ${files.length} 个文件，请继续添加${kind === 'problem' ? '论文模板' : '赛题文件'}。`, 'success');
        }
      }
    } catch (error) {
      notify(error.message || '添加文件失败。', 'error');
    }
  };

  const importDroppedFiles = async (files) => {
    if (!activeProject || !files?.length) return;
    try {
      const imported = await desktopApi.importDroppedFiles(activeProject.root, 'problem', files);
      if (imported?.length) {
        const next = await loadProject(activeProject);
        if (hasPipelineInputs(next)) {
          notify(`已导入 ${imported.length} 个文件，赛题与模板齐全，开始完整流程。`, 'success');
          runFullPipeline(activeProject, next);
        } else {
          notify(`已导入 ${imported.length} 个赛题文件，请继续添加论文模板。`, 'success');
        }
      } else {
        notify('未导入文件，请使用“选择文件”重试。', 'error');
      }
    } catch (error) {
      notify(error.message || '导入阶段输入失败。', 'error');
    }
  };

  const handleStageFile = async (hint) => {
    if (!hint) return addInputs('problem');
    const token = String(hint).toLowerCase().replace(/[^a-z0-9_.-]/g, '');
    const file = snapshot?.files?.find((item) => item.name.toLowerCase() === token || item.name.toLowerCase().includes(token) || item.relative.toLowerCase().includes(token));
    if (file) return openWorkspaceFile(file);
    notify(`尚未找到“${hint}”，完成求解后会在成果目录中显示。`);
  };

  const createCheckpoint = async (label = `手动检查点 ${nowLabel()}`) => {
    if (!activeProject) return null;
    try {
      const item = await desktopApi.createCheckpoint(activeProject.root, label);
      setCheckpoints(await desktopApi.listCheckpoints(activeProject.root));
      notify(`已创建检查点：${item.label}`, 'success');
      return item;
    } catch (error) {
      notify(error.message, 'error');
      return null;
    }
  };

  const requestRestoreCheckpoint = (checkpoint) => {
    setConfirm({
      title: '恢复论文源文件',
      message: `将使用“${checkpoint.label}”覆盖当前论文文本源文件。项目数据和 inputs 不受影响。`,
      confirmLabel: '恢复检查点',
      action: async () => {
        await desktopApi.restoreCheckpoint(activeProject.root, checkpoint.id);
        await loadProject(activeProject);
        setConfirm(null);
        notify('检查点已恢复', 'success');
      },
    });
  };

  const requestRemoveProject = (project) => {
    setConfirm({
      title: '移除项目',
      message: `仅从数模工坊移除“${project.name}”，不会删除 ${project.root} 中的任何文件。`,
      confirmLabel: '移除项目',
      tone: 'danger',
      action: async () => {
        try {
          const result = await desktopApi.removeProject(project.root);
          if (result?.removed === false) throw new Error('项目未从列表中移除，请重试。');
          setActiveProject(null);
          await refreshProjects(null);
          setConfirm(null);
          notify('项目已从列表移除', 'success');
        } catch (error) {
          setConfirm(null);
          notify(error.message || '移除项目失败。', 'error');
        }
      },
    });
  };

  const exportFile = async (file, label) => {
    if (!file) return notify(`未找到可导出的${label}`, 'error');
    const target = await desktopApi.exportFile(file.path);
    if (target) notify(`${label}已导出`, 'success');
  };

  const compilePaper = async () => {
    if (settings.autoSave) await saveDocument();
    await createCheckpoint('论文编译前');
    await runPaperAction('compile');
  };

  const saveSettings = async (next) => {
    try {
      const saved = await desktopApi.saveSettings(next);
      setSettings(mergeSettings(saved));
      setModal(null);
      notify('设置已保存', 'success');
      return saved;
    } catch (error) {
      notify(error.message || '设置保存失败。', 'error');
      throw error;
    }
  };

  const discoverModels = async (candidate, connection) => {
    try {
      const result = await desktopApi.listModels(candidate, connection);
      notify(`已查询到 ${result.models?.length || 0} 个可用模型`, 'success');
      return result;
    } catch (error) {
      notify(error.message || '模型查询失败。', 'error');
      throw error;
    }
  };

  const importLocalModelConfig = (source) => desktopApi.importLocalModelConfig(source);

  const toggleSidePanel = () => {
    if (activeStage === 'paper' && documentView === 'preview' && selectedFile?.ext === '.pdf' && pdfUrl) {
      setDocumentView('source');
      setSidePanelOpen(true);
      return;
    }
    setSidePanelOpen((open) => !open);
  };

  const openRunHistory = () => {
    setDrawerTab('logs');
    setDrawerOpen(true);
  };

  const pdfFocus = activeStage === 'paper'
    && documentView === 'preview'
    && selectedFile?.ext === '.pdf'
    && Boolean(pdfUrl);

  return (
    <div className={`app-shell ${settings.compactMode ? 'compact' : ''}`}>
      <AppSidebar
        projects={projects}
        activeProject={activeProject}
        stages={snapshot?.stages}
        activeStage={activeStage}
        onSelectProject={setActiveProject}
        onSelectStage={setActiveStage}
        onNew={() => setModal('create')}
        onImport={addProject}
        onSettings={isDesktopRuntime ? () => setModal('settings') : undefined}
        onAccount={isDesktopRuntime ? () => setModal('account') : undefined}
        onRemove={requestRemoveProject}
        onOpenRuns={openRunHistory}
        running={running}
        activeRuns={activeRuns}
        desktopAvailable={isDesktopRuntime}
      />
      <div className="app-workspace">
        {activeProject ? (
          <ProjectSummary
            project={activeProject}
            stages={snapshot?.stages}
            activeStage={activeStage}
            stats={snapshot?.stats}
            modelLabel={modelSummary(settings, activeStage)}
            onModels={() => setModal('settings')}
            onFiles={toggleSidePanel}
            sidePanelOpen={sidePanelOpen}
            running={running}
            onPrimary={() => runFullPipeline()}
          />
        ) : null}
        <div className="workspace-body">
          <div className="workspace-main">
            {!activeProject ? <EmptyProject desktopAvailable={isDesktopRuntime} onNew={() => setModal('create')} onImport={addProject} /> : projectLoading || projectLoadError || !snapshot ? <WorkspaceState project={activeProject} loading={projectLoading} error={projectLoadError || '项目数据尚未就绪。'} onRetry={() => loadProject(activeProject).catch((error) => notify(error.message, 'error'))} /> : activeStage === 'paper' ? (
              <div className={`paper-layout ${pdfFocus ? 'pdf-focus' : ''}`}>
                <PaperWorkspace
                  view={documentView}
                  setView={setDocumentView}
                  selectedFile={selectedFile}
                  compareSourceFile={compareSourceFile}
                  latex={latex}
                  setLatex={setLatex}
                  onSave={saveDocument}
                  paper={snapshot?.paper}
                  figureUrl={figureUrl}
                  spreadsheet={spreadsheet}
                  pdfUrl={pdfUrl}
                  onOpenPdf={() => {
                    const target = selectedFile?.ext === '.pdf' ? selectedFile : snapshot?.paper?.pdf;
                    if (target) openExternal(target);
                  }}
                  onOpenSelectedFile={() => selectedFile && openExternal(selectedFile)}
                  autoSave={settings.autoSave}
                  project={activeProject}
                  theme={resolvedTheme}
                  pdfFocus={pdfFocus}
                />
              </div>
            ) : (
              <div className="pipeline-layout"><StageWorkspace project={activeProject} stage={activeStage} snapshot={snapshot} onOpenFile={openWorkspaceFile} onPickFiles={handleStageFile} onDropFiles={importDroppedFiles} /></div>
            )}
            {activeStage === 'paper' && snapshot && !projectLoading && !pdfFocus ? (
              <PaperCommandBar
                running={running}
                hasPdf={Boolean(snapshot?.paper?.pdf)}
                hasTex={Boolean(snapshot?.paper?.tex)}
                onCompile={compilePaper}
                onAudit={() => runPaperAction('audit')}
                onExportPdf={() => exportFile(snapshot?.paper?.pdf, 'PDF')}
                onExportTex={() => exportFile(snapshot?.paper?.tex, 'LaTeX')}
                onReveal={() => snapshot?.paper?.pdf && desktopApi.revealPath(snapshot.paper.pdf.path)}
                onOpen={() => snapshot?.paper?.pdf && openExternal(snapshot.paper.pdf)}
              />
            ) : null}
            <RunDrawer open={drawerOpen} setOpen={setDrawerOpen} tab={drawerTab} setTab={setDrawerTab} logs={logs} running={running} onStop={stopStage} onRestart={() => runFullPipeline()} onClear={() => setLogs([])} checkpoints={checkpoints} onCreateCheckpoint={() => createCheckpoint()} onRestoreCheckpoint={requestRestoreCheckpoint} />
          </div>
          {activeProject && !pdfFocus ? (
            <UtilitySidebar open={sidePanelOpen} onClose={() => setSidePanelOpen(false)} onOpenRuns={openRunHistory} running={running}>
              {projectLoading || !snapshot ? <div className="utility-state"><LoaderCircle className="spinning" size={20} /><span>正在读取项目资料</span></div> : (
                <OutlinePanel files={snapshot.files} selectedFile={selectedFile} onSelect={selectFile} onOpenExternal={openExternal} onAddProblem={() => addInputs('problem')} onAddTemplate={() => addInputs('template')} stats={snapshot.stats} />
              )}
            </UtilitySidebar>
          ) : null}
        </div>
        <StatusBar project={activeProject} running={running} appInfo={appInfo} settings={settings} activeStage={activeStage} spend={spend} />
      </div>

      {modal === 'create' ? <CreateProjectModal onClose={() => setModal(null)} onCreate={createProject} /> : null}
      {modal === 'account' ? <HostedAccountModal onClose={() => setModal(null)} /> : null}
      {modal === 'settings' ? (
        <ConnectionSettingsModal
          onClose={() => setModal(null)}
          settings={settings}
          onSave={saveSettings}
          onDiscoverModels={discoverModels}
          onImportLocalConfig={importLocalModelConfig}
          onExportDiagnostics={activeProject?.root
            ? () => desktopApi.exportDiagnostics(activeProject.root, false)
            : undefined}
        />
      ) : null}
      {confirm ? <ConfirmModal title={confirm.title} message={confirm.message} confirmLabel={confirm.confirmLabel} tone={confirm.tone} onClose={() => setConfirm(null)} onConfirm={confirm.action} /> : null}
      {toast ? <div className={`toast toast-${toast.tone}`}>{toast.tone === 'success' ? <CheckCircle2 size={15} /> : null}{toast.message}</div> : null}
    </div>
  );
}
