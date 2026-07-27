const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { app } = require('electron');

const SECRET_KEYS = /^(apiKey|api_key|authToken|token|password|secret|authorization|bearer)$/i;

function redactUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    parsed.search = '';
    parsed.username = '';
    parsed.password = '';
    return parsed.origin + parsed.pathname;
  } catch {
    return '[invalid-url]';
  }
}

function redactString(text) {
  return String(text)
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, '[redacted-key]')
    .replace(/\b[A-Za-z0-9_-]{48,}\b/g, '[redacted-token]')
    .replace(/(?:\/Users\/|C:\\Users\\)[^\\/\s]+/gi, (match) => match.replace(/[^\\/]+$/, '<user>'))
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|token|secret)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]');
}

function redactObject(value, depth = 0) {
  if (depth > 12) return '[depth-limit]';
  if (Array.isArray(value)) return value.map((item) => redactObject(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (SECRET_KEYS.test(key)) return [key, item ? `[redacted:${String(item).length}]` : ''];
      if (key === 'baseUrl') return [key, redactUrl(item)];
      return [key, redactObject(item, depth + 1)];
    }));
  }
  if (typeof value === 'string') return redactString(value);
  return value;
}

function supportCode(runId) {
  const hash = crypto.createHash('sha1').update(String(runId || '')).digest();
  const b32 = hash.subarray(0, 5).toString('base64url').replace(/[=_-]/g, '').toUpperCase();
  return `MMW-${b32.slice(0, 4)}-${b32.slice(4, 8)}`;
}

async function createDiagnosticPackage({
  root,
  includeSourceFiles = false,
  userDataPath = '',
  runtimeStatusImpl = null,
  createRunStoreImpl = null,
} = {}) {
  const { createRunStore } = createRunStoreImpl
    ? { createRunStore: createRunStoreImpl }
    : require('./supervisor/run-store.cjs');
  const { runtimeStatus } = runtimeStatusImpl
    ? { runtimeStatus: runtimeStatusImpl }
    : require('./runtime-tools.cjs');

  const store = root ? createRunStore(root) : null;
  const state = store ? await store.load().catch(() => null) : null;
  const events = store ? await store.readEvents({ limit: 200 }).catch(() => []) : [];
  const dataRoot = userDataPath || app.getPath('userData');

  const manifest = {
    version: require('../package.json').version,
    platform: process.platform,
    arch: process.arch,
    osVersion: `${os.type()} ${os.release()}`,
    totalMemoryGB: (os.totalmem() / 1024 ** 3).toFixed(1),
    nodeVersion: process.version,
    electronVersion: process.versions.electron,
    generatedAt: new Date().toISOString(),
    schemaVersion: 1,
    supportCode: state?.runId ? supportCode(state.runId) : null,
  };

  const runtime = await runtimeStatus().catch(() => ({}));
  const settings = await fsp.readFile(path.join(dataRoot, 'settings.json'), 'utf8')
    .then(JSON.parse)
    .catch(() => ({}));

  const stageErrors = [];
  if (state?.tasks) {
    for (const [stage, task] of Object.entries(state.tasks)) {
      if (!task.lastError) continue;
      stageErrors.push({
        stage,
        code: task.lastError.code || null,
        message: redactString(task.lastError.reason || task.lastError.message || ''),
        category: task.lastError.category || null,
      });
    }
  }

  let fileInventory = '';
  if (root) {
    const workDir = path.join(root, 'work');
    const scan = async (dir, prefix = '') => {
      const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const rel = path.join(prefix, entry.name);
        if (entry.isDirectory()) {
          if (!entry.name.startsWith('.')) await scan(path.join(dir, entry.name), rel);
        } else {
          const stat = await fsp.stat(path.join(dir, entry.name)).catch(() => null);
          if (stat) fileInventory += `${rel}  ${(stat.size / 1024).toFixed(1)}KB  ${stat.mtime.toISOString()}\n`;
        }
      }
    };
    await scan(workDir);
  }

  const parts = {
    'manifest.json': JSON.stringify(manifest, null, 2),
    'runtime.json': JSON.stringify(runtime, null, 2),
    'settings.redacted.json': JSON.stringify(redactObject(settings), null, 2),
    'run-state.redacted.json': state ? JSON.stringify(redactObject(state), null, 2) : null,
    'events.redacted.jsonl': events.map((event) => JSON.stringify(redactObject(event))).join('\n'),
    'stage-errors.json': JSON.stringify(stageErrors, null, 2),
    'file-inventory.txt': fileInventory,
    'README.txt': [
      '数模工坊诊断包',
      `生成时间: ${manifest.generatedAt}`,
      `支持代码: ${manifest.supportCode || '无'}`,
      '',
      '已脱敏，不含 API 密钥与完整赛题/论文正文（除非勾选附带源文件）。',
    ].join('\n'),
  };

  if (includeSourceFiles && root) {
    const paperDir = path.join(root, 'work', '03_paper');
    const texFiles = await fsp.readdir(paperDir).catch(() => []);
    for (const file of texFiles.filter((name) => name.endsWith('.tex') || name.endsWith('.bib'))) {
      const content = await fsp.readFile(path.join(paperDir, file), 'utf8').catch(() => null);
      if (content) parts[`source/${file}`] = content;
    }
  }

  return { parts, manifest };
}

async function writeDiagnosticArchive(parts, targetPath) {
  const dir = `${targetPath}.dir`;
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  await fsp.mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(parts)) {
    if (content == null) continue;
    const file = path.join(dir, name);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, content, 'utf8');
  }
  // Prefer zip via PowerShell Compress-Archive when available; otherwise keep folder.
  if (process.platform === 'win32') {
    await new Promise((resolve, reject) => {
      const { spawn } = require('node:child_process');
      const child = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `Compress-Archive -Path (Join-Path '${dir.replace(/'/g, "''")}' '*') -DestinationPath '${targetPath.replace(/'/g, "''")}' -Force`,
      ], { windowsHide: true });
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`zip failed: ${code}`))));
    }).catch(async () => {
      await fsp.rename(dir, targetPath.replace(/\.zip$/i, ''));
      return { path: targetPath.replace(/\.zip$/i, ''), kind: 'dir' };
    });
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    return { path: targetPath, kind: 'zip' };
  }
  await fsp.rename(dir, targetPath.replace(/\.zip$/i, ''));
  return { path: targetPath.replace(/\.zip$/i, ''), kind: 'dir' };
}

module.exports = {
  createDiagnosticPackage,
  writeDiagnosticArchive,
  redactObject,
  redactString,
  supportCode,
};
