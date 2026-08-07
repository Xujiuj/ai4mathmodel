const { app, BrowserWindow } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const appRoot = path.resolve(__dirname, '..');
const projectRoot = path.resolve(process.env.MATH_MODEL_SERVICE_TEST_ROOT || path.join(appRoot, '..'));
const userData = process.env.MATH_MODEL_USER_DATA
  || path.join(process.env.APPDATA || '', 'math-modeling-workbench');

app.setName('math-modeling-workbench');
app.setAppPath(appRoot);
app.setPath('userData', userData);
process.env.VITE_DEV_SERVER_URL = '';
process.env.MATH_MODEL_TEST_DISABLE_STARTUP_RESUME = '1';

function rootKey(root) {
  return path.resolve(root).replace(/[\\/]+$/, '').toLowerCase();
}

function registerRegressionProject() {
  const file = path.join(userData, 'projects.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let projects = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    projects = Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (projects.some((project) => project?.root && rootKey(project.root) === rootKey(projectRoot))) return false;
  const now = new Date().toISOString();
  projects.unshift({
    id: crypto.createHash('sha1').update(projectRoot).digest('hex').slice(0, 12),
    name: path.basename(projectRoot),
    root: projectRoot,
    createdAt: now,
    lastOpenedAt: now,
  });
  fs.writeFileSync(file, `${JSON.stringify(projects, null, 2)}\n`, { mode: 0o600 });
  return true;
}

const autoRegisteredProject = registerRegressionProject();

require('../electron/main.cjs');

function waitForWindow() {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const timer = setInterval(() => {
      const window = BrowserWindow.getAllWindows()[0];
      if (window && !window.webContents.isLoading()) {
        clearInterval(timer);
        resolve(window);
        return;
      }
      attempts += 1;
      if (attempts >= 120) {
        clearInterval(timer);
        reject(new Error('Electron application window did not become ready.'));
      }
    }, 250);
  });
}

function emit(type, payload) {
  process.stdout.write(`${type} ${JSON.stringify(payload)}\n`);
}

async function run() {
  const window = await waitForWindow();
  window.hide();
  window.webContents.on('console-message', (_event, _level, message) => {
    if (!message.startsWith('__HOSTED_PIPELINE_EVENT__')) return;
    process.stdout.write(`${message.slice('__HOSTED_PIPELINE_EVENT__'.length)}\n`);
  });

  const result = await window.webContents.executeJavaScript(`(async () => {
    const api = window.modelingDesktop;
    const root = ${JSON.stringify(projectRoot)};
    const project = (await api.listProjects()).find((item) => item.root.toLowerCase() === root.toLowerCase());
    if (!project) throw new Error('Target project is not registered in the desktop application.');

    const before = await api.snapshot(root);
    let account = await api.getAccount();
    if (!account.configured) throw new Error('Hosted gateway is not configured in the desktop application.');
    let registeredForRegression = false;
    if (!account.signedIn) {
      const suffix = crypto.randomUUID().replaceAll('-', '');
      await api.registerAccount('pipeline-regression-' + suffix + '@example.invalid', 'P!' + suffix + 'Regression');
      registeredForRegression = true;
      account = await api.getAccount();
    }
    if (!account.signedIn) throw new Error('Hosted account registration did not establish a session.');
    const hasInput = (snapshot, prefix) => (snapshot?.files || []).some((file) => file.relative.startsWith(prefix));
    if (!hasInput(before, 'inputs/problem/') || !hasInput(before, 'inputs/template/')) {
      throw new Error('The registered project does not contain both the problem and LaTeX template.');
    }

    const checkpoint = before?.paper?.tex
      ? await api.createCheckpoint(root, 'hosted-service-regression-before-run')
      : null;
    const startedAt = Date.now();
    const unsubscribe = api.onRunEvent((event) => {
      const compact = {
        type: event?.type || null,
        status: event?.status || null,
        stage: event?.stage || null,
      };
      console.log('__HOSTED_PIPELINE_EVENT__' + JSON.stringify(compact));
    });

    let runResult;
    try {
      runResult = await api.runFullPipeline(root);
    } finally {
      unsubscribe();
      if (registeredForRegression) await api.logoutAccount();
    }

    const after = await api.snapshot(root);
    const summarizeStages = (snapshot) => (snapshot?.stages || []).map((stage) => ({
      key: stage.key,
      status: stage.uiStatus,
    }));
    return {
      root,
      elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
      runStatus: runResult?.status || 'completed',
      checkpointCreated: Boolean(checkpoint?.id),
      autoRegisteredProject: ${JSON.stringify(autoRegisteredProject)},
      registeredForRegression,
      account: {
        configured: Boolean(account.configured),
        signedIn: Boolean(account.signedIn),
        imageEnabled: Boolean(account.imageEnabled),
      },
      beforeStages: summarizeStages(before),
      afterStages: summarizeStages(after),
      artifacts: {
        analysisPdf: (after?.files || []).some((file) => file.relative === 'work/01_analysis/analysis.pdf'),
        aggregateResults: (after?.files || []).some((file) => file.relative === 'work/02_solving/aggregate_results.yaml'),
        paperTex: Boolean(after?.paper?.tex),
        paperPdf: Boolean(after?.paper?.pdf),
        paperFigures: after?.paper?.figures?.length || 0,
      },
    };
  })()`);

  emit('HOSTED_PIPELINE_RESULT', result);
}

app.whenReady()
  .then(run)
  .then(() => app.quit())
  .catch((error) => {
    emit('HOSTED_PIPELINE_FAILURE', { name: error?.name || 'Error', message: error?.message || 'Unknown failure' });
    app.exitCode = 1;
    app.quit();
  });
