# Windows 安装包无窗口冒烟（NSIS + MSI）。
# 约定：NSIS 为 currentUser 安装（不触发 UAC）；MSI 为 perMachine，静默安装需要管理员，
# 未提权时只记录失败原因，不弹 UAC、不请求提升。
param(
    [string]$Installer = "",
    [string]$Msi = "",
    [int]$UninstallTimeoutSec = 45
)

$ErrorActionPreference = "Stop"
$checks = @()

# 本脚本及其子进程统一降为 BelowNormal，避免影响前台。
try { (Get-Process -Id $PID).PriorityClass = "BelowNormal" } catch { }

function Add-Check([string]$Name, [bool]$Ok, [string]$Detail = "") {
    $script:checks += [pscustomobject]@{ section = $script:section; name = $Name; ok = $Ok; detail = $Detail }
    $mark = if ($Ok) { "PASS" } else { "FAIL" }
    Write-Host "[$mark][$script:section] $Name $Detail"
}

function Start-Hidden([string]$File, [string]$Arguments) {
    $p = Start-Process -FilePath $File -ArgumentList $Arguments -PassThru -WindowStyle Hidden
    try { $p.PriorityClass = "BelowNormal" } catch { }
    return $p
}

function Wait-Exit($Process, [int]$TimeoutSec = 180) {
    if (-not $Process.WaitForExit($TimeoutSec * 1000)) {
        try { $Process.Kill() } catch { }
        return $null
    }
    return $Process.ExitCode
}

function Get-UninstallKeys([string]$Match = "Shellora") {
    $roots = @(
        "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall",
        "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall",
        "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"
    )
    foreach ($root in $roots) {
        if (-not (Test-Path $root)) { continue }
        Get-ChildItem $root | ForEach-Object {
            $props = Get-ItemProperty $_.PSPath
            if ($props.DisplayName -like "*$Match*") { $props }
        }
    }
}

function Get-StartMenuShortcut {
    # NSIS 与 MSI 都把快捷方式放在 Programs\Shellora\ 子目录下，因此递归查找。
    $roots = @(
        (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"),
        (Join-Path $env:ProgramData "Microsoft\Windows\Start Menu\Programs")
    )
    foreach ($root in $roots) {
        if (-not (Test-Path $root)) { continue }
        $hit = Get-ChildItem $root -Recurse -Filter "Shellora*.lnk" -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($hit) { return $hit.FullName }
    }
    return $null
}

function Get-DesktopShortcut {
    $candidates = @(
        (Join-Path ([Environment]::GetFolderPath("Desktop")) "Shellora.lnk"),
        (Join-Path $env:PUBLIC "Desktop\Shellora.lnk")
    )
    $found = $candidates | Where-Object { Test-Path $_ }
    return ($found | Select-Object -First 1)
}

$root = Split-Path -Parent $PSScriptRoot
$expectedVersion = (Get-Content (Join-Path $root "package.json") -Raw | ConvertFrom-Json).version
$versionPattern = "Shellora\s+" + [regex]::Escape([string]$expectedVersion)
$nsisDir = Join-Path $root "src-tauri/target/release/bundle/nsis"
$msiDir = Join-Path $root "src-tauri/target/release/bundle/msi"

if (-not $Installer) {
    $candidates = Get-ChildItem $nsisDir -Filter "*setup.exe" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending
    if (-not $candidates) { throw "未找到 NSIS 安装包，请先运行 pnpm tauri build --bundles nsis" }
    $Installer = $candidates[0].FullName
}
if (-not $Msi) {
    $candidates = Get-ChildItem $msiDir -Filter "*.msi" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending
    if ($candidates) { $Msi = $candidates[0].FullName }
}

$beforeKeys = Get-UninstallKeys
if ($beforeKeys) { throw "检测到已安装的 Shellora，请先卸载后再跑冒烟" }

$workDir = Join-Path $env:TEMP ("sshtem-smoke-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force $workDir | Out-Null

# ---------------------------------------------------------------- NSIS
$script:section = "NSIS"
Add-Check "安装包存在" (Test-Path $Installer) $Installer

$nsisCopy = Join-Path $workDir "setup.exe"
Copy-Item $Installer $nsisCopy
$proc = Start-Hidden $nsisCopy "/S"
$code = Wait-Exit $proc 180
Add-Check "静默安装退出码" ($code -eq 0) "exit=$code"

$key = Get-UninstallKeys | Select-Object -First 1
Add-Check "注册表卸载项已写入" ($null -ne $key) $(if ($key) { $key.PSChildName } else { "" })

$installDir = if ($key -and $key.InstallLocation) { $key.InstallLocation.Trim('"') } else { Join-Path $env:LOCALAPPDATA "Shellora" }
Add-Check "安装目录存在" (Test-Path $installDir) $installDir

$exe = if (Test-Path (Join-Path $installDir "shellora.exe")) {
    Join-Path $installDir "shellora.exe"
} else {
    (Get-ChildItem $installDir -Filter "*.exe" -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -notmatch '^(uninstall|fixture_sshd)\.exe$' } |
        Sort-Object Length -Descending | Select-Object -First 1).FullName
}
Add-Check "主程序存在" (Test-Path $exe) $exe
Add-Check "安装包不含开发夹具" (-not (Test-Path (Join-Path $installDir "fixture_sshd.exe")))

$versionOut = (& $exe --version 2>&1 | Out-String).Trim()
Add-Check "安装后 --version" ($versionOut -match $versionPattern) $versionOut

$healthOut = (& $exe --health-check 2>&1 | Out-String).Trim()
$healthOk = $false
try {
    $health = $healthOut | ConvertFrom-Json
    $healthOk = [bool]$health.ok -and $health.product -eq "Shellora" -and $health.version -eq $expectedVersion -and $health.db -eq "ok"
} catch { $healthOk = $false }
Add-Check "启动健康检查" $healthOk $healthOut

$sm = Get-StartMenuShortcut
Add-Check "开始菜单快捷方式存在" ($null -ne $sm) $(if ($sm) { $sm } else { "未找到" })
$desktop = Get-DesktopShortcut
Add-Check "桌面快捷方式存在" ($null -ne $desktop) $(if ($desktop) { $desktop } else { "未找到" })

# M6 验收 5：卸载保留用户数据。
$dataDir = Join-Path $env:APPDATA "com.shellora.desktop"
$marker = Join-Path $dataDir "smoke-marker.txt"
$markerCreated = $false
if (-not (Test-Path $dataDir)) {
    New-Item -ItemType Directory -Force $dataDir | Out-Null
    $markerCreated = $true
}
Set-Content -Path $marker -Value "keep-me" -Encoding utf8

$uninstaller = Join-Path $installDir "uninstall.exe"
Add-Check "卸载程序存在" (Test-Path $uninstaller) $uninstaller
$up = Start-Hidden $uninstaller "/S"
$ucode = Wait-Exit $up 180
Add-Check "静默卸载退出码" ($ucode -eq 0) "exit=$ucode"

$deadline = (Get-Date).AddSeconds($UninstallTimeoutSec)
while ((Test-Path $installDir) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
Add-Check "安装目录已删除" (-not (Test-Path $installDir)) $installDir

# NSIS 卸载器先删目录、后删注册表（脚本被复制到临时目录异步执行），需再等注册表收敛。
$deadline = (Get-Date).AddSeconds($UninstallTimeoutSec)
while (@(Get-UninstallKeys).Count -gt 0 -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
$afterKeys = @(Get-UninstallKeys)
Add-Check "卸载注册表项已清除" ($afterKeys.Count -eq 0) "剩余=$($afterKeys.Count)"
Add-Check "开始菜单快捷方式已删除" ($null -eq (Get-StartMenuShortcut))
Add-Check "桌面快捷方式已删除" ($null -eq (Get-DesktopShortcut))
Add-Check "用户数据目录保留" (Test-Path $marker) $marker

Remove-Item $marker -ErrorAction SilentlyContinue
if ($markerCreated) { Remove-Item $dataDir -Recurse -Force -ErrorAction SilentlyContinue }

# ---------------------------------------------------------------- MSI
$script:section = "MSI"
if (-not $Msi -or -not (Test-Path $Msi)) {
    Add-Check "MSI 安装包存在" $false "未找到 msi（需先构建 --bundles msi）"
} else {
    Add-Check "MSI 安装包存在" $true $Msi
    $msiCopy = Join-Path $workDir "setup.msi"
    Copy-Item $Msi $msiCopy

    # MSI 的 INSTALLDIR 会继承 HKCU\Software\Shellora\Shellora 的历史安装路径（NSIS 卸载后仍保留），
    # 这里清掉以模拟干净机器的 perMachine 默认路径（%ProgramFiles%\Shellora）。
    Remove-Item "HKCU:\Software\Shellora" -Recurse -Force -ErrorAction SilentlyContinue

    # perMachine MSI：非管理员 /qn 会失败（1603/1925）。脚本不自行提权，由调用方决定是否以管理员运行。
    $elevated = (New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    $mp = Start-Hidden "msiexec.exe" "/i `"$msiCopy`" /qn /norestart"
    $mcode = Wait-Exit $mp 300
    Add-Check "MSI 静默安装退出码" ($mcode -eq 0) "exit=$mcode（管理员=$elevated）"

    $mkeys = Get-UninstallKeys
    $mkey = $mkeys | Where-Object { $_.DisplayName -eq "Shellora" } | Select-Object -First 1
    Add-Check "MSI 卸载键已写入" ($null -ne $mkey) $(if ($mkey) { $mkey.PSChildName } else { "无" })

    # 安装目录以 ARP 的 InstallLocation 为准；再兜底两个默认位置。
    $mDirs = @()
    if ($mkey -and $mkey.InstallLocation) { $mDirs += $mkey.InstallLocation.Trim('"').TrimEnd('\') }
    $mDirs += (Join-Path $env:ProgramFiles "Shellora")
    $mDirs += (Join-Path $env:LOCALAPPDATA "Shellora")
    $mInstallDir = $mDirs | Where-Object { Test-Path (Join-Path $_ "shellora.exe") } | Select-Object -First 1
    Add-Check "MSI 安装目录存在" ($null -ne $mInstallDir) $(if ($mInstallDir) { $mInstallDir } else { $mDirs -join "; " })
    $expectedMsiDir = Join-Path $env:ProgramFiles "Shellora"
    Add-Check "MSI 安装目录为 perMachine 默认位置" ($mInstallDir -eq $expectedMsiDir) "$mInstallDir（期望 $expectedMsiDir）"
    Add-Check "MSI 开始菜单快捷方式存在" ($null -ne (Get-StartMenuShortcut)) "$(Get-StartMenuShortcut)"
    if ($mInstallDir) {
        $mVersion = (& (Join-Path $mInstallDir "shellora.exe") --version 2>&1 | Out-String).Trim()
        Add-Check "MSI 安装后 --version" ($mVersion -match $versionPattern) $mVersion
    }

    if ($mcode -eq 0) {
        $target = if ($mkey) { "/x `"$($mkey.PSChildName)`"" } else { "/x `"$msiCopy`"" }
        $xp = Start-Hidden "msiexec.exe" "$target /qn /norestart"
        $xcode = Wait-Exit $xp 300
        Add-Check "MSI 静默卸载退出码" ($xcode -eq 0) "exit=$xcode"
        $deadline = (Get-Date).AddSeconds($UninstallTimeoutSec)
        while ($mInstallDir -and (Test-Path $mInstallDir) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
        Add-Check "MSI 安装目录已删除" ($null -eq $mInstallDir -or -not (Test-Path $mInstallDir)) $mInstallDir
        Add-Check "MSI 卸载键已清除" ($null -eq (Get-UninstallKeys | Where-Object { $_.DisplayName -eq "Shellora" } | Select-Object -First 1))
        Add-Check "MSI 开始菜单快捷方式已删除" ($null -eq (Get-StartMenuShortcut))
    } else {
        Write-Host "MSI 段跳过后续安装断言：需要管理员权限（未提权，未弹 UAC）。"
    }
}

Remove-Item $workDir -Recurse -Force -ErrorAction SilentlyContinue

$failed = @($checks | Where-Object { -not $_.ok })
Write-Host ""
Write-Host ("冒烟结果：{0}/{1} 通过" -f ($checks.Count - $failed.Count), $checks.Count)
if ($failed.Count -gt 0) {
    $failed | ForEach-Object { Write-Host ("  FAIL: [{0}] {1} {2}" -f $_.section, $_.name, $_.detail) }
    exit 1
}
exit 0
