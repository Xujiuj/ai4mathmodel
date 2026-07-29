# 自动更新链路实施计划 (#3)

> 状态（2026-07-29）：更新器、组件管理器和发布校验脚本已实现；证书、正式更新地址与渲染层更新界面仍未完成。本文保留为实施与发布记录。

## 目标
- electron-updater 管理 core(app.asar)的增量更新
- 自研组件管理器管理 runtime 资源(python/tectonic)的可选更新
- 代码签名配置骨架(实际签名需外部证书)

## 方案:双轨更新

### 架构
```
首装:MathModelingWorkbench-x.y.z-Setup.exe (你的 NSIS 分包器)
  ↓
安装完成后写 installed-components.json:
{
  "core": { "version": "0.1.0", "installedAt": "2026-01-15T..." },
  "python": { "version": "3.12.1", "sha256": "abc...", "installedAt": "..." },
  "tectonic": { "version": "0.15.0", "sha256": "def...", "installedAt": "..." }
}

运行时更新:
  - core 更新:electron-updater (generic provider)
  - runtime 更新:component-manager.cjs (自研,带 Ed25519 签名校验)
```

### 1. electron-updater 集成
**依赖**:
```bash
npm install electron-updater
```

**package.json 扩展**:
```json
{
  "build": {
    "publish": [{
      "provider": "generic",
      "url": "https://dl.example.com/mmw/${channel}/"
    }],
    "win": {
      "target": ["nsis"],
      "signingHashAlgorithms": ["sha256"],
      "signtoolOptions": {
        "certificateFile": null,
        "certificatePassword": null
      }
    }
  }
}
```

**main.cjs 集成**:
```js
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');

autoUpdater.logger = log;
autoUpdater.autoDownload = false;  // 手动触发下载
autoUpdater.allowPrerelease = false;

autoUpdater.on('checking-for-update', () => {
  sendUpdateEvent({ type: 'checking' });
});

autoUpdater.on('update-available', (info) => {
  sendUpdateEvent({ type: 'available', version: info.version, releaseNotes: info.releaseNotes });
});

autoUpdater.on('update-not-available', () => {
  sendUpdateEvent({ type: 'up-to-date' });
});

autoUpdater.on('download-progress', (progress) => {
  sendUpdateEvent({ type: 'download-progress', percent: progress.percent });
});

autoUpdater.on('update-downloaded', (info) => {
  sendUpdateEvent({ type: 'ready', version: info.version });
});

autoUpdater.on('error', (error) => {
  sendUpdateEvent({ type: 'error', message: error.message });
});

// IPC handlers
handle('updater:check', async () => {
  return autoUpdater.checkForUpdates();
});

handle('updater:download', async () => {
  return autoUpdater.downloadUpdate();
});

handle('updater:install', async () => {
  autoUpdater.quitAndInstall(false, true);  // isSilent=false, isForceRunAfter=true
});

// 启动时自动检查(可配置关闭)
app.on('ready', () => {
  if (!isDev) {
    setTimeout(() => autoUpdater.checkForUpdates(), 5000);
  }
});
```

### 2. 组件管理器 - runtime 更新
**位置**: electron/component-manager.cjs

```js
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const fs = require('node:fs');
const path = require('node:path');
const { net } = require('electron');
const { runtimeRoot } = require('./runtime-tools.cjs');

// Ed25519 公钥(对应私钥由发布流程持有,用于签 manifest)
const MANIFEST_PUBLIC_KEY = Buffer.from(
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',  // 替换为实际公钥
  'base64'
);

function installedComponentsFile() {
  return path.join(runtimeRoot(), 'installed-components.json');
}

async function readInstalledComponents() {
  try {
    return JSON.parse(await fsp.readFile(installedComponentsFile(), 'utf8'));
  } catch {
    return {};
  }
}

async function writeInstalledComponents(data) {
  await fsp.mkdir(path.dirname(installedComponentsFile()), { recursive: true });
  await fsp.writeFile(installedComponentsFile(), JSON.stringify(data, null, 2), 'utf8');
}

async function fetchManifest(channel = 'stable') {
  const appMajor = require('../package.json').version.split('.')[0];
  const url = `https://dl.example.com/mmw/runtime/manifest-${appMajor}-${channel}.json`;

  const response = await net.fetch(url);
  if (!response.ok) throw new Error(`Manifest fetch failed: ${response.status}`);

  const payload = await response.json();

  // 校验签名
  const { signature, ...content } = payload;
  const message = Buffer.from(JSON.stringify(content), 'utf8');
  const sig = Buffer.from(signature, 'base64');

  const isValid = crypto.verify(
    null,  // Ed25519 不需要 hash
    message,
    { key: MANIFEST_PUBLIC_KEY, format: 'der', type: 'spki' },
    sig
  );

  if (!isValid) throw new Error('Manifest signature invalid');

  return content;  // { components: { python: {...}, tectonic: {...} }, publishedAt: "..." }
}

async function sha256File(filepath) {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filepath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

async function downloadWithResume(url, targetPath, { onProgress, signal } = {}) {
  const response = await net.fetch(url, { signal });
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);

  const totalBytes = Number(response.headers.get('content-length') || 0);
  let downloadedBytes = 0;

  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  const writer = fs.createWriteStream(targetPath);

  for await (const chunk of response.body) {
    writer.write(chunk);
    downloadedBytes += chunk.length;
    onProgress?.({ downloadedBytes, totalBytes, percent: totalBytes ? (downloadedBytes / totalBytes) * 100 : 0 });
  }

  writer.end();
  await new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

async function extractAtomic(archivePath, targetDir, componentId) {
  const tempDir = `${targetDir}.new`;
  await fsp.rm(tempDir, { recursive: true, force: true });

  // 解压到 .new(使用 7z 或 tar,取决于格式)
  const { spawn } = require('node:child_process');
  await new Promise((resolve, reject) => {
    const proc = spawn('7z', ['x', `-o${tempDir}`, archivePath], { stdio: 'ignore' });
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Extract failed: ${code}`))));
  });

  // 原子替换:删除旧的,rename .new
  const finalDir = path.join(targetDir, componentId);
  await fsp.rm(finalDir, { recursive: true, force: true });
  await fsp.rename(tempDir, finalDir);
}

async function ensureComponent(componentId, { onProgress, signal } = {}) {
  const installed = await readInstalledComponents();
  const manifest = await fetchManifest();

  const remote = manifest.components[componentId];
  if (!remote) throw new Error(`Unknown component: ${componentId}`);

  const local = installed[componentId];
  if (local?.version === remote.version && local?.sha256 === remote.sha256) {
    return { installed: true, version: local.version, upToDate: true };
  }

  // 下载
  const archivePath = path.join(runtimeRoot(), 'temp', `${componentId}-${remote.version}.7z`);
  await downloadWithResume(remote.url, archivePath, { onProgress, signal });

  // 校验
  const actualSha256 = await sha256File(archivePath);
  if (actualSha256 !== remote.sha256) {
    await fsp.rm(archivePath, { force: true });
    throw new Error('COMPONENT_CHECKSUM_MISMATCH');
  }

  // 解压并原子替换
  await extractAtomic(archivePath, runtimeRoot(), componentId);
  await fsp.rm(archivePath, { force: true });

  // 更新注册表
  installed[componentId] = {
    version: remote.version,
    sha256: remote.sha256,
    installedAt: new Date().toISOString(),
  };
  await writeInstalledComponents(installed);

  return { installed: true, version: remote.version, upToDate: false };
}

module.exports = {
  ensureComponent,
  fetchManifest,
  readInstalledComponents,
};
```

### 3. IPC handlers
```js
const { ensureComponent, fetchManifest } = require('./component-manager.cjs');

handle('components:check', async () => {
  const manifest = await fetchManifest();
  const installed = await readInstalledComponents();

  const status = {};
  for (const [id, remote] of Object.entries(manifest.components)) {
    const local = installed[id];
    status[id] = {
      installed: Boolean(local),
      currentVersion: local?.version || null,
      availableVersion: remote.version,
      needsUpdate: !local || local.version !== remote.version,
    };
  }
  return status;
});

handle('components:install', async (_event, { componentId, signal } = {}) => {
  return ensureComponent(componentId, {
    onProgress: (progress) => {
      mainWindow?.webContents.send('component-progress', { componentId, ...progress });
    },
    signal,
  });
});
```

### 4. preload API
```js
checkForUpdates: () => invoke('updater:check'),
downloadUpdate: () => invoke('updater:download'),
installUpdate: () => invoke('updater:install'),
checkComponents: () => invoke('components:check'),
installComponent: (componentId) => invoke('components:install', { componentId }),
onUpdateEvent: (callback) => {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on('update-event', handler);
  return () => ipcRenderer.removeListener('update-event', handler);
},
onComponentProgress: (callback) => {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on('component-progress', handler);
  return () => ipcRenderer.removeListener('component-progress', handler);
},
```

### 5. 签名配置(需外部证书)
**方案 A - Azure Trusted Signing**(推荐,云 HSM)
```bash
# 安装 Azure Code Signing
npm install @azure/trusted-signing

# CI 环境变量
AZURE_TENANT_ID=...
AZURE_CLIENT_ID=...
AZURE_CLIENT_SECRET=...
SIGNING_PROFILE_NAME=...
```

**electron-builder.yml**:
```yaml
win:
  sign: ./scripts/azure-sign.js
  signingHashAlgorithms:
    - sha256
```

**scripts/azure-sign.js**:
```js
const { sign } = require('@azure/trusted-signing');

exports.default = async function(configuration) {
  await sign({
    filePath: configuration.path,
    tenantId: process.env.AZURE_TENANT_ID,
    clientId: process.env.AZURE_CLIENT_ID,
    clientSecret: process.env.AZURE_CLIENT_SECRET,
    profileName: process.env.SIGNING_PROFILE_NAME,
  });
};
```

**方案 B - 本地证书**(需 .pfx 文件)
```json
{
  "build": {
    "win": {
      "certificateFile": "cert.pfx",
      "certificatePassword": "${env.CERT_PASSWORD}"
    }
  }
}
```

### 6. CI 流程 - GitHub Actions 示例
```yaml
name: Build and Release

on:
  push:
    tags: ['v*']

jobs:
  build:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v3

      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: 20

      - name: Install dependencies
        run: npm ci

      - name: Build dist
        run: npm run build

      - name: Package with electron-builder
        env:
          AZURE_TENANT_ID: ${{ secrets.AZURE_TENANT_ID }}
          AZURE_CLIENT_ID: ${{ secrets.AZURE_CLIENT_ID }}
          AZURE_CLIENT_SECRET: ${{ secrets.AZURE_CLIENT_SECRET }}
        run: npm run dist

      - name: Verify asar consistency
        run: |
          # 断言:首装器的 app.asar 与 updater nsis 的 app.asar sha256 相同
          node scripts/verify-asar-match.js

      - name: Upload to release server
        run: |
          # 上传 latest.yml + nsis installer 到 https://dl.example.com/mmw/stable/
          # 上传首装器到 https://dl.example.com/mmw/releases/
```

### 7. manifest 签名工具(发布流程使用)
**scripts/sign-manifest.js**:
```js
const crypto = require('node:crypto');
const fs = require('node:fs');

// 私钥(保存在 CI secrets 中,不入库)
const privateKey = crypto.createPrivateKey({
  key: Buffer.from(process.env.MANIFEST_PRIVATE_KEY, 'base64'),
  format: 'der',
  type: 'pkcs8',
});

const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
const message = Buffer.from(JSON.stringify(manifest), 'utf8');
const signature = crypto.sign(null, message, privateKey).toString('base64');

const signed = { ...manifest, signature };
fs.writeFileSync('manifest-signed.json', JSON.stringify(signed, null, 2));
console.log('Manifest signed');
```

### 8. UI 组件 - 设置页更新面板
```jsx
import { useState, useEffect } from 'react';
import { desktopApi } from '../api.js';

export function UpdatePanel() {
  const [coreUpdate, setCoreUpdate] = useState(null);
  const [components, setComponents] = useState({});
  const [checking, setChecking] = useState(false);

  const checkUpdates = async () => {
    setChecking(true);
    try {
      await desktopApi.checkForUpdates();
      const comps = await desktopApi.checkComponents();
      setComponents(comps);
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    const unsubscribe = desktopApi.onUpdateEvent((event) => {
      if (event.type === 'available') setCoreUpdate(event);
      if (event.type === 'ready') setCoreUpdate({ ...event, ready: true });
    });
    return unsubscribe;
  }, []);

  return (
    <div className="update-panel">
      <h3>应用更新</h3>
      <button onClick={checkUpdates} disabled={checking}>检查更新</button>

      {coreUpdate && (
        <div className="core-update">
          <p>发现新版本 {coreUpdate.version}</p>
          {coreUpdate.ready ? (
            <button onClick={() => desktopApi.installUpdate()}>重启并安装</button>
          ) : (
            <button onClick={() => desktopApi.downloadUpdate()}>下载</button>
          )}
        </div>
      )}

      <h3>运行时组件</h3>
      {Object.entries(components).map(([id, status]) => (
        <div key={id}>
          <span>{id}: {status.currentVersion || '未安装'}</span>
          {status.needsUpdate && (
            <button onClick={() => desktopApi.installComponent(id)}>
              {status.installed ? '更新' : '安装'}到 {status.availableVersion}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
```

## 非代码部分(需用户自行推进)
1. **证书采购**:OV/EV 代码签名证书(推荐 Azure Trusted Signing,需企业注册 1 年+)
2. **更新服务器**:
   - `https://dl.example.com/mmw/stable/` - electron-updater 产物(latest.yml + nsis)
   - `https://dl.example.com/mmw/runtime/` - 组件 manifest + 归档
3. **杀软报备**:火绒、360、腾讯、Defender 白名单申请(需证书 + 样本,周期 1-4 周)
4. **manifest 密钥生成**:
   ```bash
   # 生成 Ed25519 密钥对
   openssl genpkey -algorithm ED25519 -out manifest-private.pem
   openssl pkey -in manifest-private.pem -pubout -out manifest-public.pem
   # 转 base64 存入代码(公钥)和 CI secrets(私钥)
   ```

## 验收标准
1. 断网时更新检查静默失败不影响使用
2. 篡改 manifest 后客户端拒绝安装并上报
3. 首装器的 app.asar 与 updater nsis 的 app.asar sha256 相同(CI 断言)
4. 签名验证:`signtool verify /pa /v MathModelingWorkbench.exe` 通过

## 工作量
- electron-updater 集成:1-2 人日
- 组件管理器(含签名校验):3-4 人日
- CI 流程:2 人日
- UI:1 人日
- 签名配置骨架:1 人日
**代码侧总计**:8-10 人日

**非代码侧**(外部依赖,并行进行):
- 证书申请:1-3 周等待
- 杀软报备:1-4 周等待
- 服务器搭建:2-3 人日

## 关键路径
证书申请是瓶颈,**今天就该启动**。代码可以先用自签证书开发,拿到正式证书后替换。
