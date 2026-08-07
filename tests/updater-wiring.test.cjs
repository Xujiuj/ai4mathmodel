const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8');

test('desktop main wires the protected GitHub updater to fixed package trust settings', () => {
  assert.doesNotMatch(mainSource, /electron-updater/);
  assert.match(mainSource, /latestReleaseUrl:\s*packageInfo\.releaseUpdate\?\.apiUrl/);
  assert.match(mainSource, /currentVersion:\s*app\.getVersion\(\)/);
  assert.match(mainSource, /tempDir:\s*path\.join\(app\.getPath\('userData'\),\s*'updates'\)/);
  assert.match(mainSource, /fetchImpl:\s*\(url, options\)\s*=>\s*net\.fetch\(url, options\)/);
  assert.match(mainSource, /publisherNames:\s*packageInfo\.releaseUpdate\?\.publisherNames\s*\|\|\s*\[\]/);
  assert.match(mainSource, /publisherThumbprints:\s*packageInfo\.releaseUpdate\?\.publisherThumbprints\s*\|\|\s*\[\]/);
  assert.match(mainSource, /quit:\s*\(\)\s*=>\s*app\.quit\(\)/);
  assert.doesNotMatch(mainSource, /MMW_INSTALLER_SIGNER_SUBJECT|LATEST_RELEASE_URL|GITHUB.*RELEASE/i);
});

test('updater errors are translated into stable user-facing messages', async () => {
  const { updaterReason } = await import(pathToFileURL(path.join(root, 'src', 'updateMessages.js')).href);
  assert.equal(updaterReason('platform-unsupported'), '应用自动更新目前仅支持 Windows。');
  assert.equal(updaterReason('Updater download timed out'), '连接更新服务超时，请检查网络后重试。');
  assert.equal(updaterReason('Updater API repository invalid'), '更新来源校验失败，已停止更新。');
  assert.equal(updaterReason('Updater installer version invalid'), '更新服务返回了无效的版本信息。');
  assert.equal(updaterReason('Updater asset digest mismatch'), '安装包完整性校验失败，已停止安装。');
  assert.equal(updaterReason('Installer archive path invalid'), '安装包包含不安全的文件路径，已停止安装。');
  assert.equal(updaterReason('Installer signer subject mismatch'), '安装包签名校验失败，已停止安装。');
  assert.equal(updaterReason('Installer launch failed: spawn EPERM'), '无法启动安装程序，请检查系统权限或安全软件后重试。');
  assert.equal(updaterReason('opaque internal failure'), '应用更新失败，请稍后重试。');
});
