const desktopUnavailable = () => Promise.reject(new Error('此功能需要在数模工坊桌面端中运行。'));

function browserPreviewApi() {
  return {
    appInfo: async () => ({ version: '0.1.0', platform: 'browser-preview', electron: null, desktopRuntime: false }),
    listProjects: async () => [],
    getSettings: async () => ({}),
    activeRun: async () => null,
    activeRuns: async () => [],
    listCheckpoints: async () => [],
    onRunEvent: () => () => {},
    onUpdaterEvent: () => () => {},
    addProject: desktopUnavailable,
    createProject: desktopUnavailable,
    removeProject: desktopUnavailable,
    snapshot: desktopUnavailable,
    addInputs: desktopUnavailable,
    importDroppedFiles: desktopUnavailable,
    createCheckpoint: desktopUnavailable,
    restoreCheckpoint: desktopUnavailable,
    readFile: desktopUnavailable,
    readSpreadsheet: desktopUnavailable,
    writeFile: desktopUnavailable,
    fileUrl: desktopUnavailable,
    exportFile: desktopUnavailable,
    revealPath: desktopUnavailable,
    openPath: desktopUnavailable,
    runFullPipeline: desktopUnavailable,
    compilePaper: desktopUnavailable,
    checkPaper: desktopUnavailable,
    stopStage: desktopUnavailable,
    exportDiagnostics: desktopUnavailable,
    checkForUpdates: desktopUnavailable,
    downloadUpdate: desktopUnavailable,
    installUpdate: desktopUnavailable,
    listComponentUpdates: desktopUnavailable,
    listModels: desktopUnavailable,
    importLocalModelConfig: desktopUnavailable,
    saveSettings: desktopUnavailable,
  };
}

export const isDesktopRuntime = Boolean(window.modelingDesktop);
export const desktopApi = window.modelingDesktop || browserPreviewApi();
