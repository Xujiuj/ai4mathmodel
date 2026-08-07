const { spawn } = require('node:child_process');

function normalizeLimits({
  memoryMB = 4096,
  cpuMinutes = 30,
  maxProcesses = 8,
} = {}) {
  return {
    memoryBytes: Math.max(256, Number(memoryMB) || 4096) * 1024 * 1024,
    cpuTicks: Math.max(1, Number(cpuMinutes) || 30) * 60 * 10_000_000,
    processLimit: Math.max(1, Math.min(Number(maxProcesses) || 8, 64)),
  };
}

function jobLimitScript(pid, limits) {
  const { memoryBytes, cpuTicks, processLimit } = limits;
  return `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class JobLimit {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr CreateJobObject(IntPtr a, string n);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetInformationJobObject(IntPtr j, int c, IntPtr i, uint s);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint a, bool i, int p);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinWorkingSetSize; public UIntPtr MaxWorkingSetSize; public uint ActiveProcessLimit;
    public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] public struct IO_COUNTERS {
    public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount;
    public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)] public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;
  }
  public const uint LIMIT_JOB_TIME = 0x00000004; public const uint LIMIT_ACTIVE = 0x00000008;
  public const uint LIMIT_JOB_MEMORY = 0x00000200; public const uint KILL_ON_CLOSE = 0x00002000;
  public const uint PROCESS_ALL = 0x001F0FFF;
  public static IntPtr Apply(int pid, ulong mem, long cpu, uint procs) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    IntPtr proc = OpenProcess(PROCESS_ALL, false, pid);
    if (proc == IntPtr.Zero) { CloseHandle(job); throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
    try {
      var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
      info.BasicLimitInformation.LimitFlags = LIMIT_JOB_TIME | LIMIT_ACTIVE | LIMIT_JOB_MEMORY | KILL_ON_CLOSE;
      info.BasicLimitInformation.PerJobUserTimeLimit = cpu;
      info.BasicLimitInformation.ActiveProcessLimit = procs;
      info.JobMemoryLimit = (UIntPtr)mem;
      int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
      IntPtr ptr = Marshal.AllocHGlobal(size);
      try {
        Marshal.StructureToPtr(info, ptr, false);
        if (!SetInformationJobObject(job, 9, ptr, (uint)size)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        if (!AssignProcessToJobObject(job, proc)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      } finally { Marshal.FreeHGlobal(ptr); }
      return job;
    } catch { CloseHandle(job); throw; } finally { CloseHandle(proc); }
  }
}
"@
$job = [JobLimit]::Apply(${pid}, [uint64]${memoryBytes}, [int64]${cpuTicks}, [uint32]${processLimit})
try {
  try { [System.Diagnostics.Process]::GetProcessById(${pid}).WaitForExit() } catch {}
} finally {
  [JobLimit]::CloseHandle($job) | Out-Null
}
`;
}

function applyJobLimits(childProcess, options = {}, {
  platform = process.platform,
  spawnImpl = spawn,
} = {}) {
  if (platform !== 'win32' || !childProcess?.pid) return null;
  const pid = Number(childProcess.pid);
  if (!Number.isFinite(pid) || pid <= 0) return null;

  const script = jobLimitScript(pid, normalizeLimits(options));
  let helper;
  try {
    // The helper must stay alive: closing the only Job Object handle with
    // KILL_ON_CLOSE would otherwise terminate the Python process immediately.
    helper = spawnImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: 'ignore',
      detached: false,
    });
    helper.on?.('error', () => {});
    helper.unref?.();
  } catch {
    // Best-effort: sandbox still has other layers if Job Object setup fails.
    return null;
  }

  return {
    dispose() {
      if (!helper || helper.exitCode !== null || helper.killed) return;
      try { helper.kill(); } catch {}
    },
  };
}

module.exports = { applyJobLimits, jobLimitScript, normalizeLimits };
