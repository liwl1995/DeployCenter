# 仅安装独立 QA 身份；注册表、快捷方式、程序目录和用户数据均与正式版本隔离。
param([string]$Prepackaged, [string]$ScratchDirectory)
$ErrorActionPreference='Stop'
$repoRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$version=(Get-Content (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json).version
$id=[guid]::NewGuid().ToString()
$testRoot=if($ScratchDirectory){[IO.Path]::GetFullPath($ScratchDirectory)}else{Join-Path $repoRoot '.test-data'}
$qaRoot=Join-Path $testRoot "installer-qa-$id"
$program=Join-Path $qaRoot '中文 Space/程序'
$newProgram=Join-Path $qaRoot '新位置 Space/程序'
$data=Join-Path $qaRoot '中文 数据/DeployCenter'
$build=Join-Path $qaRoot 'build'
$locationKey="Software\YOTOO\DeployCenter.Tests\$id"
$product="YOTOO DeployCenter QA $($id.Substring(0,8))"
$qaPackage="deploy-center-qa-$id"
$sharedCache=Join-Path $env:LOCALAPPDATA 'deploy-center-updater/installer.exe'
$sharedHash=if(Test-Path -LiteralPath $sharedCache){(Get-FileHash -LiteralPath $sharedCache -Algorithm SHA256).Hash}else{''}
$appId="local.deploycenter.desktop.qa.$id"
$uninstallKey="HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$id"
$installKey="HKCU:\Software\$id"
$shortcuts=@(
  (Join-Path ([Environment]::GetFolderPath('Programs')) "$product.lnk"),
  (Join-Path ([Environment]::GetFolderPath('Desktop')) "$product.lnk")
)
$report=Join-Path $repoRoot "release/installer-qa-$version.json"
$source=$null
if($Prepackaged){
  $releaseRoot=[IO.Path]::GetFullPath((Join-Path $repoRoot 'release'))
  $source=[IO.Path]::GetFullPath($Prepackaged)
  $relative=[IO.Path]::GetRelativePath($releaseRoot,$source)
  if($relative -notmatch '^(?:[a-zA-Z0-9][a-zA-Z0-9._-]*[\\/])?win-unpacked$'){
    throw '只接受 release 下的 win-unpacked 正式构建'
  }
  $directory=Get-Item -LiteralPath $releaseRoot
  foreach($segment in $relative -split '[\\/]'){
    if($directory.Attributes -band [IO.FileAttributes]::ReparsePoint){throw '正式构建目录不能是链接'}
    $directory=Get-Item -LiteralPath (Join-Path $directory.FullName $segment)
  }
  if(-not $directory.PSIsContainer -or ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint)){
    throw '正式构建目录无效'
  }
  $report=Join-Path $directory.Parent.FullName "installer-qa-$version.json"
}
$checks=[System.Collections.Generic.List[object]]::new()
function Check([string]$Name,[bool]$Passed){$checks.Add(@{name=$Name;passed=$Passed});if(-not $Passed){throw "验收失败：$Name"};Write-Output "PASS $Name"}
function Test-QaShortcut([string]$Link,[string]$Exe) {
  if (-not (Test-Path -LiteralPath $Link)) { return $false }
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($Link)
  $icon = Join-Path (Split-Path -Parent $Exe) 'deploy-center.ico'
  $shellApps = New-Object -ComObject Shell.Application
  $folder = $shellApps.NameSpace((Split-Path -Parent $Link))
  $entry = $folder.ParseName((Split-Path -Leaf $Link))
  return ($shortcut.TargetPath -eq $Exe -and $shortcut.IconLocation -eq "$icon,0" -and
    (Test-Path -LiteralPath $icon -PathType Leaf) -and
    $entry.ExtendedProperty('System.AppUserModel.ID') -eq $appId)
}
function Test-QaRegisteredStartTarget([string]$Exe) {
  $shell = New-Object -ComObject Shell.Application
  $deadline = [DateTime]::UtcNow.AddSeconds(12)
  do {
    $folder = $shell.NameSpace('shell:AppsFolder')
    $entry = $folder.Items() | Where-Object Path -eq $appId | Select-Object -First 1
    if ($entry -and $entry.ExtendedProperty('System.Link.TargetParsingPath') -eq $Exe) { return $true }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  return $false
}
function Run([string]$File,[string]$Arguments){
  $p=Start-Process -FilePath $File -ArgumentList $Arguments -PassThru -WindowStyle Hidden
  if(-not $p.WaitForExit(180000)){
    $script:timedOutProcess=$p
    throw '隔离安装程序未正常退出'
  }
  return $p.ExitCode
}
function Test-InteractiveInstaller([string]$File, [string]$ExpectedDirectory, [switch]$Install) {
  if (-not ('DeployCenterQaWizard' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class DeployCenterQaWizard
{
    private delegate bool EnumChild(IntPtr window, IntPtr state);
    [DllImport("user32.dll")]
    private static extern bool EnumChildWindows(IntPtr parent, EnumChild callback, IntPtr state);
    [DllImport("user32.dll", EntryPoint = "GetClassNameW", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr window, StringBuilder text, int length);
    [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr size,
        StringBuilder text, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW")]
    private static extern IntPtr SendIconMessage(IntPtr window, uint message, IntPtr size,
        IntPtr unused, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll")]
    private static extern IntPtr GetDlgItem(IntPtr window, int id);
    [DllImport("user32.dll", EntryPoint = "PostMessageW")]
    private static extern bool PostMessage(IntPtr window, uint message, IntPtr argument, IntPtr source);
    [DllImport("user32.dll")]
    private static extern bool IsWindowEnabled(IntPtr window);

    private static string Text(IntPtr window)
    {
        var text = new StringBuilder(1024);
        IntPtr read;
        return SendMessageTimeout(window, 0x000D, (IntPtr)text.Capacity, text, 2, 1000, out read) == IntPtr.Zero
            ? null : text.ToString();
    }

    public static bool OpenDirectoryPage(IntPtr parent)
    {
        return ClickNext(parent, "开始设置");
    }

    public static bool ClickNext(IntPtr parent, string label)
    {
        var next = GetDlgItem(parent, 1);
        var text = next == IntPtr.Zero ? null : Text(next);
        return text != null && IsWindowEnabled(next) && text.Replace("&", "").StartsWith(label, StringComparison.Ordinal)
            && PostMessage(parent, 0x0111, (IntPtr)1, next);
    }

    public static string DirectoryText(IntPtr parent)
    {
        string value = null;
        EnumChildWindows(parent, (window, state) =>
        {
            var text = new StringBuilder(128);
            GetClassName(window, text, text.Capacity);
            if (!String.Equals(text.ToString(), "Edit", StringComparison.OrdinalIgnoreCase)) return true;
            value = Text(window);
            return value == null;
        }, IntPtr.Zero);
        return value;
    }

    public static bool HasWindowIcon(IntPtr window)
    {
        IntPtr icon;
        return SendIconMessage(window, 0x007F, (IntPtr)1, IntPtr.Zero, 2, 1000, out icon) != IntPtr.Zero
            && icon != IntPtr.Zero;
    }
}
'@
  }
  $wizard = Start-Process -FilePath $File -PassThru
  try {
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    $opened = $false
    do {
      Start-Sleep -Milliseconds 100
      $wizard.Refresh()
      $window = $wizard.MainWindowHandle
      # 等欢迎页完成初始化，每轮只点击一次「开始设置」，停在目录页。
      if ($window -ne 0) { $opened = [DeployCenterQaWizard]::OpenDirectoryPage($window) }
    } while (-not $opened -and -not $wizard.HasExited -and [DateTime]::UtcNow -lt $deadline)
    if (-not $opened) { throw '隔离安装向导的欢迎页未就绪' }
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    do {
      Start-Sleep -Milliseconds 100
      $wizard.Refresh()
      $window = $wizard.MainWindowHandle
      if ($window -ne 0) {
        $value = [DeployCenterQaWizard]::DirectoryText($window)
        if ($null -ne $value) { break }
      }
    } while (-not $wizard.HasExited -and [DateTime]::UtcNow -lt $deadline)
    if ($null -eq $value) { throw '无法读取隔离向导的安装目录输入框' }
    if ($value -ne $ExpectedDirectory) { throw "向导未预填原目录：$value" }
    if (-not $Install) { return }
    if (-not [DeployCenterQaWizard]::ClickNext($window, '安装')) { throw '隔离向导的安装按钮不可用' }
    $deadline = [DateTime]::UtcNow.AddSeconds(120)
    do {
      Start-Sleep -Milliseconds 100
      $wizard.Refresh()
      $window = $wizard.MainWindowHandle
      if ($window -ne 0 -and [DeployCenterQaWizard]::ClickNext($window, '完成')) {
        if (-not $wizard.WaitForExit(10000) -or $wizard.ExitCode -ne 0) { throw '安装完成后向导未正常退出' }
        return
      }
    } while (-not $wizard.HasExited -and [DateTime]::UtcNow -lt $deadline)
    throw '安装完成页未显示或不响应'
  } finally {
    if (-not $wizard.HasExited) {
      $null = $wizard.CloseMainWindow()
      if (-not $wizard.WaitForExit(3000)) {
        $wizard.Kill()
        if (-not $wizard.WaitForExit(5000)) { throw '隔离安装向导未退出' }
      }
    }
    $wizard.Dispose()
  }
}
function Close-QaApp([string[]]$Paths){
  foreach($running in @(Get-Process -Name $product -ErrorAction SilentlyContinue | Where-Object { $_.Path -in $Paths })){
    $null=$running.CloseMainWindow()
    if(-not $running.WaitForExit(5000)){
      $running.Kill()
      if(-not $running.WaitForExit(5000)){throw '隔离程序尚未退出'}
    }
  }
}
function Wait-QaWindow([string]$Exe) {
  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  do {
    $running = Get-Process -Name $product -ErrorAction SilentlyContinue | Where-Object {
      $_.Path -eq $Exe -and $_.MainWindowHandle -ne 0
    } | Select-Object -First 1
    if ($running) { return $running }
    Start-Sleep -Milliseconds 200
  } while ([DateTime]::UtcNow -lt $deadline)
}
function Formal-Snapshot {
  $key='HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\331cf176-7a71-5b12-9fb9-5cf75e4f46af'
  if(Test-Path -LiteralPath $key){return (Get-ItemProperty -LiteralPath $key | Select-Object DisplayName,DisplayVersion,InstallLocation,UninstallString | ConvertTo-Json -Compress)}
  return ''
}
$before=Formal-Snapshot
$owned=$false
$child=$null
$timedOutProcess=$null
$previousEnvironment=@{
  DEPLOY_CENTER_DATA_DIR=$env:DEPLOY_CENTER_DATA_DIR
  DEPLOY_CENTER_SETTINGS_DIR=$env:DEPLOY_CENTER_SETTINGS_DIR
  DEPLOY_CENTER_TESTING=$env:DEPLOY_CENTER_TESTING
}
$result=@{ok=$false;version=$version;namespace=$appId;locationKey=$locationKey;root=$qaRoot;checks=$checks}
try{
  if([IO.Path]::GetDirectoryName($qaRoot) -ne $testRoot -or (Test-Path -LiteralPath $qaRoot)){throw 'QA 路径无效或已存在'}
  $testDirectory=Get-Item -LiteralPath $testRoot -Force -ErrorAction SilentlyContinue
  if($testDirectory -and ($testDirectory.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'QA 上级目录不能是链接'}
  New-Item -ItemType Directory -Path $qaRoot | Out-Null
  $owned=$true
  $roaming=Split-Path -Parent $data
  $legacy=Join-Path $qaRoot '空的旧设置'
  New-Item -ItemType Directory -Path $qaRoot,$roaming,$build -Force | Out-Null
  $wrapper=Join-Path $qaRoot 'custom.nsh'
  Set-Content -LiteralPath $wrapper -Value "!define YOTOO_LOCATION_KEY `"$locationKey`"`r`n!define YOTOO_ROAMING_DATA `"$roaming`"`r`n!define YOTOO_LEGACY_SETTINGS `"$legacy`"`r`n!include `"$repoRoot\installer\custom.nsh`"" -Encoding utf8
  $builderArgs=@("--config.extraMetadata.name=$qaPackage",'--win','nsis','--x64',"--config.appId=$appId","--config.productName=$product","--config.nsis.guid=$id","--config.nsis.shortcutName=$product","--config.nsis.include=$wrapper","--config.directories.output=$build",'--config.win.artifactName=QA-Setup.exe','--publish','never')
  if($source){
    $clone=Join-Path $qaRoot 'packaged'
    New-Item -ItemType Directory -Path $clone -Force | Out-Null
    Get-ChildItem -LiteralPath $source -Force | Copy-Item -Destination $clone -Recurse
    Move-Item -LiteralPath (Join-Path $clone 'YOTOO 部署中心.exe') -Destination (Join-Path $clone "$product.exe")
    $builderArgs+=@('--prepackaged',$clone)
  }
  & node (Join-Path $repoRoot 'scripts/build-installer.mjs') @builderArgs *> (Join-Path $qaRoot 'build.log')
  if($LASTEXITCODE -ne 0){throw "隔离安装包构建失败：$(Get-Content (Join-Path $qaRoot 'build.log') -Tail 7 | Out-String)"}
  $installer=Join-Path $build 'QA-Setup.exe'
  $env:DEPLOY_CENTER_DATA_DIR=$data
  $env:DEPLOY_CENTER_SETTINGS_DIR=Join-Path $qaRoot 'test-locator'
  $env:DEPLOY_CENTER_TESTING='1'
  Check '首次安装没有预建数据目录或位置记录' (-not(Test-Path -LiteralPath $data) -and -not(Test-Path -LiteralPath "HKCU:\$locationKey"))
  Check '首次安装自动创建数据目录并支持中文安装路径' ((Run $installer "/S /D=$program") -eq 0 -and (Test-Path -LiteralPath $data))
  Set-Content -LiteralPath (Join-Path $data '.yotoo-data-owner.ini') -Value "[application]`r`nid=local.deploycenter.desktop`r`n" -Encoding utf8
  Set-Content -LiteralPath (Join-Path $data 'keep-user-data.txt') -Value $id -Encoding utf8
  New-Item -Path "HKCU:\$locationKey" -Force | Out-Null
  Set-ItemProperty -LiteralPath "HKCU:\$locationKey" -Name DataDirectory -Value $data
  $exe=Join-Path $program "$product.exe"
  $packageSha256=(Get-FileHash -LiteralPath (Join-Path $program 'resources/app.asar')).Hash
  Check '安装主程序存在' (Test-Path -LiteralPath $exe)
  Check '框架不再产生额外用户目录缓存' (-not(Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA "$qaPackage-updater/installer.exe")))
  Check '安装日志在配置目录' (Test-Path -LiteralPath (Join-Path $data 'logs/installer/last-install.log'))
  $entry=@(Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' | Get-ItemProperty | Where-Object {$_.DisplayName -like "$product*"})
  Check '独立应用注册项' ($entry.Count -eq 1 -and $entry[0].PSChildName -eq $id -and $entry[0].DisplayVersion -eq $version)
  Check '开始菜单和桌面快捷方式使用正确的程序和图标' ((Test-QaShortcut $shortcuts[0] $exe) -and (Test-QaShortcut $shortcuts[1] $exe))
  Check '已安装程序实际启动与 SQLite 加密渲染' ((Run $exe '--smoke') -eq 0 -and (Get-Content (Join-Path $data 'smoke-result.json') -Raw | ConvertFrom-Json).ok)
  Start-Sleep -Milliseconds 800
  $archive=Join-Path $program 'resources/app.asar'
  $lock=[IO.File]::Open($archive, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try {
    Check '程序集被占用时安全停止升级并保留旧入口' ((Run $installer '/S') -eq 1603 -and
      (Test-Path -LiteralPath $exe) -and (Get-FileHash -LiteralPath $archive).Hash -eq $packageSha256)
  } finally { $lock.Dispose() }
  $shell = New-Object -ComObject WScript.Shell
  $broken = $shell.CreateShortcut($shortcuts[0])
  $broken.TargetPath = Join-Path $qaRoot '1'
  $broken.IconLocation = '1,0'
  $broken.Save()
  Test-InteractiveInstaller $installer $program -Install
  Check '交互覆盖安装完成页可点击且能打开应用' ($null -ne (Wait-QaWindow $exe))
  Close-QaApp @($exe)
  Start-Process -FilePath $shortcuts[1]
  $desktopApp = Wait-QaWindow $exe
  Check '从桌面快捷方式启动的主窗口有 Windows 图标' ($null -ne $desktopApp -and
    [DeployCenterQaWizard]::HasWindowIcon($desktopApp.MainWindowHandle))
  Close-QaApp @($exe)
  Check '覆盖升级保留用户数据' ((Get-Content (Join-Path $data 'keep-user-data.txt') -Raw).Trim() -eq $id)
  Check '覆盖升级修复损坏的开始菜单快捷方式' (Test-QaShortcut $shortcuts[0] $exe)
  Check 'Windows 应用列表解析到修复后的程序' (Test-QaRegisteredStartTarget $exe)
  # 模拟旧版内部位置为空、Windows 已安装应用记录依然完整。
  Set-ItemProperty -LiteralPath $installKey -Name InstallLocation -Value ''
  Test-InteractiveInstaller $installer $program
  Check '交互向导从欢迎页进入后预填原目录' $true
  Check '内部位置为空时从卸载注册恢复原安装目录' ((Run $installer '/S') -eq 0 -and
    (Get-ItemPropertyValue -LiteralPath $installKey -Name InstallLocation) -eq $program.Replace('/','\') -and
    (Get-ItemPropertyValue -LiteralPath $uninstallKey -Name InstallLocation) -eq $program.Replace('/','\') -and
    (Test-Path -LiteralPath $exe) -and (Get-Content (Join-Path $data 'keep-user-data.txt') -Raw).Trim() -eq $id)
  $desktopLink=Join-Path ([Environment]::GetFolderPath('Desktop')) "$product.lnk"
  $different=Join-Path $qaRoot '静默更新不得使用'
  Check '静默更新拒绝更换已注册目录' ((Run $installer "/S /YOTOOUPDATE /D=$different") -eq 1603 -and -not(Test-Path -LiteralPath (Join-Path $different "$product.exe")))
  Check '静默更新保留已有桌面快捷方式' ((Run $installer "/S /YOTOOUPDATE /D=$program") -eq 0 -and (Test-Path -LiteralPath $desktopLink))
  Remove-Item -LiteralPath $desktopLink
  $helper=Join-Path $program 'resources/update-helper.exe'
  $log=Join-Path $data 'logs/update/update-install.log'
  New-Item -ItemType Directory -Path (Split-Path -Parent $log) -Force | Out-Null
  function Encode([string]$Value){[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Value))}
  $digest=(Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
  # 这一步检查真实可见窗口。隐藏启动会改写 Electron 首次显示窗口的 Win32 参数。
  $parent=Start-Process -FilePath $exe -PassThru -RedirectStandardError (Join-Path $qaRoot 'old-app.stderr.log')
  $deadline=[DateTime]::UtcNow.AddSeconds(30)
  do {
    $parent.Refresh()
    if($parent.MainWindowHandle -ne 0 -or $parent.HasExited){break}
    Start-Sleep -Milliseconds 200
  } while([DateTime]::UtcNow -lt $deadline)
  Check '旧应用等待交接时保持运行' (-not $parent.HasExited -and $parent.MainWindowHandle -ne 0)
  $handoff="$($parent.Id) $(Encode $installer) $digest $(Encode $program) $(Encode $log) $version $(Encode $exe)"
  $start=[Diagnostics.ProcessStartInfo]::new($helper,$handoff)
  $start.WorkingDirectory=$program
  $start.UseShellExecute=$false
  $start.CreateNoWindow=$true
  $start.RedirectStandardOutput=$true
  $testTemp=Join-Path $data 'tmp/system'
  New-Item -ItemType Directory -Path $testTemp -Force | Out-Null
  $start.Environment['TEMP']=$testTemp
  $start.Environment['TMP']=$testTemp
  $child=[Diagnostics.Process]::Start($start)
  $ready=$child.StandardOutput.ReadLineAsync()
  Check '助手就绪后才退出旧应用' ($ready.Wait(15000) -and $ready.Result -eq 'UPDATE_READY' -and -not $parent.HasExited)
  $null=$parent.CloseMainWindow()
  $deadline=[DateTime]::UtcNow.AddSeconds(45)
  while ((Test-Path -LiteralPath $exe) -and -not $child.HasExited -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 25
  }
  Check '静默安装期间快捷方式没有可执行目标' (-not ($child.HasExited) -and -not (Test-Path -LiteralPath $exe))
  Check '静默覆盖期间保留开始菜单快捷方式' (Test-Path -LiteralPath $shortcuts[0] -PathType Leaf)
  Check '独立助手静默覆盖原目录' ($child.WaitForExit(180000) -and $child.ExitCode -eq 0)
  $deadline=[DateTime]::UtcNow.AddSeconds(30)
  do {
    $restarted=Get-Process -Name $product -ErrorAction SilentlyContinue | Where-Object {
      $_.Path -eq $exe -and $_.MainWindowTitle -ceq 'YOTOO 部署中心'
    } | Select-Object -First 1
    if(-not $restarted){Start-Sleep -Milliseconds 250}
  } until($restarted -or [DateTime]::UtcNow -ge $deadline)
  Check '静默安装后自动打开主窗口' ($null -ne $restarted)
  Check '静默安装后开始菜单入口和图标有效' (Test-QaShortcut $shortcuts[0] $exe)
  if($restarted){$null=$restarted.CloseMainWindow();$null=$restarted.WaitForExit(10000)}
  Check '静默更新保留原目录及用户数据和快捷方式选择' ((Test-Path -LiteralPath $exe) -and -not(Test-Path -LiteralPath $desktopLink) -and (Get-Content (Join-Path $data 'keep-user-data.txt') -Raw).Trim() -eq $id)
  $protectedProgram=Join-Path $data 'Program'
  New-Item -ItemType Directory -Path $protectedProgram | Out-Null
  Check '拒绝安装到用户数据目录的子目录' ((Run $installer "/S /D=$protectedProgram") -eq 1603 -and @(Get-ChildItem -LiteralPath $protectedProgram -Force).Count -eq 0 -and (Test-Path -LiteralPath $exe))
  $occupied=Join-Path $qaRoot '已有文件'
  New-Item -ItemType Directory -Path $occupied | Out-Null
  $marker=Join-Path $occupied 'keep.txt'
  Set-Content -LiteralPath $marker -Value $id -Encoding utf8
  Check '拒绝占用含其他文件的目录' ((Run $installer "/S /D=$occupied") -ne 0 -and (Get-Content -LiteralPath $marker -Raw).Trim() -eq $id)
  Check '升级可更换程序目录' ((Run $installer "/S /D=$newProgram") -eq 0)
  $newExe=Join-Path $newProgram "$product.exe"
  $entry=@(Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' | Get-ItemProperty | Where-Object {$_.DisplayName -like "$product*"})
  Check '换目录后程序和注册指向新位置' ((Test-Path -LiteralPath $newExe) -and -not(Test-Path -LiteralPath $exe) -and $entry.Count -eq 1 -and $entry[0].InstallLocation -eq $newProgram.Replace('/','\'))
  Check '换目录后用户数据和应用可用' ((Get-Content (Join-Path $data 'keep-user-data.txt') -Raw).Trim() -eq $id -and (Run $newExe '--smoke') -eq 0)
  Start-Sleep -Milliseconds 800
  $program=$newProgram
  $exe=$newExe
  $uninstaller=Join-Path $program "Uninstall $product.exe"
  Check '默认卸载成功' ((Run $uninstaller '/S') -eq 0)
  $deadline=[DateTime]::UtcNow.AddSeconds(30);while((Test-Path -LiteralPath $exe)-and[DateTime]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 200}
  Check '默认卸载保留数据并移除程序' ((Test-Path -LiteralPath (Join-Path $data 'keep-user-data.txt')) -and -not(Test-Path -LiteralPath $exe))
  Check '可重新安装' ((Run $installer "/S /D=$program") -eq 0)
  Check '彻底清理只删除隔离数据' ((Run $uninstaller '/S /PURGEDATA') -eq 0)
  $deadline=[DateTime]::UtcNow.AddSeconds(30);while((Test-Path -LiteralPath $data)-and[DateTime]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 200}
  Check '配置目录与 QA 快捷方式已清除' (-not(Test-Path -LiteralPath $data) -and -not(Test-Path -LiteralPath (Join-Path ([Environment]::GetFolderPath('Desktop')) "$product.lnk")))
  Check '正式安装注册保持原样' ((Formal-Snapshot) -eq $before)
  $afterShared=if(Test-Path -LiteralPath $sharedCache){(Get-FileHash -LiteralPath $sharedCache -Algorithm SHA256).Hash}else{''}
  Check '共享安装缓存未被验收修改' ($afterShared -eq $sharedHash)
  $result.packageSha256=$packageSha256
}catch{
  $result.error=$_.Exception.Message
}finally{
  if($owned){
    # 更换安装目录中途失败时，程序可能位于原目录或新目录。
    $cleanupWarnings=[System.Collections.Generic.List[string]]::new()
    $installDirs=@((Join-Path $qaRoot '中文 Space/程序'),$newProgram) |
      ForEach-Object { [IO.Path]::GetFullPath($_) }
    $qaExecutables=@($installDirs | ForEach-Object { Join-Path $_ "$product.exe" })
    try{
      Close-QaApp $qaExecutables
      if($child -and -not $child.HasExited){
        if(-not $child.WaitForExit(180000)){throw '隔离更新助手尚未结束'}
        # 关闭旧窗口可能让更新助手完成交接并重启 QA 应用。
        Close-QaApp $qaExecutables
      }
      if($timedOutProcess -and -not $timedOutProcess.HasExited){throw '隔离安装程序尚未结束'}
      if(Test-Path -LiteralPath $uninstallKey){
        $installed=(Get-ItemProperty -LiteralPath $uninstallKey).InstallLocation
        if($installed -notin $installDirs){throw 'QA 注册项的安装位置超出本次验收目录'}
        $qaUninstaller=Join-Path $installed "Uninstall $product.exe"
        if(Test-Path -LiteralPath $qaUninstaller){
          try{
            # _?= 让 NSIS 在当前进程中执行卸载，可等待实际完成。
            $code=Run $qaUninstaller "/S _?=$installed"
            if($code -ne 0){$cleanupWarnings.Add("隔离卸载退出码 $code")}
          }catch{
            if($timedOutProcess -and -not $timedOutProcess.HasExited){throw}
            $cleanupWarnings.Add($_.Exception.Message)
          }
        }
      }
      # 只清理由本轮 GUID 和产品名确定的注册项及快捷方式。
      foreach($key in @($uninstallKey,$installKey,"HKCU:\$locationKey")){
        if(Test-Path -LiteralPath $key){Remove-Item -LiteralPath $key}
      }
      foreach($shortcut in $shortcuts){
        if(Test-Path -LiteralPath $shortcut){Remove-Item -LiteralPath $shortcut}
      }
      Check '本轮 QA 注册项和快捷方式已清除' (-not (@($uninstallKey,$installKey,"HKCU:\$locationKey") + $shortcuts | Where-Object { Test-Path -LiteralPath $_ }))
      Check '收尾后正式安装注册保持原样' ((Formal-Snapshot) -eq $before)
    }catch{$result.cleanupError=$_.Exception.Message}
    try{
      # 报告只保留诊断所需的日志尾部，构建副本和安装包随验收目录清理。
      $result.logs=@{}
      foreach($relative in @('build.log','old-app.stderr.log','中文 数据/DeployCenter/logs/installer/last-install.log','中文 数据/DeployCenter/logs/update/update-install.log')){
        $logFile=Join-Path $qaRoot $relative
        if(Test-Path -LiteralPath $logFile -PathType Leaf){$result.logs[$relative]=@(Get-Content -LiteralPath $logFile -Tail 40)}
      }
      if($cleanupWarnings.Count){$result.cleanupWarnings=$cleanupWarnings.ToArray()}
      if(!$result.cleanupError){
        $directory=Get-Item -LiteralPath $qaRoot -Force
        $parentDirectory=Get-Item -LiteralPath $testRoot -Force
        if($directory.Parent.FullName -ne $parentDirectory.FullName -or $directory.Name -cne "installer-qa-$id" -or
          (($directory.Attributes -bor $parentDirectory.Attributes) -band [IO.FileAttributes]::ReparsePoint) -or
          (Get-ChildItem -LiteralPath $qaRoot -Force -Recurse -Attributes ReparsePoint | Select-Object -First 1)){
          throw '本轮 QA 目录越界或包含链接，已保留现场'
        }
        Remove-Item -LiteralPath $qaRoot -Recurse -Force
        Check '本轮 QA 临时目录已清除' (-not(Test-Path -LiteralPath $qaRoot))
      }
    }catch{
      $result.cleanupError=(@($result.cleanupError,$_.Exception.Message) | Where-Object { $_ }) -join '；'
    }
  }
  foreach($entry in $previousEnvironment.GetEnumerator()){
    if($null -eq $entry.Value){Remove-Item -LiteralPath "Env:$($entry.Key)" -ErrorAction SilentlyContinue}
    else{[Environment]::SetEnvironmentVariable($entry.Key,$entry.Value,'Process')}
  }
  $result.ok=-not($result.error -or $result.cleanupError)
  New-Item -ItemType Directory -Path (Split-Path -Parent $report) -Force | Out-Null
  $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $report -Encoding utf8
}
if(!$result.ok){throw ((@($result.error,$result.cleanupError) | Where-Object { $_ }) -join '；')}
