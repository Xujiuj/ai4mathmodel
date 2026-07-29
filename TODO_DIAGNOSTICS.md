# 诊断包导出实施计划 (#16)

> 状态（2026-07-29）：代码侧已实现并纳入公共测试。本文保留为历史实施记录；以后续源码、测试与 `HANDOFF.md` 为准。

## 目标
用户主动导出脱敏诊断包,供技术支持分析问题。**不做自动上报**(隐私合规成本高)。

## 实施方案

### 1. 核心模块 - electron/diagnostics.cjs
```js
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { app } = require('electron');
const { redactText } = require('./supervisor/retry-policy.cjs');

const SECRET_KEYS = /^(apiKey|api_key|authToken|token|password|secret|authorization|bearer)$/i;

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

function redactUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    parsed.search = '';
    parsed.username = '';
    parsed.password = '';
    return parsed.origin + parsed.pathname;  // 保留 origin + path,去掉 query/auth
  } catch {
    return '[invalid-url]';
  }
}

function redactString(text) {
  return String(text)
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, '[redacted-key]')
    .replace(/\b[A-Za-z0-9_-]{48,}\b/g, '[redacted-token]')
    .replace(/(?:\/Users\/|C:\\Users\\)[^\\/\s]+/gi, (m) => m.replace(/[^\\/]+$/, '<user>'))
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|token|secret)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]');
}

function supportCode(runId) {
  // 取 runId 前 10 字符转 base32,得到如 MMW-7K3Q-2F81 的短码
  const hash = crypto.createHash('sha1').update(runId).digest();
  const b32 = hash.subarray(0, 5).toString('base64url').replace(/[=_-]/g, '').toUpperCase();
  return `MMW-${b32.slice(0, 4)}-${b32.slice(4, 8)}`;
}

async function createDiagnosticPackage({ root, includeSourceFiles = false } = {}) {
  const { createRunStore } = require('./supervisor/run-store.cjs');
  const { runtimeStatus } = require('./runtime-tools.cjs');

  const store = root ? createRunStore(root) : null;
  const state = store ? await store.load().catch(() => null) : null;
  const events = store ? await store.readEvents({ limit: 200 }).catch(() => []) : [];

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

  const settings = await fsp.readFile(path.join(app.getPath('userData'), 'settings.json'), 'utf8')
    .then(JSON.parse)
    .catch(() => ({}));

  const redactedSettings = redactObject(settings);
  const redactedState = state ? redactObject(state) : null;
  const redactedEvents = events.map((e) => redactObject(e));

  // Stage errors - 每阶段最后一次失败
  const stageErrors = [];
  if (state?.tasks) {
    for (const [stage, task] of Object.entries(state.tasks)) {
      if (task.lastError) {
        stageErrors.push({
          stage,
          code: task.lastError.code,
          message: redactString(task.lastError.message || ''),
          category: task.lastError.category,
        });
      }
    }
  }

  // File inventory
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
          if (stat) {
            fileInventory += `${rel}  ${(stat.size / 1024).toFixed(1)}KB  ${stat.mtime.toISOString()}\n`;
          }
        }
      }
    };
    await scan(workDir);
  }

  const parts = {
    'manifest.json': JSON.stringify(manifest, null, 2),
    'runtime.json': JSON.stringify(runtime, null, 2),
    'settings.redacted.json': JSON.stringify(redactedSettings, null, 2),
    'run-state.redacted.json': redactedState ? JSON.stringify(redactedState, null, 2) : null,
    'events.redacted.jsonl': redactedEvents.map((e) => JSON.stringify(e)).join('\n'),
    'stage-errors.json': JSON.stringify(stageErrors, null, 2),
    'file-inventory.txt': fileInventory,
    'README.txt': `
数模工坊诊断包
生成时间: ${manifest.generatedAt}
支持代码: ${manifest.supportCode}

包含内容:
- manifest.json    应用版本、系统环境
- runtime.json     运行时工具状态
- settings.redacted.json  已脱敏的用户设置
- run-state.redacted.json 已脱敏的运行状态
- events.redacted.jsonl   已脱敏的事件日志
- stage-errors.json       各阶段失败摘要
- file-inventory.txt      work/ 目录文件清单(无内容)

不包含:
- API 密钥和 Base URL 已脱敏
- 赛题原文和生成的论文内容(除非勾选"附带源文件")
- 数据文件和图片

请将此包发送至技术支持,并告知支持代码 ${manifest.supportCode}
`.trim(),
  };

  // 可选:附带源文件
  if (includeSourceFiles && root) {
    const paperDir = path.join(root, 'work', '03_paper');
    const texFiles = await fsp.readdir(paperDir).catch(() => []);
    for (const file of texFiles.filter((f) => f.endsWith('.tex') || f.endsWith('.bib'))) {
      const content = await fsp.readFile(path.join(paperDir, file), 'utf8').catch(() => null);
      if (content) parts[`source/${file}`] = content;
    }
  }

  return { parts, manifest };
}

module.exports = {
  createDiagnosticPackage,
  redactObject,
  redactString,
  supportCode,
};
```

### 2. IPC Handler - main.cjs
```js
const { createDiagnosticPackage } = require('./diagnostics.cjs');

handle('diagnostics:export', async (_event, { root, includeSourceFiles = false } = {}) => {
  assertTrustedSender(_event);

  const { parts, manifest } = await createDiagnosticPackage({ root, includeSourceFiles });

  // 返回预览(前 50 行)
  const preview = {
    manifest: parts['manifest.json'],
    settingsSample: parts['settings.redacted.json'].split('\n').slice(0, 30).join('\n'),
    eventsSample: parts['events.redacted.jsonl'].split('\n').slice(0, 20).join('\n'),
  };

  return { preview, manifest };
});

handle('diagnostics:save', async (_event, { root, includeSourceFiles = false, savePath } = {}) => {
  assertTrustedSender(_event);

  const { parts, manifest } = await createDiagnosticPackage({ root, includeSourceFiles });

  // 打包为 .zip
  const AdmZip = require('adm-zip');  // 需 npm install adm-zip
  const zip = new AdmZip();

  for (const [filename, content] of Object.entries(parts)) {
    if (content) zip.addFile(filename, Buffer.from(content, 'utf8'));
  }

  const defaultPath = `diagnostic-${manifest.version}-${new Date().toISOString().slice(0, 10)}.zip`;
  const { filePath } = savePath ? { filePath: savePath } : await dialog.showSaveDialog(mainWindow, {
    title: '保存诊断包',
    defaultPath,
    filters: [{ name: 'ZIP Archive', extensions: ['zip'] }],
  });

  if (!filePath) return { saved: false };

  await fsp.writeFile(filePath, zip.toBuffer());
  return { saved: true, path: filePath, supportCode: manifest.supportCode };
});
```

### 3. preload API
```js
// preload.cjs
exportDiagnostics: (root, includeSourceFiles) => invoke('diagnostics:export', { root, includeSourceFiles }),
saveDiagnostics: (root, includeSourceFiles, savePath) => invoke('diagnostics:save', { root, includeSourceFiles, savePath }),
```

### 4. UI 组件 - src/components/DiagnosticsModal.jsx
```jsx
import { useState } from 'react';
import { desktopApi } from '../api.js';

export function DiagnosticsModal({ projectRoot, onClose }) {
  const [includeSource, setIncludeSource] = useState(false);
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);

  const handlePreview = async () => {
    setLoading(true);
    try {
      const result = await desktopApi.exportDiagnostics(projectRoot, includeSource);
      setPreview(result.preview);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    setLoading(true);
    try {
      const result = await desktopApi.saveDiagnostics(projectRoot, includeSource);
      if (result.saved) {
        alert(`诊断包已保存\n支持代码:${result.supportCode}\n\n请将文件发送至技术支持`);
        onClose();
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal">
      <h2>导出诊断包</h2>
      <label>
        <input type="checkbox" checked={includeSource} onChange={(e) => setIncludeSource(e.target.checked)} />
        附带论文源文件(将包含你的赛题与论文内容)
      </label>

      <button onClick={handlePreview} disabled={loading}>预览</button>
      <button onClick={handleSave} disabled={loading}>保存</button>
      <button onClick={onClose}>取消</button>

      {preview && (
        <div className="preview">
          <h3>预览</h3>
          <pre>{preview.manifest}</pre>
          <details><summary>设置(前30行)</summary><pre>{preview.settingsSample}</pre></details>
          <details><summary>事件(前20行)</summary><pre>{preview.eventsSample}</pre></details>
        </div>
      )}
    </div>
  );
}
```

### 5. 崩溃捕获
**位置**: main.cjs 顶部

```js
const crashDir = path.join(app.getPath('userData'), 'crashes');

process.on('uncaughtException', async (error) => {
  await fsp.mkdir(crashDir, { recursive: true }).catch(() => {});
  const crashFile = path.join(crashDir, `crash-${Date.now()}.json`);
  const { redactObject } = require('./diagnostics.cjs');

  await fsp.writeFile(crashFile, JSON.stringify(redactObject({
    timestamp: new Date().toISOString(),
    message: error.message,
    stack: error.stack,
    platform: process.platform,
    version: require('../package.json').version,
  }), null, 2)).catch(() => {});

  console.error('未捕获异常:', error);
  process.exit(1);
});

// 启动时检查崩溃
app.on('ready', async () => {
  const crashes = await fsp.readdir(crashDir).catch(() => []);
  if (crashes.length > 0) {
    const response = await dialog.showMessageBox({
      type: 'warning',
      title: '检测到异常退出',
      message: `上次运行异常退出(${crashes.length} 次)`,
      detail: '是否导出诊断包以便排查问题?',
      buttons: ['稍后', '导出'],
      defaultId: 1,
    });

    if (response.response === 1) {
      // 触发导出流程
    }
  }
});
```

### 6. 触发入口
1. **设置页**:"导出诊断包"按钮
2. **运行失败弹窗**:"导出诊断信息"按钮(最重要,失败当下用户最愿意配合)
3. **主菜单 > 帮助 > 导出诊断包**

### 7. 依赖
```bash
npm install adm-zip
```

## 验收标准
1. 构造一份包含 5 种形态密钥的设置与日志,导出后全文 grep 原始密钥零命中
2. 预览窗口能看到脱敏后的内容,用户确认无敏感信息
3. supportCode 在失败弹窗和诊断包 manifest 中一致
4. 主进程崩溃后下次启动提示,并能导出 crash 文件

## 工作量
- diagnostics.cjs 核心:2-3 人日
- UI 集成:1-2 人日
- 崩溃捕获:1 人日
- 测试(密钥形态扫描必须自动化):1-2 人日
**总计**:5-8 人日
