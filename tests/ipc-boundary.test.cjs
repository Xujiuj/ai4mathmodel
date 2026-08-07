const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');

const mainSource = fs.readFileSync(require.resolve('../electron/main.cjs'), 'utf8');
const preloadPath = require.resolve('../electron/preload.cjs');

function sectionBetween(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert.ok(start >= 0, `missing section: ${startNeedle}`);
  assert.ok(end > start, `missing section end: ${endNeedle}`);
  return source.slice(start, end);
}

test('all renderer IPC handlers stay behind the trusted sender gate', () => {
  const handle = sectionBetween(mainSource, 'function handle(channel', 'function inputKind');
  assert.match(handle, /ipcMain\.handle\(channel/);
  assert.match(handle, /assertTrustedSender\(event\)/);
  assert.equal((mainSource.match(/ipcMain\.handle\(/g) || []).length, 1);
  assert.equal((mainSource.match(/ipcMain\.on\(/g) || []).length, 0);
});

test('pipeline history enforces project scope and public event normalization', () => {
  const history = sectionBetween(mainSource, 'async function readPublicRunHistory', 'async function estimateCost');
  assert.match(history, /root\s*=\s*await assertAllowed\(root\)/);
  assert.match(history, /privateRunStore\(root\)\.readEvents\(/);
  assert.match(history, /oldestFirst:\s*true/);
  assert.match(history, /toPublicPipelineEvent\(event\)/);
  assert.match(history, /\.filter\(Boolean\)/);
  assert.match(mainSource, /handle\('pipeline:history',[\s\S]*?readPublicRunHistory\(/);
});

test('persisted run selection is bounded to the project and uses supervisor recovery', () => {
  const selection = sectionBetween(mainSource, 'function normalizeSelectedRunId', 'async function runSingleStage');
  assert.match(selection, /privateRunStore\(root\)\.loadRun\(normalizedRunId\)/);
  assert.match(selection, /resumeOptionsForState\(selected\.state/);
  assert.match(selection, /runFullPipeline\(selected\.root, settings, \{ \.\.\.recovery, runId: selected\.runId, stages: persistedRunStages\(selected\.state\) \}\)/);
  assert.match(selection, /runFullPipeline\(selected\.root, settings, \{[\s\S]*?resume: false,[\s\S]*?forceResume: false,[\s\S]*?runId: selected\.runId,[\s\S]*?stages: persistedRunStages\(selected\.state\)/);
  const remove = sectionBetween(mainSource, "handle('projects:remove'", "handle('project:snapshot'");
  assert.match(remove, /getRunner\(root\)/);
  assert.match(remove, /activeRunner\?\.run \|\| activeRunner\?\.pipeline/);
});

test('high-risk renderer handlers retain input normalization and scope checks', () => {
  for (const channel of [
    'projects:remove',
    'project:snapshot',
    'project:add-inputs',
    'project:import-dropped',
    'file:read',
    'file:write',
    'pipeline:run-all',
    'paper:compile',
    'paper:check',
    'pipeline:stop',
    'pipeline:history',
    'pipeline:runs',
    'pipeline:resume',
    'pipeline:replay',
    'models:list',
    'settings:save',
  ]) {
    assert.match(mainSource, new RegExp(`handle\\('${channel}'`), channel);
  }

  const settingsSave = sectionBetween(mainSource, "handle('settings:save'", '});\n}');
  assert.match(settingsSave, /normalizeSettings\(settings\)/);
  assert.match(settingsSave, /cleanBaseUrl\(/);
  assert.match(settingsSave, /writeApiKey\(/);

  const modelList = sectionBetween(mainSource, "handle('models:list'", 'const updaterBridge = createAutoUpdaterBridge');
  assert.match(modelList, /normalizeSettings\(rawSettings\)/);
  assert.match(modelList, /CONNECTION_KEYS\.includes\(connection\)/);
  assert.match(modelList, /discoverModels\(selected, \{[\s\S]*?connectionType:\s*canonicalKey/);
});

test('preload runHistory forwards only through the pipeline history IPC channel', async () => {
  let exposed;
  const calls = [];
  const electron = {
    ipcRenderer: {
      invoke: async (...args) => {
        calls.push(args);
        return { events: [] };
      },
      on() {},
      removeListener() {},
    },
    webUtils: { getPathForFile: () => '' },
    contextBridge: {
      exposeInMainWorld(name, api) {
        assert.equal(name, 'modelingDesktop');
        exposed = api;
      },
    },
  };
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') return electron;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[preloadPath];
    require(preloadPath);
  } finally {
    Module._load = originalLoad;
  }

  await exposed.runHistory('C:\\workspace\\project', { runId: 'run-1', afterSeq: 12, limit: 25 });
  assert.deepEqual(calls, [[
    'pipeline:history',
    { root: 'C:\\workspace\\project', runId: 'run-1', afterSeq: 12, limit: 25 },
  ]]);
});

test('preload exposes bounded run selection through dedicated IPC channels', async () => {
  let exposed;
  const calls = [];
  const electron = {
    ipcRenderer: {
      invoke: async (...args) => {
        calls.push(args);
        return [];
      },
      on() {},
      removeListener() {},
    },
    webUtils: { getPathForFile: () => '' },
    contextBridge: {
      exposeInMainWorld(name, api) {
        assert.equal(name, 'modelingDesktop');
        exposed = api;
      },
    },
  };
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') return electron;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[preloadPath];
    require(preloadPath);
  } finally {
    Module._load = originalLoad;
  }

  await exposed.listRuns('C:\\workspace\\project', { limit: 20 });
  await exposed.resumeRun('C:\\workspace\\project', 'run-1');
  await exposed.replayRun('C:\\workspace\\project', 'run-1');
  assert.deepEqual(calls, [
    ['pipeline:runs', { root: 'C:\\workspace\\project', limit: 20 }],
    ['pipeline:resume', { root: 'C:\\workspace\\project', runId: 'run-1' }],
    ['pipeline:replay', { root: 'C:\\workspace\\project', runId: 'run-1' }],
  ]);
});
