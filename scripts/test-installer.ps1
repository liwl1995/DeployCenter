param(
  [Parameter(Mandatory=$true)][string]$Installer,
  [string]$OlderInstaller,
  [switch]$ResumeOwnedTest,
  [switch]$RunDesktopSmoke,
  [string]$InstallRoot = 'E:\temp\codex-data\2026-11-03\xia\work\安装验收',
  [string]$Report = 'E:\temp\codex-data\2026-11-03\xia\outputs\installer-verification.json'
)
$ErrorActionPreference = 'Stop'
$installerPath = (Resolve-Path -LiteralPath $Installer).Path
$expectedVersion = (Get-Content -LiteralPath (Join-Path $PSScriptRoot '../package.json') -Raw | ConvertFrom-Json).version
$testRoot = [IO.Path]::GetFullPath($InstallRoot)
$permittedRoot = [IO.Path]::GetFullPath('E:\temp\codex-data\2026-11-03\xia\work') + '\'
if (-not $testRoot.StartsWith($permittedRoot,[StringComparison]::OrdinalIgnoreCase)) { throw '安装测试目录必须位于本任务 work 目录' }
$targetDir = Join-Path $testRoot '中文 Space\Deploy Center'
$registryKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\331cf176-7a71-5b12-9fb9-5cf75e4f46af'
$dataPath = Join-Path $env:APPDATA 'DeployCenter'
$marker = [guid]::NewGuid().ToString()
if ((Test-Path -LiteralPath $registryKey) -or (Test-Path -LiteralPath $dataPath)) {
  if (-not $ResumeOwnedTest) { throw '已存在安装或用户数据，停止以保护现有内容；仅本任务的验收夹具可显式恢复' }
  $ownership = Join-Path $dataPath '.installer-test-owned'
  $oldLocation = Get-ItemPropertyValue -LiteralPath 'HKCU:\Software\331cf176-7a71-5b12-9fb9-5cf75e4f46af' -Name InstallLocation
  if (-not (Test-Path -LiteralPath $ownership) -or [IO.Path]::GetFullPath($oldLocation).TrimEnd('\') -ne $targetDir.TrimEnd('\')) { throw '已有内容不是本任务创建的安装验收夹具' }
  $marker = (Get-Content -LiteralPath $ownership -Raw).Trim()
  $null = [guid]::Parse($marker)
}
$results = [System.Collections.Generic.List[object]]::new()
function Assert-Check([string]$Name,[bool]$Condition,[string]$Detail='') {
  $results.Add(@{name=$Name;passed=$Condition;detail=$Detail})
  if (-not $Condition) { throw "检查失败：$Name $Detail" }
  Write-Output "PASS $Name"
}
function Run-Setup([string]$File,[string]$Arguments) {
  $process = Start-Process -FilePath $File -ArgumentList $Arguments -PassThru -WindowStyle Hidden
  if (-not $process.WaitForExit(180000)) { throw "安装或卸载未在 180 秒内完成：$File" }
  if ([IO.Path]::GetFileName($File).StartsWith('Uninstall ')) {
    $deadline = [DateTime]::UtcNow.AddSeconds(90)
    while ((Test-Path -LiteralPath $registryKey) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 250 }
  }
  return $process.ExitCode
}
function Installed-App {
  $new = Join-Path $targetDir 'YOTOO 部署中心.exe'
  if (Test-Path -LiteralPath $new) { return $new }
  return (Join-Path $targetDir 'Deploy Center.exe')
}
function Installed-Uninstaller {
  $new = Join-Path $targetDir 'Uninstall YOTOO 部署中心.exe'
  if (Test-Path -LiteralPath $new) { return $new }
  return (Join-Path $targetDir 'Uninstall Deploy Center.exe')
}
function Smoke-App {
  $appPath = Installed-App
  $oldOverride = $env:DEPLOY_CENTER_DATA_DIR
  Remove-Item Env:DEPLOY_CENTER_DATA_DIR -ErrorAction SilentlyContinue
  try {
    $smoke = Join-Path $dataPath 'smoke-result.json'
    if (Test-Path -LiteralPath $smoke) { Remove-Item -LiteralPath $smoke }
    $process = Start-Process -FilePath $appPath -ArgumentList '--smoke' -PassThru -WindowStyle Hidden
    if (-not $process.WaitForExit(60000)) { throw '安装后应用启动检查超时' }
    Assert-Check '已安装程序启动并生成检查结果' (Test-Path -LiteralPath $smoke)
    $value = Get-Content -LiteralPath $smoke -Raw | ConvertFrom-Json
    Assert-Check '正式程序 SQLite 和 Windows 加密可用' ($value.ok -and $value.sqlite -and $value.encrypted) ($value | ConvertTo-Json -Compress)
    return $value
  } finally { if ($null -ne $oldOverride) { $env:DEPLOY_CENTER_DATA_DIR = $oldOverride } }
}
try {
  New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
  New-Item -ItemType Directory -Path $dataPath -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $dataPath '.installer-test-owned') -Value $marker -Encoding utf8
  Set-Content -LiteralPath (Join-Path $dataPath 'keep-user-data.txt') -Value '部署配置与历史保护验收' -Encoding utf8
  $first = if ($OlderInstaller) { (Resolve-Path -LiteralPath $OlderInstaller).Path } else { $installerPath }
  $code = Run-Setup $first "/S /D=$targetDir"
  Assert-Check '中文和空格的自定义目录安装成功' ($code -eq 0 -and (Test-Path -LiteralPath (Installed-App))) "exit=$code"
  $entry = Get-ItemProperty -LiteralPath $registryKey
  Assert-Check 'Windows 应用注册与发布者' ($entry.DisplayName -match 'Deploy Center|YOTOO 部署中心' -and $entry.Publisher -in @('Deploy Center','YOTOO') -and (Get-ItemPropertyValue -LiteralPath 'HKCU:\Software\331cf176-7a71-5b12-9fb9-5cf75e4f46af' -Name InstallLocation).TrimEnd('\') -eq $targetDir.TrimEnd('\')) ($entry | Select-Object DisplayName,DisplayVersion,Publisher,InstallLocation | ConvertTo-Json -Compress)
  $previousShortcut = if ([IO.Path]::GetFileName((Installed-App)) -eq 'Deploy Center.exe') { 'Deploy Center.lnk' } else { 'YOTOO 部署中心.lnk' }
  $startLink = Join-Path ([Environment]::GetFolderPath('Programs')) $previousShortcut
  $desktopLink = Join-Path ([Environment]::GetFolderPath('Desktop')) $previousShortcut
  Assert-Check '开始菜单与桌面快捷方式存在' ((Test-Path -LiteralPath $startLink) -and (Test-Path -LiteralPath $desktopLink))
  $firstSmoke = Smoke-App
  $fixtureTool = Join-Path $PSScriptRoot 'installer-fixture.cjs'
  & node $fixtureTool seed $dataPath $marker $testRoot
  if ($LASTEXITCODE -ne 0) { throw '安装数据夹具写入失败' }
  # Playwright 负责正常退出测试应用，避免隐藏窗口没有 MainWindowHandle 时误判。
  $guard = & node (Join-Path $PSScriptRoot 'check-install-running.mjs') (Installed-App) $installerPath $dataPath
  Assert-Check '应用运行时阻止覆盖且不终止应用' ($LASTEXITCODE -eq 0 -and $guard -match 'guard-ok') ($guard -join "`n")
  $code = Run-Setup $installerPath '/S'
  Assert-Check '覆盖升级成功并沿用原目录' ($code -eq 0 -and (Test-Path -LiteralPath (Installed-App))) "exit=$code"
  $entry = Get-ItemProperty -LiteralPath $registryKey
  Assert-Check '升级只有一个应用注册项且版本正确' ($entry.DisplayVersion -eq $expectedVersion) $entry.DisplayVersion
  Assert-Check '升级保留用户数据' ((Get-Content -LiteralPath (Join-Path $dataPath 'keep-user-data.txt') -Raw).Contains('部署配置与历史保护验收'))
  $newStartLink = Join-Path ([Environment]::GetFolderPath('Programs')) 'YOTOO 部署中心.lnk'
  $newDesktopLink = Join-Path ([Environment]::GetFolderPath('Desktop')) 'YOTOO 部署中心.lnk'
  Assert-Check '升级后中文快捷方式有效且无旧品牌入口' ((Test-Path -LiteralPath $newStartLink) -and (Test-Path -LiteralPath $newDesktopLink) -and -not (Test-Path -LiteralPath (Join-Path ([Environment]::GetFolderPath('Programs')) 'Deploy Center.lnk')) -and -not (Test-Path -LiteralPath (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Deploy Center.lnk')))
  Assert-Check '中文名称和发布者注册正确' ($entry.DisplayName -like 'YOTOO 部署中心*' -and $entry.Publisher -eq 'YOTOO')
  $upgradedSmoke = Smoke-App
  $preserved = & node $fixtureTool verify $dataPath $marker $testRoot
  Assert-Check '升级保留 SQLite 中的真实服务配置' ($LASTEXITCODE -eq 0 -and $preserved -match 'fixture-kept')
  if ($RunDesktopSmoke) {
    $previousExe = $env:DEPLOY_CENTER_TEST_EXE
    $previousScale = $env:DEPLOY_CENTER_TEST_SCALE
    try {
      # 直接测试安装后的 EXE，数据仍由 Playwright 隔离到 .test-data；同时检查 150% 缩放。
      $env:DEPLOY_CENTER_TEST_EXE = Installed-App
      $env:DEPLOY_CENTER_TEST_SCALE = '1.5'
      & npm run test:smoke
      Assert-Check '已安装 EXE 的四项桌面测试通过（150% 缩放）' ($LASTEXITCODE -eq 0)
    } finally {
      $env:DEPLOY_CENTER_TEST_EXE = $previousExe
      $env:DEPLOY_CENTER_TEST_SCALE = $previousScale
    }
  }
  $uninstaller = Installed-Uninstaller
  $code = Run-Setup $uninstaller '/S'
  Assert-Check '卸载移除应用注册与快捷方式' ($code -eq 0 -and -not (Test-Path -LiteralPath $registryKey) -and -not (Test-Path -LiteralPath $startLink) -and -not (Test-Path -LiteralPath $desktopLink) -and -not (Test-Path -LiteralPath $newStartLink) -and -not (Test-Path -LiteralPath $newDesktopLink)) "exit=$code"
  Assert-Check '卸载移除主程序文件' (-not (Test-Path -LiteralPath (Installed-App)))
  Assert-Check '默认卸载保留配置和历史数据' (Test-Path -LiteralPath (Join-Path $dataPath 'keep-user-data.txt'))
  $code = Run-Setup $installerPath "/S /D=$targetDir"
  Assert-Check '卸载后可重新安装' ($code -eq 0)
  # 仅对本脚本创建、标记且未预先存在的数据执行彻底清理测试。
  if ((Get-Content -LiteralPath (Join-Path $dataPath '.installer-test-owned') -Raw).Trim() -ne $marker) { throw '用户数据所有权标记不匹配，拒绝清理' }
  $code = Run-Setup (Installed-Uninstaller) '/S /PURGEDATA'
  Assert-Check '可选彻底清理删除本脚本创建的数据' ($code -eq 0 -and -not (Test-Path -LiteralPath $dataPath)) "exit=$code"
  Assert-Check '最终卸载状态无残留注册项' (-not (Test-Path -LiteralPath $registryKey))
  @{ok=$true;timestamp=[DateTime]::UtcNow.ToString('o');sha256=(Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash;installer=$installerPath;older=$OlderInstaller;installDir=$targetDir;checks=$results} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $Report -Encoding utf8
} catch {
  @{ok=$false;error=$_.Exception.Message;installer=$installerPath;installDir=$targetDir;checks=$results} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $Report -Encoding utf8
  throw
}
