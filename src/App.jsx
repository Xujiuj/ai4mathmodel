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
import { APP_VERSION, desktopApi, isDesktopRuntime } from './api.js';
import { ConfirmModal, ConnectionSettingsModal, CreateProjectModal, HostedAccountModal } from './components/Modals.jsx';
import { PaperCommandBar, PaperWorkspace } from './components/PaperWorkspace.jsx';
import { RunDrawer } from './components/RunDrawer.jsx';
import { AppSidebar, EmptyProject, OutlinePanel, ProjectSummary, UtilitySidebar } from './components/Shell.jsx';
import { StageWorkspace } from './components/StageWorkspace.jsx';
import { IMAGE_PREVIEW_EXTENSIONS } from './fileTypes.js';
import { DEFAULT_SETTINGS, modelSummary } from './modelConfig.js';
import { mergeActiveRuns, projectIsRunning, runtimePreflight, sameProjectRoot } from './runState.js';

const TEXT_EXTENSIONS = new Set(['.tex', '.md', '.py', '.yaml', '.yml', '.bib', '.json', '.csv', '.txt', '.log', '.js', '.jsx', '.ts', '.tsx', '.r', '.m', '.c', '.cc', '.cpp', '.h', '.hpp', '.java', '.sh', '.ps1', '.bat', '.cmd', '.toml', '.ini', '.cfg', '.conf', '.xml', '.html', '.css', '.sql', '.rst']);
const SPREADSHEET_EXTENSIONS = new Set(['.csv', '.xlsx']);
const EXTERNAL_ONLY_EXTENSIONS = new Set(['.doc', '.docx', '.xls', '.ppt', '.pptx', '.pages', '.numbers']);
const PROBLEM_DROP_EXTENSIONS = new Set(['.txt', '.md', '.pdf', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.zip', '.rar', '.7z', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx']);
const TEMPLATE_DROP_EXTENSIONS = new Set(['.tex', '.cls', '.sty', '.bst', '.bib', '.ltx']);

function hasPipelineInputs(projectSnapshot) {
  const files = projectSnapshot?.files || [];
  return files.some((file) => file.relative.startsWith('inputs/problem/'))
    && files.some((file) => file.relative.startsWith('inputs/template/'));
}

function isTextPreview(file) {
  return Boolean(file?.previewKind === 'text' || TEXT_EXTENSIONS.has(file?.ext));
}

function classifyDroppedKind(file) {
  const name = String(file?.name || '').toLowerCase();
  const ext = String(file?.ext || '').toLowerCase();
  if (PROBLEM_DROP_EXTENSIONS.has(ext) || /problem|question|data|赛题|题目|附件/.test(name)) return 'problem';
  if (TEMPLATE_DROP_EXTENSIONS.has(ext) || /template|latex|paper|report|模板/.test(name)) return 'template';
  return 'problem';
}

function splitDroppedFiles(files) {
  const buckets = { problem: [], template: [] };
  for (const file of Array.isArray(files) ? files : []) {
    buckets[classifyDroppedKind(file)].push(file);
  }
  return buckets;
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

function historyLogs(result) {
  const events = Array.isArray(result) ? result : result?.events;
  return (Array.isArray(events) ? events : [])
    .filter((event) => ['pipeline-progress', 'stage-progress', 'pipeline-complete'].includes(event?.type))
    .map((event) => ({
      at: nowLabel(event.at),
      level: event.status === 'completed' ? 'success' : event.status === 'recovering' || event.status === 'cancelled' || event.status === 'paused' ? 'warning' : 'info',
      text: String(event.message || ''),
      seq: Number(event.seq) || undefined,
    }));
}

function formatSpendAmount(value, currency = 'CNY') {
  const code = String(currency || 'CNY').toUpperCase();
  if (code === 'PTS') return `${Math.round(Number(value || 0)).toLocaleString('zh-CN')} 积分`;
  return `${code === 'CNY' ? '¥' : `${code} `}${Number(value || 0).toFixed(2)}`;
}

function mergeSettings(stored = {}) {
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    agentPolicy: {
      ...DEFAULT_SETTINGS.agentPolicy,
      ...(stored.agentPolicy || {}),
    },
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
      <span>v{appInfo?.version || APP_VERSION}</span>
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
  const [runs, setRuns] = useState([]);
  const [selectedRunId, setSelectedRunId] = useState('');
  const [historyLoading, setHistoryLoading] = useState(false);
  // Keep activity available without letting it compete with the paper canvas.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerTab, setDrawerTab] = useState('logs');
  const [sidePanelOpen, setSidePanelOpen] = useState(true);
  const [localRuns, setLocalRuns] = useState([]);
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
  const historyRequestRef = useRef(0);
  const runCatalogRequestRef = useRef(0);
  const activeProjectRef = useRef(null);
  const selectedRunIdRef = useRef('');
  const loadedProjectRootRef = useRef('');
  const toastTimerRef = useRef(null);
  const displayRuns = mergeActiveRuns(activeRuns, localRuns);
  const running = projectIsRunning(displayRuns, activeProject?.root);

  const markLocalRun = useCallback((root, stage) => {
    if (!root) return;
    setLocalRuns((items) => mergeActiveRuns(items, [{ root, stage: stage || 'analysis', startedAt: Date.now() }]));
  }, []);

  const clearLocalRun = useCallback((root) => {
    if (!root) return;
    setLocalRuns((items) => items.filter((item) => !sameProjectRoot(item.root, root)));
  }, []);

  useEffect(() => {
    activeProjectRef.current = activeProject;
    fileRequestRef.current += 1;
    historyRequestRef.current += 1;
    runCatalogRequestRef.current += 1;
    selectedRunIdRef.current = '';
    setHistoryLoading(false);
  }, [activeProject?.root]);

  useEffect(() => {
    selectedRunIdRef.current = selectedRunId;
  }, [selectedRunId]);

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
      setLogs([]);
      setRuns([]);
      setSelectedRunId('');
      setProjectLoading(false);
      setProjectLoadError('');
      return null;
    }

    const projectChanged = loadedProjectRootRef.current !== project.root;
    setProjectLoading(true);
    setProjectLoadError('');
    resetWorkspace();
    if (projectChanged) setLogs([]);
    try {
      const [next, savedCheckpoints, savedHistory, savedRuns] = await Promise.all([
        desktopApi.snapshot(project.root),
        desktopApi.listCheckpoints(project.root),
        projectChanged ? desktopApi.runHistory(project.root, { limit: 2000 }).catch(() => null) : Promise.resolve(null),
        desktopApi.listRuns(project.root, { limit: 100 }).catch(() => []),
      ]);
      if (requestId !== loadRequestRef.current) return null;

      const readOptional = (file, fallback = '') => file
        ? desktopApi.readFile(file.path).catch(() => fallback)
        : Promise.resolve(fallback);
      const urlOptional = (file) => file
        ? desktopApi.fileUrl(file.path).catch(() => '')
        : Promise.resolve('');
      const markdownPreferred = next.profile?.paperFormat === 'markdown';
      const preferredSource = markdownPreferred
        ? next.paper?.markdown || next.paper?.tex
        : next.paper?.tex;
      const initialFile = markdownPreferred
        ? preferredSource || next.paper?.pdf || next.files?.[0] || null
        : next.paper?.pdf || preferredSource || next.files?.[0] || null;
      const initialSource = initialFile?.ext === '.pdf'
        ? preferredSource || matchingFile(next.files || [], initialFile, '.tex')
        : ['.tex', '.md'].includes(initialFile?.ext) ? initialFile : null;
      const initialPdf = ['.tex', '.md'].includes(initialFile?.ext)
        ? next.paper?.pdf || matchingFile(next.files || [], initialFile, '.pdf')
        : initialFile?.ext === '.pdf' ? initialFile : null;
      const [nextLatex, nextPdfUrl] = await Promise.all([
        readOptional(initialSource),
        urlOptional(initialPdf),
      ]);
      if (requestId !== loadRequestRef.current) return null;

      setSnapshot(next);
      setCheckpoints(savedCheckpoints);
      setRuns(Array.isArray(savedRuns) ? savedRuns : []);
      setSelectedRunId((current) => (
        (Array.isArray(savedRuns) && savedRuns.some((item) => item.runId === current))
          ? current
          : savedRuns?.[0]?.runId || ''
      ));
      setSelectedFile(initialFile);
      setCompareSourceFile(initialSource);
      setLatex(nextLatex);
      setPdfUrl(nextPdfUrl);
      if (projectChanged) {
        const hydratedLogs = historyLogs(savedHistory);
        if (hydratedLogs.length) setLogs((current) => [...hydratedLogs, ...current]);
        const detectedStage = next.stages?.find((stage) => stage.uiStatus === 'active')?.key
          || (next.paper?.markdown || next.paper?.tex || next.paper?.pdf ? 'paper' : next.stages?.[0]?.key || 'analysis');
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

  const refreshRunCatalog = useCallback(async (project = activeProject) => {
    const requestId = ++runCatalogRequestRef.current;
    const projectRoot = project?.root || '';
    const isCurrentRequest = () => requestId === runCatalogRequestRef.current
      && projectRoot === (activeProjectRef.current?.root || '');
    try {
      if (!projectRoot) {
        if (!isCurrentRequest()) return [];
        setRuns([]);
        setSelectedRunId('');
        return [];
      }
      const items = await desktopApi.listRuns(projectRoot, { limit: 100 });
      if (!isCurrentRequest()) return [];
      const nextRuns = Array.isArray(items) ? items : [];
      setRuns(nextRuns);
      setSelectedRunId((current) => nextRuns.some((item) => item.runId === current) ? current : nextRuns[0]?.runId || '');
      return nextRuns;
    } catch (error) {
      if (!isCurrentRequest()) return [];
      throw error;
    } finally {
      if (isCurrentRequest()) setHistoryLoading(false);
    }
  }, [activeProject]);

  const selectHistoricalRun = useCallback(async (runId) => {
    if (!activeProject?.root || !runId) return;
    const projectRoot = activeProject.root;
    const requestId = ++historyRequestRef.current;
    const isCurrentRequest = () => requestId === historyRequestRef.current
      && projectRoot === activeProjectRef.current?.root
      && selectedRunIdRef.current === runId;
    selectedRunIdRef.current = runId;
    setSelectedRunId(runId);
    setHistoryLoading(true);
    try {
      const history = await desktopApi.runHistory(projectRoot, { runId, limit: 2000 });
      if (!isCurrentRequest()) return;
      setLogs(historyLogs(history));
    } catch (error) {
      if (!isCurrentRequest()) return;
      notify(error.message || '无法读取所选运行记录。', 'error');
    } finally {
      if (isCurrentRequest()) setHistoryLoading(false);
    }
  }, [activeProject, notify]);

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
  }, []);

  useEffect(() => {
    return desktopApi.onRunEvent((event) => {
      const currentRoot = activeProjectRef.current?.root;
      const eventRoot = event.root || currentRoot;
      if (eventRoot && (event.type === 'pipeline-progress' || event.type === 'stage-progress')) {
        setActiveRuns((items) => mergeActiveRuns(items, [{ root: eventRoot, stage: event.stage, startedAt: event.at }]));
      }
      if (eventRoot && event.type === 'pipeline-complete') {
        setActiveRuns((items) => items.filter((item) => !sameProjectRoot(item.root, eventRoot)));
        clearLocalRun(eventRoot);
      }
      if (event.root && currentRoot && !sameProjectRoot(event.root, currentRoot)) return;
      if (event.type === 'pipeline-progress') {
        markLocalRun(eventRoot, event.stage);
        setActiveStage(event.stage || 'analysis');
        setDrawerOpen(true);
        setDrawerTab('logs');
        setLogs((items) => [...items, { at: nowLabel(event.at), level: event.status === 'recovering' ? 'warning' : 'info', text: event.message }]);
      }
      if (event.type === 'stage-progress') {
        markLocalRun(eventRoot, event.stage);
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
        if (event.status === 'completed') setActiveStage('paper');
        setLogs((items) => [...items, { at: nowLabel(event.at), level: event.status === 'completed' ? 'success' : 'warning', text: event.message }]);
        if (activeProject) loadProject(activeProject).catch(() => {});
      }
    });
  }, [activeProject, clearLocalRun, loadProject, markLocalRun]);

  const runPaperAction = useCallback(async (action) => {
    if (!activeProject || running) return;
    markLocalRun(activeProject.root, action === 'compile' ? 'compile' : 'review');
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
      clearLocalRun(activeProject.root);
    }
  }, [activeProject, clearLocalRun, loadProject, markLocalRun, notify, running]);

  const runFullPipeline = useCallback(async (project = activeProject, projectSnapshot = snapshot) => {
    if (!project || projectIsRunning(displayRuns, project.root)) return;
    if (!hasPipelineInputs(projectSnapshot)) {
      notify('请先同时添加赛题文件和论文模板。', 'error');
      return;
    }
    if (isDesktopRuntime) {
      try {
        const latestInfo = await desktopApi.appInfo();
        setAppInfo(latestInfo);
        const preflight = runtimePreflight(latestInfo?.runtime, ['analysis', 'solving', 'paper', 'review']);
        if (!preflight.ok) {
          const missing = preflight.missing.map((tool) => tool === 'tectonic' ? 'LaTeX' : 'Python').join('、');
          notify(`缺少运行组件：${missing}。请先在设置中完成安装。`, 'error');
          setModal('settings');
          return;
        }
      } catch (error) {
        notify(error.message || '无法确认本地运行组件。', 'error');
        return;
      }
    }
    if (settings.mode === 'hosted' && isDesktopRuntime) {
      try {
        const account = await desktopApi.getAccount();
        if (!account.configured) {
          notify('当前版本未配置托管服务。', 'error');
          setModal('account');
          return;
        }
        if (account.service?.available === false) {
          notify('托管服务当前不可用，请稍后重试。', 'error');
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
      || ['coordinator', 'modeler', 'coder', 'writer'].every((key) => settings.connections?.[key]?.baseUrl && settings.connections?.[key]?.model);
    if (!modelsReady) {
      notify('请先完成总控、建模、编程和写作模型配置。', 'error');
      setModal('settings');
      return;
    }
    markLocalRun(project.root, 'analysis');
    setActiveStage('analysis');
    setDrawerOpen(true);
    setDrawerTab('logs');
    try {
      const result = await desktopApi.runFullPipeline(project.root);
      if (result?.status === 'paused') notify('流程暂时无法继续，请检查模型连接后重试。', 'error');
    } catch (error) {
      notify(error.message || '完整流程启动失败。', 'error');
    } finally {
      clearLocalRun(project.root);
    }
  }, [activeProject, activeRuns, clearLocalRun, localRuns, markLocalRun, notify, settings, snapshot]);

  const stopStage = async () => {
    if (!activeProject?.root) return;
    try {
      await desktopApi.stopStage(activeProject.root);
      notify('已请求停止，当前进度将安全保存。');
    } catch (error) {
      notify(error.message || '停止任务失败，请重试。', 'error');
    }
  };

  const saveDocument = useCallback(async () => {
    const target = selectedFile && isTextPreview(selectedFile)
      ? selectedFile
      : compareSourceFile || (snapshot?.profile?.paperFormat === 'markdown' ? snapshot?.paper?.markdown : null) || snapshot?.paper?.tex;
    if (!target) return notify('当前没有可保存的文本文件。', 'error');
    await desktopApi.writeFile(target.path, latex);
    notify(`${target.name} 已保存`, 'success');
    return target;
  }, [compareSourceFile, latex, notify, selectedFile, snapshot?.paper?.markdown, snapshot?.paper?.tex, snapshot?.profile?.paperFormat]);

  const reportSaveError = useCallback((error) => {
    notify(error?.message || '文件保存失败，请检查权限和磁盘空间。', 'error');
  }, [notify]);

  useEffect(() => {
    const shortcuts = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void saveDocument().catch(reportSaveError);
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        runPaperAction('compile');
      }
    };
    window.addEventListener('keydown', shortcuts);
    return () => window.removeEventListener('keydown', shortcuts);
  }, [reportSaveError, runPaperAction, saveDocument]);

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
      const pairedPdf = ['.tex', '.md'].includes(file.ext)
        ? matchingFile(snapshot?.files || [], file, '.pdf')
          || ([snapshot?.paper?.tex?.path, snapshot?.paper?.markdown?.path].includes(file.path) ? snapshot?.paper?.pdf : null)
        : null;
      setCompareSourceFile(['.tex', '.md'].includes(file.ext) ? file : null);
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
      } else if (['.tex', '.md'].includes(file.ext)) {
        setPdfUrl('');
      }
      setDocumentView('source');
    } else if (IMAGE_PREVIEW_EXTENSIONS.has(file.ext)) {
      try {
        const url = await desktopApi.fileUrl(file.path);
        if (requestId === fileRequestRef.current && projectRoot === activeProjectRef.current?.root) setFigureUrl(url || '');
      } catch { if (requestId === fileRequestRef.current && projectRoot === activeProjectRef.current?.root) setFigureUrl(''); }
      setDocumentView('preview');
    } else if (file.ext === '.pdf') {
      const pairedSource = matchingFile(snapshot?.files || [], file, snapshot?.profile?.paperFormat === 'markdown' ? '.md' : '.tex')
        || (file.path === snapshot?.paper?.pdf?.path
          ? (snapshot?.profile?.paperFormat === 'markdown' ? snapshot?.paper?.markdown || snapshot?.paper?.tex : snapshot?.paper?.tex)
          : null);
      setCompareSourceFile(pairedSource);
      try {
        const url = await desktopApi.fileUrl(file.path);
        if (requestId === fileRequestRef.current && projectRoot === activeProjectRef.current?.root) setPdfUrl(url || '');
      } catch { if (requestId === fileRequestRef.current && projectRoot === activeProjectRef.current?.root) setPdfUrl(''); }
      if (pairedSource) {
        try {
          const content = await desktopApi.readFile(pairedSource.path);
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
    try {
      const error = await desktopApi.openPath(file.path);
      if (error) notify(error, 'error');
    } catch (error) {
      notify(error.message || '无法使用系统程序打开文件。', 'error');
    }
  };

  const revealOutput = async (file) => {
    if (!file) return;
    try {
      const error = await desktopApi.revealPath(file.path);
      if (error) notify(error, 'error');
    } catch (error) {
      notify(error.message || '无法在文件夹中显示输出文件。', 'error');
    }
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

  const createProject = async (name, profile, problem = {}) => {
    try {
      const project = await desktopApi.createProject(name, profile, problem);
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
      const buckets = splitDroppedFiles(files);
      const imported = [];
      if (buckets.problem.length) {
        imported.push(...await desktopApi.importDroppedFiles(activeProject.root, 'problem', buckets.problem));
      }
      if (buckets.template.length) {
        imported.push(...await desktopApi.importDroppedFiles(activeProject.root, 'template', buckets.template));
      }
      if (imported.length) {
        const next = await loadProject(activeProject);
        if (hasPipelineInputs(next)) {
          notify(`已导入 ${buckets.problem.length} 个赛题文件和 ${buckets.template.length} 个模板文件，赛题与模板齐全，开始完整流程。`, 'success');
          runFullPipeline(activeProject, next);
        } else if (buckets.template.length && !buckets.problem.length) {
          notify(`已导入 ${buckets.template.length} 个模板文件，请继续添加赛题文件。`, 'success');
        } else if (buckets.problem.length && !buckets.template.length) {
          notify(`已导入 ${buckets.problem.length} 个赛题文件，请继续添加论文模板。`, 'success');
        } else {
          notify(`已导入 ${imported.length} 个输入文件，请继续补齐剩余材料。`, 'success');
        }
      } else {
        notify('未导入文件，请使用“选择文件”重试。', 'error');
      }
    } catch (error) {
      notify(error.message || '导入阶段输入失败。', 'error');
    }
  };

  const pickStageInputs = async (kind = 'problem') => addInputs(kind === 'template' ? 'template' : 'problem');

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
        try {
          await desktopApi.restoreCheckpoint(activeProject.root, checkpoint.id);
          await loadProject(activeProject);
          setConfirm(null);
          notify('检查点已恢复', 'success');
        } catch (error) {
          setConfirm(null);
          notify(error.message || '恢复检查点失败，请重试。', 'error');
        }
      },
    });
  };

  const requestRemoveProject = (project) => {
    if (projectIsRunning(displayRuns, project?.root)) {
      notify('任务运行中，停止并保存当前进度后才能移除项目。', 'error');
      return;
    }
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

  const requestHistoricalRunAction = (run, mode) => {
    if (!activeProject?.root || !run || running) return;
    const resume = mode === 'resume';
    const project = activeProject;
    setConfirm({
      title: resume ? '从历史断点继续' : '重新运行历史任务',
      message: resume
        ? `将从运行 ${run.runId.slice(0, 12)} 的已保存断点继续，后续模型调用仍会正常计费。`
        : `将参考运行 ${run.runId.slice(0, 12)} 的阶段范围启动一次全新运行，模型调用会正常计费。`,
      confirmLabel: resume ? '继续运行' : '重新运行',
      action: async () => {
        setConfirm(null);
        markLocalRun(project.root, run.stage || 'analysis');
        setDrawerOpen(true);
        setDrawerTab('logs');
        try {
          const result = resume
            ? await desktopApi.resumeRun(project.root, run.runId)
            : await desktopApi.replayRun(project.root, run.runId);
          if (result?.status === 'paused') notify('运行已暂停，可稍后从同一记录继续。');
          else notify(resume ? '历史运行已继续执行' : '历史任务已重新运行', 'success');
        } catch (error) {
          notify(error.message || (resume ? '恢复历史运行失败。' : '重新运行失败。'), 'error');
        } finally {
          clearLocalRun(project.root);
          await refreshRunCatalog(project).catch(() => {});
          await loadProject(project).catch(() => {});
        }
      },
    });
  };

  const exportFile = async (file, label) => {
    if (!file) return notify(`未找到可导出的${label}`, 'error');
    try {
      const target = await desktopApi.exportFile(file.path);
      if (target) notify(`${label}已导出`, 'success');
    } catch (error) {
      notify(error.message || `${label}导出失败，请重试。`, 'error');
    }
  };

  const compilePaper = async () => {
    if (settings.autoSave) {
      try {
        await saveDocument();
      } catch (error) {
        reportSaveError(error);
        return;
      }
    }
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
    const projectRoot = activeProject?.root;
    setDrawerTab('history');
    setDrawerOpen(true);
    setHistoryLoading(true);
    void refreshRunCatalog()
      .catch((error) => {
        if (projectRoot === activeProjectRef.current?.root) notify(error.message || '无法读取运行记录。', 'error');
      });
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
        running={displayRuns.length > 0}
        activeRuns={displayRuns}
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
                  onSaveError={reportSaveError}
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
              <div className="pipeline-layout"><StageWorkspace project={activeProject} stage={activeStage} snapshot={snapshot} onOpenFile={openWorkspaceFile} onPickFiles={pickStageInputs} onDropFiles={importDroppedFiles} /></div>
            )}
            {activeStage === 'paper' && snapshot && !projectLoading && !pdfFocus ? (
              <PaperCommandBar
                running={running}
                hasPdf={Boolean(snapshot?.paper?.pdf)}
                hasTex={Boolean(snapshot?.paper?.tex)}
                hasMarkdown={Boolean(snapshot?.paper?.markdown)}
                hasDocx={Boolean(snapshot?.paper?.docx)}
                markdownEnabled={snapshot?.profile?.paperFormat === 'markdown'}
                onCompile={compilePaper}
                onAudit={() => runPaperAction('audit')}
                onExportPdf={() => exportFile(snapshot?.paper?.pdf, 'PDF')}
                onExportTex={() => exportFile(snapshot?.paper?.tex, 'LaTeX')}
                onExportMarkdown={() => exportFile(snapshot?.paper?.markdown, 'Markdown')}
                onExportDocx={() => exportFile(snapshot?.paper?.docx, 'DOCX')}
                onReveal={() => revealOutput(snapshot?.paper?.pdf)}
                onOpen={() => snapshot?.paper?.pdf && openExternal(snapshot.paper.pdf)}
              />
            ) : null}
            <RunDrawer
              open={drawerOpen}
              setOpen={setDrawerOpen}
              tab={drawerTab}
              setTab={setDrawerTab}
              logs={logs}
              running={running}
              onStop={stopStage}
              onRestart={() => runFullPipeline()}
              onClear={() => setLogs([])}
              runs={runs}
              selectedRunId={selectedRunId}
              historyLoading={historyLoading}
              onSelectRun={selectHistoricalRun}
              onReplayRun={(run) => requestHistoricalRunAction(run, 'replay')}
              onResumeRun={(run) => requestHistoricalRunAction(run, 'resume')}
              checkpoints={checkpoints}
              onCreateCheckpoint={() => createCheckpoint()}
              onRestoreCheckpoint={requestRestoreCheckpoint}
            />
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
