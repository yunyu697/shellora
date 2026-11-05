param(
  [Parameter(Mandatory = $true)][int]$TargetPid,
  [switch]$Clear
)

$ErrorActionPreference = "Stop"

if (-not ("Win32" -as [type])) {
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int x, int y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
}
"@
}

function Get-WindowTitle([IntPtr]$h) {
  if ($h -eq [IntPtr]::Zero) { return "" }
  $sb = New-Object System.Text.StringBuilder 512
  [void][Win32]::GetWindowText($h, $sb, 512)
  return $sb.ToString()
}

$app = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue
if (-not $app) {
  [pscustomobject]@{ ok = $false; reason = "process not found" } | ConvertTo-Json -Compress
  exit 1
}

$hwnd = $app.MainWindowHandle
if ($hwnd -eq [IntPtr]::Zero) {
  [pscustomobject]@{ ok = $false; reason = "main window handle is zero" } | ConvertTo-Json -Compress
  exit 1
}

$SW_SHOWNORMAL = 1
$HWND_TOPMOST = [IntPtr](-1)
$HWND_NOTOPMOST = [IntPtr](-2)
$SWP_NOSIZE = 0x0001
$SWP_NOMOVE = 0x0002

if ($Clear) {
  [void][Win32]::SetWindowPos($hwnd, $HWND_NOTOPMOST, 0, 0, 0, 0, ($SWP_NOSIZE -bor $SWP_NOMOVE))
  [pscustomobject]@{
    ok         = $true
    cleared    = $true
    hwnd       = [int64]$hwnd
  } | ConvertTo-Json -Compress
  exit 0
}

# Force foreground: AttachThreadInput bypasses the Windows foreground lock.
$fgHwnd = [Win32]::GetForegroundWindow()
if ($null -eq $fgHwnd) { $fgHwnd = [IntPtr]::Zero }
$fgPid = 0
$fgThread = 0
if ($fgHwnd -ne [IntPtr]::Zero) {
  $fgThread = [Win32]::GetWindowThreadProcessId($fgHwnd, [ref]$fgPid)
}
$appPid = 0
$appThread = [Win32]::GetWindowThreadProcessId($hwnd, [ref]$appPid)

[void][Win32]::ShowWindow($hwnd, $SW_SHOWNORMAL)
if ($fgThread -ne 0) { [void][Win32]::AttachThreadInput($fgThread, $appThread, $true) }
[void][Win32]::SetForegroundWindow($hwnd)
[void][Win32]::SetWindowPos($hwnd, $HWND_TOPMOST, 0, 0, 0, 0, ($SWP_NOSIZE -bor $SWP_NOMOVE))
if ($fgThread -ne 0) { [void][Win32]::AttachThreadInput($fgThread, $appThread, $false) }

Start-Sleep -Milliseconds 400
$newFg = [Win32]::GetForegroundWindow()
if ($null -eq $newFg) { $newFg = [IntPtr]::Zero }
$newFgPid = 0
if ($newFg -ne [IntPtr]::Zero) {
  [void][Win32]::GetWindowThreadProcessId($newFg, [ref]$newFgPid)
}

[pscustomobject]@{
  ok               = $true
  hwnd             = [int64]$hwnd
  visible          = [Win32]::IsWindowVisible($hwnd)
  maximized        = [Win32]::IsZoomed($hwnd)
  appTitle         = Get-WindowTitle $hwnd
  foregroundHwnd   = [int64]$newFg
  foregroundPid    = $newFgPid
  foregroundTitle  = Get-WindowTitle $newFg
  foregroundIsApp  = ($newFgPid -eq $TargetPid)
} | ConvertTo-Json -Compress
