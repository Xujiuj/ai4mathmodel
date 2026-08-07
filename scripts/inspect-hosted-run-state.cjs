const { app, safeStorage } = require('electron');
const path = require('node:path');

const appRoot = path.resolve(__dirname, '..');
const projectRoot = path.resolve(process.env.MATH_MODEL_SERVICE_TEST_ROOT || path.join(appRoot, '..'));
const userData = process.env.MATH_MODEL_USER_DATA
  || path.join(process.env.APPDATA || '', 'math-modeling-workbench');

app.setName('math-modeling-workbench');
app.setAppPath(appRoot);
app.setPath('userData', userData);

function compact(value, limit = 500) {
  return String(value || '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .slice(0, limit);
}

app.whenReady().then(async () => {
  const { createRunStore } = require('../electron/supervisor/run-store.cjs');
  const store = createRunStore(projectRoot, {
    baseDirectory: path.join(userData, 'runtime'),
    codec: {
      seal: (value) => safeStorage.encryptString(value).toString('base64'),
      open: (value) => safeStorage.decryptString(Buffer.from(value, 'base64')),
    },
  });
  const state = await store.load();
  const events = await store.readEvents({ runId: state?.runId, limit: 80 });
  const result = {
    found: Boolean(state),
    runId: state?.runId || null,
    status: state?.status || null,
    currentStage: state?.currentStage || null,
    tasks: Object.values(state?.tasks || {}).map((task) => ({
      stage: task.stage,
      status: task.status,
      attemptCount: task.attemptCount,
      lastError: compact(task.lastError?.reason || task.lastError?.message || task.lastError?.category),
    })),
    events: events.map((event) => ({
      seq: event.seq,
      type: event.type,
      taskId: event.taskId,
      category: compact(event.payload?.category, 120),
      reason: compact(event.payload?.reason || event.payload?.summary, 500),
    })),
  };
  process.stdout.write(`HOSTED_RUN_STATE ${JSON.stringify(result)}\n`);
  app.quit();
}).catch((error) => {
  process.stdout.write(`HOSTED_RUN_STATE_FAILURE ${JSON.stringify({ name: error?.name || 'Error', message: compact(error?.message) })}\n`);
  app.exitCode = 1;
  app.quit();
});
