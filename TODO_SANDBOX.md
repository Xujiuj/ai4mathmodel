# Python 沙箱加固实施计划 (#5)

> 状态（2026-07-29）：代码侧已实现，包括 AST 扫描、隔离入口、断网与 Windows Job Object 资源限制。本文保留为历史实施记录；以后续源码、测试与 `HANDOFF.md` 为准。

## 已有防护(保持)
✅ AGENT_PYTHON_BLOCKLIST - 黑名单正则(import os.system 等)
✅ PYTHON_WORKSPACE_RUNNER - open/chdir patch + environ.clear + -I 隔离
✅ watchdog + taskkill 超时终止

## 待补充

### 1. Job Object 资源限制(Windows)
**位置**: electron/main.cjs - spawnTracked 或 PYTHON_WORKSPACE_RUNNER 传入 python 进程前

**方案 A - 直接在 Node spawn 后应用**(推荐,无需修改 Python)
```js
// electron/job-limits.cjs (新文件)
const { spawn } = require('node:child_process');

function applyJobLimits(childProcess, { memoryMB = 4096, cpuMinutes = 30, maxProcesses = 8 } = {}) {
  if (process.platform !== 'win32' || !childProcess?.pid) return;

  const script = `
    Add-Type @"
      using System;
      using System.Runtime.InteropServices;
      public class JobObject {
        [DllImport("kernel32.dll")] public static extern IntPtr CreateJobObject(IntPtr attr, string name);
        [DllImport("kernel32.dll")] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll")] public static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, int size);
        [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(int access, bool inherit, int pid);
      }
"@

    $job = [JobObject]::CreateJobObject([IntPtr]::Zero, $null)
    $proc = [JobObject]::OpenProcess(0x1F0FFF, $false, ${childProcess.pid})
    [JobObject]::AssignProcessToJobObject($job, $proc)

    # JOBOBJECT_EXTENDED_LIMIT_INFORMATION 结构(需完整定义,略)
    # 设置:JobMemoryLimit=${memoryMB}MB, ActiveProcessLimit=${maxProcesses}, PerJobUserTimeLimit=${cpuMinutes}min
    # LimitFlags=LIMIT_JOB_MEMORY|LIMIT_ACTIVE_PROCESS|LIMIT_KILL_ON_JOB_CLOSE|LIMIT_JOB_TIME
  `;

  spawn('powershell.exe', ['-NoProfile', '-Command', script], {
    windowsHide: true,
    stdio: 'ignore',
    detached: false,
  }).unref();
}

module.exports = { applyJobLimits };
```

**集成点**: spawnTracked 中 Python 进程创建后
```js
const python = spawn(pythonExe, args, spawnOptions);
applyJobLimits(python, { memoryMB: 4096, cpuMinutes: 30, maxProcesses: 8 });
```

**备注**: KILL_ON_JOB_CLOSE 保证 Electron 异常退出时整个进程树被清理,解决孤儿进程问题。

### 2. 强制断网(Python 层)
**位置**: runtime/guard/sandbox_entry.py (新文件)

```python
#!/usr/bin/env python3
"""
Sandbox entry point that patches dangerous builtins before importing user code.
Usage: python sandbox_entry.py <user_script.py> [args...]
"""
import sys
import os
from pathlib import Path

# 1. Socket 层强制断网
import socket
_real_socket = socket.socket

def _blocked_socket(*args, **kwargs):
    if os.environ.get('ALLOW_NETWORK') != '1':
        raise PermissionError('模型求解阶段禁止网络访问。如需联网数据源,请在设置中显式授权。')
    return _real_socket(*args, **kwargs)

socket.socket = _blocked_socket

# 2. 工作目录锁定
PROJECT_ROOT = Path(os.environ.get('PROJECT_ROOT', '.')).resolve()
os.chdir(PROJECT_ROOT)

# 3. open 路径边界
import builtins
_real_open = builtins.open

def _guarded_open(file, mode='r', *args, **kwargs):
    if 'w' in mode or 'a' in mode or '+' in mode:
        resolved = (PROJECT_ROOT / file).resolve()
        if not str(resolved).startswith(str(PROJECT_ROOT) + os.sep):
            raise PermissionError(f'不能写入项目外路径:{file}')
    return _real_open(file, mode, *args, **kwargs)

builtins.open = _guarded_open

# 4. 导入用户脚本并执行
if len(sys.argv) < 2:
    print('Usage: sandbox_entry.py <script.py>', file=sys.stderr)
    sys.exit(1)

user_script = sys.argv[1]
sys.argv = sys.argv[1:]  # 传递参数给用户脚本

with open(user_script, 'rb') as f:
    code = compile(f.read(), user_script, 'exec')
    exec(code, {'__name__': '__main__', '__file__': user_script})
```

**集成**: spawnTracked 中修改 Python 命令
```js
// 原来:python.exe model.py
// 改为:python.exe runtime/guard/sandbox_entry.py model.py
const args = [
  path.join(runtimeRoot(), 'guard', 'sandbox_entry.py'),
  resolvedScript,
  ...userArgs,
];
const env = {
  ...sanitizedEnvironment(),
  PROJECT_ROOT: projectRoot,
  ALLOW_NETWORK: policy.sourceProtection ? '0' : '1',
};
```

### 3. AST 静态扫描(补黑名单缺口)
**位置**: runtime/guard/scan.py (新文件)

```python
#!/usr/bin/env python3
"""
Static AST scanner that rejects code with forbidden patterns.
"""
import ast
import sys

FORBIDDEN_CALLS = {
    ('os', 'system'), ('os', 'popen'), ('os', 'remove'), ('os', 'rmdir'), ('os', 'unlink'),
    ('shutil', 'rmtree'), ('shutil', 'move'),
    ('subprocess', 'run'), ('subprocess', 'Popen'), ('subprocess', 'call'),
    ('socket', 'socket'), ('urllib', 'request', 'urlopen'),
    ('requests', 'get'), ('requests', 'post'),
    ('pip', 'main'), ('importlib', 'import_module'),
}

FORBIDDEN_BUILTINS = {'eval', 'exec', 'compile', '__import__'}
FORBIDDEN_MODULES = {'ctypes', 'winreg', 'multiprocessing', 'socket', 'subprocess', 'pip'}

class ForbiddenPatternDetector(ast.NodeVisitor):
    def __init__(self):
        self.violations = []

    def visit_Import(self, node):
        for alias in node.names:
            if alias.name.split('.')[0] in FORBIDDEN_MODULES:
                self.violations.append(f'Line {node.lineno}: Forbidden module import: {alias.name}')
        self.generic_visit(node)

    def visit_ImportFrom(self, node):
        if node.module and node.module.split('.')[0] in FORBIDDEN_MODULES:
            self.violations.append(f'Line {node.lineno}: Forbidden module import: {node.module}')
        self.generic_visit(node)

    def visit_Call(self, node):
        # 检测 os.system(...) 形态
        if isinstance(node.func, ast.Attribute):
            if isinstance(node.func.value, ast.Name):
                pair = (node.func.value.id, node.func.attr)
                if pair in FORBIDDEN_CALLS:
                    self.violations.append(f'Line {node.lineno}: Forbidden call: {pair[0]}.{pair[1]}')

        # 检测 eval/exec 直接调用
        if isinstance(node.func, ast.Name) and node.func.id in FORBIDDEN_BUILTINS:
            self.violations.append(f'Line {node.lineno}: Forbidden builtin: {node.func.id}')

        self.generic_visit(node)

def scan_file(filepath):
    with open(filepath, 'r', encoding='utf-8') as f:
        source = f.read()

    try:
        tree = ast.parse(source, filename=filepath)
    except SyntaxError as e:
        return [f'Syntax error: {e}']

    detector = ForbiddenPatternDetector()
    detector.visit(tree)
    return detector.violations

if __name__ == '__main__':
    if len(sys.argv) != 2:
        print('Usage: scan.py <script.py>', file=sys.stderr)
        sys.exit(1)

    violations = scan_file(sys.argv[1])
    if violations:
        print('❌ 代码包含禁止的调用或模块:', file=sys.stderr)
        for v in violations:
            print(f'  {v}', file=sys.stderr)
        sys.exit(1)
    else:
        print('✅ 静态检查通过')
        sys.exit(0)
```

**集成**: supervisor.cjs 在写入 model.py 后、执行前
```js
const { spawn } = require('node:child_process');

async function scanPythonFile(filepath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(pythonExe, [
      path.join(runtimeRoot(), 'guard', 'scan.py'),
      filepath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    proc.stderr.on('data', (chunk) => { stderr += chunk; });
    proc.on('close', (code) => {
      if (code !== 0) reject(new Error(`静态扫描失败:${stderr}`));
      else resolve();
    });
  });
}

// 在 executeTool({ name: 'write_workspace_file', ... }) 写入 .py 后:
if (path.extname(targetPath) === '.py') {
  await scanPythonFile(targetPath);  // 不通过则抛异常,触发 LLM 重新生成
}
```

### 4. 设置界面暴露(可选)
**位置**: runtime-config.cjs DEFAULT_SETTINGS

```js
pythonSandbox: {
  memoryLimitMB: 4096,
  cpuTimeoutMinutes: 30,
  maxProcesses: 8,
  allowNetwork: false,
},
```

normalizeSettings 中规范化,UI 中在高级设置暴露调整滑块。

## 验收标准
1. 构造 6 个恶意脚本:
   - `rmtree_home.py`: `import shutil; shutil.rmtree(Path.home())`
   - `fork_bomb.py`: `import os; [os.fork() for _ in range(999)]`
   - `memory_hog.py`: `x = bytearray(20_000_000_000)`
   - `infinite_loop.py`: `while True: pass`
   - `network.py`: `import socket; socket.socket().connect(('evil.com', 80))`
   - `pip_install.py`: `import pip; pip.main(['install', 'malicious'])`

2. 全部被拦截,应用本身不受影响,错误信息可读
3. 合法脚本(numpy/pandas 数据处理)正常运行

## 工作量
- Job Object 集成:2-3 人日(PowerShell 调用 + 结构体定义复杂)
- sandbox_entry.py:1-2 人日
- AST 扫描器:2 人日
- 测试与调优:2 人日
**总计**:7-9 人日
