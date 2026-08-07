const EXACT_REASONS = new Map([
  ['dev-mode', '开发模式不执行应用更新。'],
  ['updater-unavailable', '当前安装包未启用应用更新。'],
  ['platform-unsupported', '应用自动更新目前仅支持 Windows。'],
  ['no-update', '当前已是最新版本。'],
  ['update-not-downloaded', '请先下载更新，再开始安装。'],
  ['updater-busy', '更新任务正在进行，请稍候。'],
]);

const REASON_RULES = [
  [/timed out|timeout|ETIMEDOUT/i, '连接更新服务超时，请检查网络后重试。'],
  [/request failed:\s*403|rate.?limit/i, '更新服务请求过于频繁，请稍后再试。'],
  [/request failed|fetch failed|ENOTFOUND|ECONNRESET|ECONNREFUSED|network/i, '无法连接更新服务，请检查网络后重试。'],
  [/release unavailable|installer asset missing|asset digest missing/i, '最新版本的安装包尚未准备完整，请稍后再试。'],
  [/release version invalid|installer version invalid|Unexpected (?:token|end)|JSON/i, '更新服务返回了无效的版本信息。'],
  [/URL invalid|must use GitHub HTTPS|API (?:host|repository) invalid|asset URL invalid|redirect/i, '更新来源校验失败，已停止更新。'],
  [/response too large|asset size invalid|size mismatch|file size mismatch/i, '安装包大小校验失败，已删除本次下载。'],
  [/digest mismatch/i, '安装包完整性校验失败，已停止安装。'],
  [/archive path invalid/i, '安装包包含不安全的文件路径，已停止安装。'],
  [/Setup\.exe|setup executable|installer executable/i, '安装包结构不完整，无法启动安装。'],
  [/signer subject is not configured/i, '官方发布者证书尚未配置，已停止安装。'],
  [/signature invalid|signer subject mismatch|Authenticode/i, '安装包签名校验失败，已停止安装。'],
  [/installer launch failed|spawn|EACCES|EPERM|ENOENT/i, '无法启动安装程序，请检查系统权限或安全软件后重试。'],
];

export function updaterReason(reason) {
  const value = String(reason || '').trim();
  if (!value) return '更新服务暂不可用，请稍后重试。';
  const exact = EXACT_REASONS.get(value);
  if (exact) return exact;
  const matched = REASON_RULES.find(([pattern]) => pattern.test(value));
  return matched?.[1] || '应用更新失败，请稍后重试。';
}
