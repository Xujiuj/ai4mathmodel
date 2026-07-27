const { spawn } = require('node:child_process');

function applyJobLimits(childProcess, {
  memoryMB = 4096,
  cpuMinutes = 30,
  maxProcesses = 8,
} = {}) {
  if (process.platform !== 'win32' || !childProcess?.pid) return;
  const pid = Number(childProcess.pid);
  if (!Number.isFinite(pid) || pid <= 0) return;

  const memoryBytes = Math.max(256, Number(memoryMB) || 4096) * 1024 * 1024;
  const cpuTicks = Math.max(1, Number(cpuMinutes) || 30) * 60 * 10_000_000;
  const processLimit = Math.max(1, Math.min(Number(maxProcesses) || 8, 64));

  const script = `
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
  public const uint LIMIT_PROCESS = 0x00000001; public const uint LIMIT_JOB_TIME = 0x00000004;
  public const uint LIMIT_ACTIVE = 0x00000008; public const uint LIMIT_JOB_MEMORY = 0x00000200;
  public const uint KILL_ON_CLOSE = 0x00002000; public const uint PROCESS_ALL = 0x001F0FFF;
  public static void Apply(int pid, ulong mem, long cpu, uint procs) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    IntPtr proc = OpenProcess(PROCESS_ALL, false, pid);
    if (proc == IntPtr.Zero) { CloseHandle(job); throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
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
    } finally { Marshal.FreeHGlobal(ptr); CloseHandle(proc); }
  }
}
"@
[JobLimit]::Apply(${pid}, [uint64]${memoryBytes}, [int64]${cpuTicks}, [uint32]${processLimit})
`;

  try {
    spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: 'ignore',
      detached: false,
    }).unref();
  } catch {
    // Best-effort: sandbox still has other layers if Job Object fails.
  }
}

module.exports = { applyJobLimits };
