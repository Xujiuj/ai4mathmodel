param(
  [Parameter(Mandatory = $true)]
  [int]$TargetProcessId,
  [string]$OutputPath = (Join-Path $PSScriptRoot "..\packaged-verification.png")
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class WindowCapture
{
    [StructLayout(LayoutKind.Sequential)]
    public struct Rect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr windowHandle, out Rect rect);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr windowHandle);

    [DllImport("user32.dll")]
    public static extern bool MoveWindow(IntPtr windowHandle, int x, int y, int width, int height, bool repaint);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr windowHandle, int command);
}
"@

$process = Get-Process -Id $TargetProcessId -ErrorAction SilentlyContinue

if (-not $process -or $process.MainWindowHandle -eq 0) {
  throw "Window not found for process: $TargetProcessId"
}

[WindowCapture]::ShowWindow($process.MainWindowHandle, 9) | Out-Null
[WindowCapture]::SetForegroundWindow($process.MainWindowHandle) | Out-Null
[WindowCapture]::MoveWindow($process.MainWindowHandle, 0, 0, 1500, 980, $true) | Out-Null
Start-Sleep -Milliseconds 800

$rect = New-Object WindowCapture+Rect
if (-not [WindowCapture]::GetWindowRect($process.MainWindowHandle, [ref]$rect)) {
  throw "Unable to read window bounds for process: $TargetProcessId"
}

$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
if ($width -le 0 -or $height -le 0) {
  throw "Invalid window bounds: ${width}x${height}"
}

$bitmap = New-Object System.Drawing.Bitmap($width, $height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)

try {
  $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bitmap.Size)
  $resolvedOutput = [System.IO.Path]::GetFullPath($OutputPath)
  $bitmap.Save($resolvedOutput, [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Output "CAPTURE=$resolvedOutput"
  Write-Output "SIZE=${width}x${height}"
}
finally {
  $graphics.Dispose()
  $bitmap.Dispose()
}
