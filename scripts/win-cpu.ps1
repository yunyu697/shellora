param(
  [Parameter(Mandatory = $true)][int]$RootPid,
  [int]$Ms = 3000
)

$ErrorActionPreference = "Stop"

# 递归收集应用进程树（应用本体 + msedgewebview2 子进程）
$procs = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
$ids = New-Object 'System.Collections.Generic.HashSet[int]'
[void]$ids.Add($RootPid)
$changed = $true
while ($changed) {
  $changed = $false
  foreach ($p in $procs) {
    $pid2 = [int]$p.ProcessId
    if ($ids.Contains([int]$p.ParentProcessId) -and -not $ids.Contains($pid2)) {
      [void]$ids.Add($pid2)
      $changed = $true
    }
  }
}

$before = @{}
foreach ($id in $ids) {
  $gp = Get-Process -Id $id -ErrorAction SilentlyContinue
  if ($gp) { $before[$id] = $gp.TotalProcessorTime.TotalMilliseconds }
}

Start-Sleep -Milliseconds $Ms

$usedMs = 0.0
$sampled = 0
foreach ($id in $ids) {
  $gp = Get-Process -Id $id -ErrorAction SilentlyContinue
  if ($gp -and $before.ContainsKey($id)) {
    $usedMs += ($gp.TotalProcessorTime.TotalMilliseconds - $before[$id])
    $sampled++
  }
}

$cores = [Environment]::ProcessorCount
[pscustomobject]@{
  rootPid   = $RootPid
  processes = $ids.Count
  sampled   = $sampled
  windowMs  = $Ms
  cpuMs     = [math]::Round($usedMs, 1)
  cores     = $cores
  pctTotal  = [math]::Round($usedMs / $Ms / $cores * 100, 2)
  pctSingle = [math]::Round($usedMs / $Ms * 100, 2)
} | ConvertTo-Json -Compress
