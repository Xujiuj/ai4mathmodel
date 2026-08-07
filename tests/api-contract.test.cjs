const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const preloadPath = require.resolve('../electron/preload.cjs');
const mainPath = require.resolve('../electron/main.cjs');

function loadPreloadApi() {
  let exposed;
  const listeners = new Map();
  const ipcRenderer = {
    invoke: async () => null,
    on(channel, handler) {
      listeners.set(channel, handler);
    },
    removeListener(channel, handler) {
      if (listeners.get(channel) === handler) listeners.delete(channel);
    },
  };
  const electron = {
    ipcRenderer,
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
  assert.ok(exposed);
  return { api: exposed, listeners };
}

async function loadBrowserApi() {
  const previousWindow = global.window;
  try {
    global.window = {};
    const moduleUrl = `${pathToFileURL(require.resolve('../src/api.js')).href}?contract=${Date.now()}-${Math.random()}`;
    return await import(moduleUrl).then((module) => module.desktopApi);
  } finally {
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
  }
}

test('preload and browser APIs expose the same callable surface', async () => {
  const { api: preloadApi } = loadPreloadApi();
  const browserApi = await loadBrowserApi();
  assert.deepEqual(Object.keys(browserApi).sort(), Object.keys(preloadApi).sort());
  for (const name of Object.keys(preloadApi)) assert.equal(typeof browserApi[name], typeof preloadApi[name], name);
});

test('every renderer invoke channel has a trusted main-process handler', () => {
  const preloadSource = fs.readFileSync(preloadPath, 'utf8');
  const mainSource = fs.readFileSync(mainPath, 'utf8');
  const invoked = [...preloadSource.matchAll(/\binvoke\('([^']+)'/g)].map((match) => match[1]);
  const handled = [...mainSource.matchAll(/(?<!\.)\bhandle\('([^']+)'/g)].map((match) => match[1]);

  assert.deepEqual([...new Set(invoked)].sort(), [...new Set(handled)].sort());
});

test('event subscriptions return an unsubscribe that removes the matching listener', () => {
  const { api, listeners } = loadPreloadApi();
  for (const [method, channel] of [['onRunEvent', 'pipeline:event'], ['onUpdaterEvent', 'updater:event'], ['onComponentEvent', 'components:event']]) {
    const callback = () => {};
    const unsubscribe = api[method](callback);
    assert.equal(typeof unsubscribe, 'function', method);
    assert.equal(listeners.has(channel), true, channel);
    unsubscribe();
    assert.equal(listeners.has(channel), false, channel);
  }
});
