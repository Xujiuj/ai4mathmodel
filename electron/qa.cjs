const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const ExcelJS = require('exceljs');

const profile = path.join(app.getPath('temp'), `math-modeling-workbench-qa-${Date.now()}`);
const dummyApiKeys = {
  reasoning: `qa-reasoning-${Date.now()}`,
  writing: `qa-writing-${Date.now()}`,
  image: `qa-image-${Date.now()}`,
};
const spreadsheetFixture = path.resolve(__dirname, '..', '..', 'work', '04_review', 'desktop-preview-qa.xlsx');
const unpairedTexFixture = path.resolve(__dirname, '..', '..', 'work', '03_paper', 'desktop-unpaired-qa.tex');
const textCodeFixture = path.resolve(__dirname, '..', '..', 'work', '02_solving', 'desktop-source-qa.modelcode');
fs.mkdirSync(path.dirname(spreadsheetFixture), { recursive: true });
fs.mkdirSync(path.dirname(unpairedTexFixture), { recursive: true });
fs.mkdirSync(path.dirname(textCodeFixture), { recursive: true });
fs.writeFileSync(unpairedTexFixture, Array.from({ length: 700 }, (_, index) => `% QA line ${index + 1}`).join('\n'), 'utf8');
fs.writeFileSync(textCodeFixture, 'function qaTextPreview() {\n  return "plain-text-code";\n}\n', 'utf8');

async function createSpreadsheetFixture() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('结果');
  sheet.addRows([['策略', '得分'], ['A', 0.81], ['B', 0.76]]);
  await workbook.xlsx.writeFile(spreadsheetFixture);
}
process.on('exit', () => {
  fs.rmSync(spreadsheetFixture, { force: true });
  fs.rmSync(unpairedTexFixture, { force: true });
  fs.rmSync(textCodeFixture, { force: true });
});

const modelRequests = [];
const modelServer = http.createServer((request, response) => {
  modelRequests.push({ path: request.url, authorization: request.headers.authorization || '' });
  response.writeHead(200, { 'Content-Type': 'application/json' });
  if (request.url === '/api/tags') {
    response.end(JSON.stringify({ models: [{ name: 'qa-image-model' }, { name: 'qa-image-backup' }] }));
    return;
  }
  response.end(JSON.stringify({ data: [{ id: 'qa-primary-model' }, { id: 'qa-secondary-model' }] }));
});

function startModelServer() {
  return new Promise((resolve, reject) => {
    modelServer.once('error', reject);
    modelServer.listen(0, '127.0.0.1', () => resolve(modelServer.address().port));
  });
}
app.setPath('userData', profile);
app.setAppPath(path.resolve(__dirname, '..'));

process.env.VITE_DEV_SERVER_URL = '';
require('./main.cjs');

async function waitForWindow() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const window = BrowserWindow.getAllWindows()[0];
    if (window && !window.webContents.isLoading()) return window;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Application window did not become ready.');
}

app.whenReady().then(async () => {
  await createSpreadsheetFixture();
  const modelPort = await startModelServer();
  const modelBaseUrl = `http://127.0.0.1:${modelPort}`;
  const window = await waitForWindow();
  window.setContentSize(1536, 1024);
  await new Promise((resolve) => setTimeout(resolve, 700));
  const output = await window.webContents.executeJavaScript(`(async () => {
    const api = window.modelingDesktop;
    const projects = await api.listProjects();
    if (!projects.length) throw new Error('No workspace project was registered.');
    const project = projects[0];
    const snapshot = await api.snapshot(project.root);
    const pairedTex = snapshot.files.find((file) => file.ext === '.tex' && snapshot.files.some((candidate) => candidate.ext === '.pdf' && candidate.relative.slice(0, -4).toLowerCase() === file.relative.slice(0, -4).toLowerCase()));
    const pairedPdf = pairedTex ? snapshot.files.find((file) => file.ext === '.pdf' && file.relative.slice(0, -4).toLowerCase() === pairedTex.relative.slice(0, -4).toLowerCase()) : null;
    window.__qaCsvRelative = snapshot.files.find((file) => file.ext === '.csv')?.relative || '';
    window.__qaPaperPdfRelative = pairedPdf?.relative || '';
    window.__qaPaperTexRelative = pairedTex?.relative || '';
    window.__qaTextCodeRelative = snapshot.files.find((file) => file.name === 'desktop-source-qa.modelcode')?.relative || '';
    const pdfUrl = snapshot.paper.pdf ? await api.fileUrl(snapshot.paper.pdf.path) : '';
    const pdfPreview = pdfUrl ? await fetch(pdfUrl).then(async (response) => ({
      ok: response.ok,
      status: response.status,
      contentType: response.headers.get('content-type'),
      bytes: (await response.arrayBuffer()).byteLength,
    })) : null;
    const original = await api.getSettings();
    window.__qaProject = project;
    window.__qaOriginalSettings = original;
    const candidateSettings = {
      ...original,
      connections: {
        reasoning: { baseUrl: ${JSON.stringify(modelBaseUrl)} + '/v1', protocol: 'auto', model: 'qa-primary-model', apiKey: ${JSON.stringify(dummyApiKeys.reasoning)} },
        writing: { baseUrl: ${JSON.stringify(modelBaseUrl)} + '/v1', protocol: 'auto', model: 'qa-secondary-model', apiKey: ${JSON.stringify(dummyApiKeys.writing)} },
        image: { baseUrl: ${JSON.stringify(modelBaseUrl)}, protocol: 'ollama', model: 'qa-image-model', apiKey: ${JSON.stringify(dummyApiKeys.image)} }
      }
    };
    const discoveredBeforeSave = Object.fromEntries(await Promise.all(['reasoning', 'writing', 'image'].map(async (connection) => [connection, await api.listModels(candidateSettings, connection)])));
    const saved = await api.saveSettings(candidateSettings);
    window.__qaCredentialSettings = saved;
    const reread = await api.getSettings();
    const discoveredAfterSave = Object.fromEntries(await Promise.all(['reasoning', 'writing', 'image'].map(async (connection) => [connection, await api.listModels(reread, connection)])));
    const existingCheckpoints = await api.listCheckpoints(project.root);
    const checkpoint = existingCheckpoints.find((item) => item.label === '自动化验收检查点')
      || await api.createCheckpoint(project.root, '自动化验收检查点');
    const checkpoints = await api.listCheckpoints(project.root);
    return {
      project: { name: project.name, root: project.root },
      fileCount: snapshot.files.length,
      paper: {
        pdf: snapshot.paper.pdf?.name || null,
        tex: snapshot.paper.tex?.name || null,
        figures: snapshot.paper.figures.length,
        pdfPreview,
      },
      settings: {
        models: Object.fromEntries(Object.entries(saved.connections).map(([key, value]) => [key, value.model])),
        apiKeysConfigured: Object.fromEntries(Object.entries(reread.connections).map(([key, value]) => [key, value.apiKeyConfigured])),
        apiKeysHiddenOnSave: Object.values(saved.connections).every((value) => value.apiKey === ''),
        apiKeysHiddenOnRead: Object.values(reread.connections).every((value) => value.apiKey === ''),
        discoveryBeforeSave: Object.fromEntries(Object.entries(discoveredBeforeSave).map(([key, value]) => [key, value.models])),
        discoveryAfterSave: Object.fromEntries(Object.entries(discoveredAfterSave).map(([key, value]) => [key, value.models]))
      },
      checkpoint: {
        id: checkpoint.id,
        fileCount: checkpoint.fileCount,
        listed: checkpoints.some((item) => item.id === checkpoint.id)
      },
      title: document.title,
      bodyHasProject: document.body.innerText.includes(project.name),
      fullPipelineApiAvailable: typeof api.runFullPipeline === 'function'
    };
  })()`);
  const settingsPath = path.join(profile, 'settings.json');
  const credentialsPath = path.join(profile, 'credentials.json');
  const settingsRaw = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf8') : '';
  const credentialsRaw = fs.existsSync(credentialsPath) ? fs.readFileSync(credentialsPath, 'utf8') : '';
  const credentialEntries = credentialsRaw ? Object.keys(JSON.parse(credentialsRaw).entries || {}) : [];
  output.security = {
    credentialFileCreated: fs.existsSync(credentialsPath),
    encryptedEntryCount: credentialEntries.length,
    settingsContainPlaintext: Object.values(dummyApiKeys).some((key) => settingsRaw.includes(key)),
    credentialsContainPlaintext: Object.values(dummyApiKeys).some((key) => credentialsRaw.includes(key)),
    modelRequests: modelRequests.slice(),
  };
  output.navigation = await window.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const projectButton = document.querySelector('.project-node.active .project-select');
    if (!projectButton) throw new Error('Active project button was not rendered.');
    const initiallyExpanded = projectButton.getAttribute('aria-expanded') === 'true' && Boolean(document.querySelector('.project-node.active .stage-tree'));
    projectButton.click();
    await wait(60);
    const collapsed = projectButton.getAttribute('aria-expanded') === 'false' && !document.querySelector('.project-node.active .stage-tree');
    projectButton.click();
    await wait(60);
    const expandedAgain = projectButton.getAttribute('aria-expanded') === 'true' && Boolean(document.querySelector('.project-node.active .stage-tree'));
    const fullPipelineAction = [...document.querySelectorAll('.summary-actions button')].some((button) => button.textContent.includes('一键完成求解'));
    return { initiallyExpanded, collapsed, expandedAgain, fullPipelineAction };
  })()`);
  const screenshot = await window.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, '..', 'design-implementation-v2.png'), screenshot.toPNG());
  output.filePreviewInteraction = await window.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const toggle = [...document.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === '项目文件');
    if (!toggle) throw new Error('Project files action was not rendered.');
    for (let attempt = 0; attempt < 4 && !document.querySelector('.outline-panel'); attempt += 1) {
      toggle.click();
      await wait(180);
    }
    if (!document.querySelector('.outline-panel')) throw new Error('Project file panel was not rendered.');
    const folderLabels = [...document.querySelectorAll('.file-tree-folder-toggle span')].map((item) => item.textContent.trim());
    const selectFile = async (relative) => {
      const search = document.querySelector('.outline-search input');
      if (!search) throw new Error('Project file search was not rendered.');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(search, relative);
      search.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(80);
      const button = [...document.querySelectorAll('.outline-files button')].find((item) => item.title?.startsWith(relative + '\\n'));
      if (!button) throw new Error('File was not listed: ' + relative);
      button.click();
      await wait(500);
    };
    if (!window.__qaPaperTexRelative || !window.__qaPaperPdfRelative) throw new Error('No exact TeX/PDF pair was found for QA.');
    await selectFile(window.__qaPaperTexRelative);
    const textEditorVisible = Boolean(document.querySelector('.source-surface .cm-editor'));
    let compareButton = [...document.querySelectorAll('.document-tabs button')].find((item) => item.textContent.includes('对照模式'));
    const texCompareEnabled = Boolean(compareButton && !compareButton.disabled);
    compareButton?.click();
    await wait(160);
    const texCompareSource = document.querySelector('.compare-source .source-toolbar span')?.textContent.trim() || '';
    await selectFile('work/03_paper/desktop-unpaired-qa.tex');
    compareButton = [...document.querySelectorAll('.document-tabs button')].find((item) => item.textContent.includes('对照模式'));
    const unpairedCompareDisabled = Boolean(compareButton?.disabled);
    const editorScroller = document.querySelector('.source-surface .cm-scroller');
    const editorCanScroll = Boolean(editorScroller && editorScroller.scrollHeight > editorScroller.clientHeight);
    if (editorScroller) editorScroller.scrollTop = Math.min(240, editorScroller.scrollHeight - editorScroller.clientHeight);
    const editorScrollMoved = Boolean(editorScroller && editorScroller.scrollTop > 0);
    const editorScrollMetrics = Object.fromEntries(['.source-surface', '.source-surface .cm-theme', '.source-surface .cm-editor', '.source-surface .cm-scroller', '.source-surface .cm-content'].map((selector) => {
      const element = document.querySelector(selector);
      return [selector, element ? { clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, overflow: getComputedStyle(element).overflow } : null];
    }));
    if (!window.__qaTextCodeRelative) throw new Error('Unknown-extension text fixture was not indexed.');
    await selectFile(window.__qaTextCodeRelative);
    const unknownTextEditorVisible = Boolean(document.querySelector('.source-surface .cm-editor'));
    const unknownTextContentVisible = Boolean(document.querySelector('.source-surface .cm-content')?.textContent.includes('qaTextPreview'));
    if (!window.__qaCsvRelative) throw new Error('No CSV file was found in the workspace.');
    await selectFile(window.__qaCsvRelative);
    const csvGridVisible = Boolean(document.querySelector('.spreadsheet-grid'));
    await selectFile('work/04_review/desktop-preview-qa.xlsx');
    const spreadsheetGrid = document.querySelector('.spreadsheet-grid');
    await selectFile(window.__qaPaperPdfRelative);
    const pdfFrame = document.querySelector('iframe.native-pdf');
    const pdfFocusWorkspace = document.querySelector('.pdf-document-workspace');
    const pdfDocumentTabsHidden = !document.querySelector('.document-tabs');
    const pdfFilePanelHidden = !document.querySelector('.utility-sidebar');
    const pdfCommandBarHidden = !document.querySelector('.paper-command-bar');
    const runHistory = [...document.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === '运行记录' || button.textContent.includes('运行记录'));
    if (!runHistory) throw new Error('Run-history action was not rendered.');
    runHistory.click();
    await wait(100);
    const runDrawer = document.querySelector('.run-drawer');
    return {
      folderTreeVisible: folderLabels.includes('inputs') && folderLabels.includes('work'),
      textEditorVisible,
      pdfFrameVisible: Boolean(pdfFrame),
      pdfFrameUsesProjectProtocol: Boolean(pdfFrame?.getAttribute('src')?.startsWith('modeling-file://local/')),
      pdfFocusWorkspace: Boolean(pdfFocusWorkspace),
      pdfDocumentTabsHidden,
      pdfFilePanelHidden,
      pdfCommandBarHidden,
      texCompareEnabled,
      texCompareUsesExactSource: texCompareSource === window.__qaPaperTexRelative,
      unpairedCompareDisabled,
      editorCanScroll,
      editorScrollMoved,
      editorScrollMetrics,
      unknownTextEditorVisible,
      unknownTextContentVisible,
      csvGridVisible,
      spreadsheetGridVisible: Boolean(spreadsheetGrid),
      spreadsheetShowsFixture: Boolean(spreadsheetGrid?.textContent.includes('策略')),
      runHistoryOpened: Boolean(runDrawer),
      runHistoryFocused: document.activeElement === runDrawer,
    };
  })()`);
  const fileTreeScreenshot = await window.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, '..', 'file-tree-implementation.png'), fileTreeScreenshot.toPNG());
  window.setContentSize(800, 600);
  await new Promise((resolve) => setTimeout(resolve, 300));
  output.responsive = await window.webContents.executeJavaScript(`(() => {
    const utility = document.querySelector('.utility-sidebar');
    return {
      viewport: [window.innerWidth, window.innerHeight],
      document: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
      utilityOverlay: Boolean(utility && getComputedStyle(utility).position === 'absolute'),
      inlinePreviewVisible: Boolean(document.querySelector('iframe.native-pdf, .spreadsheet-grid, .image-preview-canvas')),
    };
  })()`);
  output.settingsModal = await window.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent.includes('设置与模型'));
    if (!button) throw new Error('Settings action was not rendered.');
    button.click();
    await wait(120);
    const modal = document.querySelector('.modal');
    const scrollSurface = document.querySelector('.settings-content');
    const modeTabs = [...document.querySelectorAll('.settings-mode-tabs button')];
    const hostedTab = modeTabs.find((item) => item.textContent.includes('官方托管'));
    const localTab = modeTabs.find((item) => item.textContent.includes('自带模型'));
    hostedTab?.click();
    await wait(80);
    const hostedPanelVisible = Boolean(document.querySelector('.account-panel'))
      && !document.querySelector('.connection-block');
    localTab?.click();
    await wait(80);
    const tabs = [...document.querySelectorAll('.settings-connection-tabs button')];
    const titles = [];
    let connectionActionVisible = true;
    for (const tab of tabs) {
      tab.click();
      await wait(40);
      titles.push(document.querySelector('.connection-block h3')?.textContent.trim() || '');
      connectionActionVisible = connectionActionVisible && Boolean([...document.querySelectorAll('.connection-block button')].find((item) => item.textContent.includes('测试连接并读取模型')));
    }
    const rect = modal?.getBoundingClientRect();
    const canScroll = Boolean(scrollSurface && scrollSurface.scrollHeight > scrollSurface.clientHeight);
    if (scrollSurface) scrollSurface.scrollTop = scrollSurface.scrollHeight;
    const scrollMoved = Boolean(scrollSurface && scrollSurface.scrollTop > 0);
    if (scrollSurface) scrollSurface.scrollTop = 0;
    return {
      twoModeTabs: modeTabs.length === 2,
      hostedPanelVisible,
      threeConnectionTabs: tabs.length === 3,
      switchesConnections: titles.join('|') === '推理与代码模型|文本模型|生图模型（可选）',
      connectionActionVisible,
      appearanceControls: document.querySelectorAll('.appearance-segments button').length === 3,
      localConfigImportActions: document.querySelectorAll('.local-config-actions button').length === 2,
      fitsViewport: Boolean(rect && rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight),
      canScroll,
      scrollMoved,
    };
  })()`);
  const settingsScreenshot = await window.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, '..', 'settings-modal-800.png'), settingsScreenshot.toPNG());
  await window.webContents.executeJavaScript(`document.querySelector('.modal > header button')?.click()`);
  const cleanup = await window.webContents.executeJavaScript(`(async () => {
    const api = window.modelingDesktop;
    await api.saveSettings({ ...window.__qaCredentialSettings, appearance: 'system' });
    const systemAppearance = await api.getSettings();
    await api.saveSettings({
      ...window.__qaCredentialSettings,
      connections: Object.fromEntries(Object.entries(window.__qaCredentialSettings.connections).map(([key, value]) => [key, { ...value, apiKey: '', clearApiKey: true }]))
    });
    const afterClear = await api.getSettings();
    await api.saveSettings(window.__qaOriginalSettings);
    const removal = await api.removeProject(window.__qaProject.root);
    const projectsAfterRemove = await api.listProjects();
    const projectsAfterReload = await api.listProjects();
    return {
      systemAppearancePersisted: systemAppearance.appearance === 'system',
      credentialsCleared: Object.values(afterClear.connections).every((value) => value.apiKeyConfigured === false && value.apiKey === ''),
      removal,
      projectCountAfterRemove: projectsAfterRemove.length,
      projectCountAfterReload: projectsAfterReload.length,
    };
  })()`);
  output.cleanup = cleanup;
  assert.equal(output.paper.pdfPreview?.ok, true);
  assert.equal(output.paper.pdfPreview?.contentType, 'application/pdf');
  assert.equal(output.fullPipelineApiAvailable, true);
  assert.deepEqual(output.settings.models, {
    reasoning: 'qa-primary-model',
    writing: 'qa-secondary-model',
    image: 'qa-image-model',
  });
  assert.equal(Object.values(output.settings.apiKeysConfigured).every(Boolean), true);
  assert.equal(output.settings.apiKeysHiddenOnSave, true);
  assert.equal(output.settings.apiKeysHiddenOnRead, true);
  assert.equal(Object.values(output.settings.discoveryBeforeSave).every((models) => models.length >= 2), true);
  assert.equal(Object.values(output.settings.discoveryAfterSave).every((models) => models.length >= 2), true);
  assert.equal(output.security.encryptedEntryCount, 3);
  assert.equal(output.security.settingsContainPlaintext, false);
  assert.equal(output.security.credentialsContainPlaintext, false);
  assert.equal(Object.values(dummyApiKeys).every((key) => output.security.modelRequests.some((request) => request.authorization === `Bearer ${key}`)), true);
  for (const [key, value] of Object.entries(output.navigation)) {
    assert.equal(value, true, `Navigation interaction failed: ${key}`);
  }
  for (const [key, value] of Object.entries(output.filePreviewInteraction).filter(([, value]) => typeof value === 'boolean')) {
    assert.equal(value, true, `File interaction failed: ${key}`);
  }
  assert.deepEqual(output.responsive.viewport, output.responsive.document);
  assert.equal(output.responsive.utilityOverlay, false);
  for (const [key, value] of Object.entries(output.settingsModal)) {
    assert.equal(value, true, `Settings modal interaction failed: ${key}`);
  }
  assert.equal(output.cleanup.systemAppearancePersisted, true);
  assert.equal(output.cleanup.credentialsCleared, true);
  assert.equal(output.cleanup.projectCountAfterRemove, 0);
  assert.equal(output.cleanup.projectCountAfterReload, 0);
  const target = path.join(__dirname, '..', 'electron-qa-result.json');
  fs.writeFileSync(target, JSON.stringify(output, null, 2), 'utf8');
  console.log(JSON.stringify(output, null, 2));
  window.destroy();
  modelServer.close();
  app.quit();
}).catch((error) => {
  console.error(error);
  modelServer.close();
  app.exit(1);
});
