const fs = require('node:fs');
const path = require('node:path');

const SAFE_ENV_KEYS = new Set([
  'PATH', 'Path', 'PATHEXT', 'COMSPEC', 'SYSTEMROOT', 'SystemRoot', 'WINDIR',
  'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
  'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432',
  'LANG', 'LC_ALL', 'PYTHONHOME', 'PYTHONPATH',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
]);

function validateExecutable(value) {
  const executable = String(value || '').trim();
  if (!executable || executable.length > 520 || /[\u0000\r\n"'`|&<>^;]/.test(executable)) {
    throw new Error('执行命令包含不安全字符。');
  }
  if (!path.isAbsolute(executable) && /[\\/]/.test(executable)) {
    throw new Error('执行命令必须是简单命令名或绝对路径。');
  }
  if (!path.isAbsolute(executable) && !/^[A-Za-z0-9_.-]{1,80}$/.test(executable)) {
    throw new Error('执行命令名称无效。');
  }
  return executable;
}

function candidateExecutables(executable, env = process.env) {
  if (path.isAbsolute(executable)) return [path.normalize(executable)];
  const pathValue = env.PATH || env.Path || '';
  const directories = pathValue.split(path.delimiter).map((item) => item.replace(/^"|"$/g, '')).filter(Boolean);
  const extensions = process.platform === 'win32' ? ['.exe', '.com', '.ps1', '', '.cmd', '.bat'] : [''];
  return extensions.flatMap((extension) => directories.map((directory) => path.join(directory, `${executable}${extension}`)));
}

function resolveExecutable(value, env = process.env) {
  const executable = validateExecutable(value);
  const candidate = candidateExecutables(executable, env).find((item) => {
    try {
      return fs.statSync(item).isFile();
    } catch {
      return false;
    }
  });
  if (!candidate) throw Object.assign(new Error(`未找到执行命令：${executable}`), { code: 'ENOENT' });
  const extension = path.extname(candidate).toLowerCase();
  if (['.cmd', '.bat'].includes(extension)) {
    throw new Error('为防止命令注入，不直接执行 CMD/BAT 包装器；请配置 EXE 或 PowerShell 入口。');
  }
  return candidate;
}

function prepareCommand(executable, args = [], env = process.env) {
  const resolved = resolveExecutable(executable, env);
  if (path.extname(resolved).toLowerCase() === '.ps1') {
    const powershell = resolveExecutable('powershell', env);
    return {
      command: powershell,
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', resolved, ...args.map(String)],
      resolved,
    };
  }
  return { command: resolved, args: args.map(String), resolved };
}

function sanitizedEnvironment(extra = {}, { sourceProtection = true, base = process.env } = {}) {
  const env = { FORCE_COLOR: '0', PYTHONUTF8: '1' };
  for (const [key, value] of Object.entries(base)) {
    if (SAFE_ENV_KEYS.has(key) || /^LC_/.test(key)) env[key] = value;
    if (!sourceProtection && ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY'].includes(key)) env[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined || value === null) {
      delete env[key];
      continue;
    }
    if (String(value).length <= 32768) env[key] = String(value);
  }
  return env;
}

module.exports = {
  SAFE_ENV_KEYS,
  candidateExecutables,
  prepareCommand,
  resolveExecutable,
  sanitizedEnvironment,
  validateExecutable,
};
