const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('modelingDesktop', {
  appInfo: () => invoke('app:info'),
  listProjects: () => invoke('projects:list'),
  addProject: () => invoke('projects:add'),
  createProject: (name) => invoke('projects:create', { name }),
  removeProject: (root) => invoke('projects:remove', { root }),
  snapshot: (root) => invoke('project:snapshot', { root }),
  addInputs: (root, kind) => invoke('project:add-inputs', { root, kind }),
  importDroppedFiles: (root, kind, files) => invoke('project:import-dropped', {
    root,
    kind,
    paths: files.map((file) => webUtils.getPathForFile(file)).filter(Boolean),
  }),
  listCheckpoints: (root) => invoke('checkpoint:list', { root }),
  createCheckpoint: (root, label) => invoke('checkpoint:create', { root, label }),
  restoreCheckpoint: (root, id) => invoke('checkpoint:restore', { root, id }),
  readFile: (path) => invoke('file:read', { path }),
  readSpreadsheet: (path) => invoke('file:spreadsheet', { path }),
  writeFile: (path, content) => invoke('file:write', { path, content }),
  fileUrl: (path) => invoke('file:url', { path }),
  exportFile: (path) => invoke('file:export', { path }),
  revealPath: (path) => invoke('shell:reveal', { path }),
  openPath: (path) => invoke('shell:open', { path }),
  runFullPipeline: (root) => invoke('pipeline:run-all', { root }),
  compilePaper: (root) => invoke('paper:compile', { root }),
  checkPaper: (root) => invoke('paper:check', { root }),
  stopStage: () => invoke('pipeline:stop'),
  activeRun: () => invoke('pipeline:active'),
  listModels: (settings, connection) => invoke('models:list', { settings, connection }),
  importLocalModelConfig: (source) => invoke('settings:import-local', { source }),
  getSettings: () => invoke('settings:get'),
  saveSettings: (settings) => invoke('settings:save', settings),
  onRunEvent: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('pipeline:event', handler);
    return () => ipcRenderer.removeListener('pipeline:event', handler);
  },
});
