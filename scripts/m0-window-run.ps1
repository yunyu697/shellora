param(
  [int]$WindowSeconds = 90
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$appExe = Join-Path $root "src-tauri\target\debug\shellora.exe"
$fixExe = Join-Path $root "src-tauri\target\debug\fixture_sshd.exe"
$qaDir = Join-Path $root "docs\qa"
New-Item -ItemType Directory -Force -Path $qaDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $qaDir "shots") | Out-Null

function Wait-Port([int]$Port, [int]$TimeoutSec) {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    $listening = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
    if ($listening) { return $true }
    Start-Sleep -Milliseconds 400
  }
  return $false
}

# WebView2: disable background throttling and open CDP port 9223.
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9223 --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding"

$viteLog = Join-Path $qaDir "vite.log"
$viteErr = Join-Path $qaDir "vite.err.txt"
$vite = Start-Process node -ArgumentList @("node_modules/vite/bin/vite.js") -WorkingDirectory $root `
  -WindowStyle Hidden -RedirectStandardOutput $viteLog -RedirectStandardError $viteErr -PassThru
if (-not (Wait-Port 1420 60)) { throw "vite not ready within 60s (see docs/qa/vite.err.txt)" }

$fixture = Start-Process -FilePath $fixExe -WindowStyle Hidden -PassThru
if (-not (Wait-Port 2222 15)) { throw "fixture sshd not listening on 2222 within 15s" }

$app = Start-Process -FilePath $appExe -PassThru
$winDeadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $winDeadline) {
  $p = Get-Process -Id $app.Id -ErrorAction SilentlyContinue
  if ($p -and $p.MainWindowHandle -ne 0) { break }
  Start-Sleep -Milliseconds 300
}
if (-not (Get-Process -Id $app.Id -ErrorAction SilentlyContinue)) { throw "app exited early" }

# Foreground + topmost; window budget starts here.
$fgJson = & (Join-Path $PSScriptRoot "win-foreground.ps1") -TargetPid $app.Id
$shownAt = Get-Date
Write-Host "foreground: $fgJson"

$probeOut = Join-Path $qaDir "probe.out.txt"
$probeErr = Join-Path $qaDir "probe.err.txt"
$node = Start-Process node -ArgumentList @("scripts/m0-gui-probe.mjs", "9223", "docs/qa", "$($app.Id)") `
  -NoNewWindow -RedirectStandardOutput $probeOut -RedirectStandardError $probeErr -PassThru

$waitMs = [math]::Max(10, [math]::Min(75, $WindowSeconds - 8)) * 1000
try { Wait-Process -Id $node.Id -Timeout ([int]($waitMs / 1000)) -ErrorAction Stop } catch { }

$nodeAlive = Get-Process -Id $node.Id -ErrorAction SilentlyContinue
if ($nodeAlive) { Stop-Process -Id $node.Id -Force -ErrorAction SilentlyContinue }

$elapsed = ((Get-Date) - $shownAt).TotalSeconds

# Clear topmost, destroy app, clean up vite/fixture.
try { & (Join-Path $PSScriptRoot "win-foreground.ps1") -TargetPid $app.Id -Clear | Out-Null } catch { }
Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue
Stop-Process -Id $fixture.Id -Force -ErrorAction SilentlyContinue
Stop-Process -Id $vite.Id -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500

$nodeExit = $null
try { $nodeExit = $node.ExitCode } catch { }

$residue = @()
foreach ($name in @("shellora", "fixture_sshd")) {
  $left = Get-Process -Name $name -ErrorAction SilentlyContinue
  if ($left) { $residue += "${name}:$($left.Count)" }
}
foreach ($port in @(1420, 9223)) {
  if (Wait-Port $port 1) { $residue += "port:$port" }
}

$report = [pscustomobject]@{
  elapsedSec  = [math]::Round($elapsed, 1)
  windowLimit = $WindowSeconds
  foreground  = $fgJson
  nodeExit    = $nodeExit
  residue     = $residue
}
$report | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $qaDir "m0-window-run.json") -Encoding UTF8
$report | ConvertTo-Json -Depth 4
