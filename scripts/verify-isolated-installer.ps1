# 仅安装独立 QA 身份；注册表、快捷方式、程序目录和用户数据均与正式版本隔离。
param([string]$Prepackaged)
$ErrorActionPreference='Stop'
$repoRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$version=(Get-Content (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json).version
$id=[guid]::NewGuid().ToString()
$qaRoot=Join-Path $repoRoot ".test-data/installer-qa-$id"
$program=Join-Path $qaRoot '中文 Space/程序'
$data=Join-Path $qaRoot '中文 数据/DeployCenter'
$build=Join-Path $qaRoot 'build'
$locationKey="Software\YOTOO\DeployCenter.Tests\$id"
$product="YOTOO DeployCenter QA $($id.Substring(0,8))"
$qaPackage="deploy-center-qa-$id"
$sharedCache=Join-Path $env:LOCALAPPDATA 'deploy-center-updater/installer.exe'
$sharedHash=if(Test-Path -LiteralPath $sharedCache){(Get-FileHash -LiteralPath $sharedCache -Algorithm SHA256).Hash}else{''}
$appId="local.deploycenter.desktop.qa.$id"
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
function Run([string]$File,[string]$Arguments){$p=Start-Process -FilePath $File -ArgumentList $Arguments -PassThru -WindowStyle Hidden;if(-not $p.WaitForExit(180000)){throw '隔离安装程序未正常退出'};return $p.ExitCode}
function Formal-Snapshot {
  $key='HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\331cf176-7a71-5b12-9fb9-5cf75e4f46af'
  if(Test-Path -LiteralPath $key){return (Get-ItemProperty -LiteralPath $key | Select-Object DisplayName,DisplayVersion,InstallLocation,UninstallString | ConvertTo-Json -Compress)}
  return ''
}
$before=Formal-Snapshot
try{
  if(-not $qaRoot.StartsWith((Join-Path $repoRoot '.test-data')+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'QA 路径越界'}
  New-Item -ItemType Directory -Path $qaRoot,$data,$build -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $data '.yotoo-data-owner.ini') -Value "[application]`r`nid=local.deploycenter.desktop`r`n" -Encoding utf8
  Set-Content -LiteralPath (Join-Path $data 'keep-user-data.txt') -Value $id -Encoding utf8
  $wrapper=Join-Path $qaRoot 'custom.nsh'
  Set-Content -LiteralPath $wrapper -Value "!define YOTOO_LOCATION_KEY `"$locationKey`"`r`n!include `"$repoRoot\installer\custom.nsh`"" -Encoding utf8
  New-Item -Path "HKCU:\$locationKey" -Force | Out-Null
  Set-ItemProperty -LiteralPath "HKCU:\$locationKey" -Name DataDirectory -Value $data
  $builderArgs=@("--config.extraMetadata.name=$qaPackage",'--win','nsis','--x64',"--config.appId=$appId","--config.productName=$product","--config.nsis.shortcutName=$product","--config.nsis.include=$wrapper","--config.directories.output=$build",'--config.win.artifactName=QA-Setup.exe','--publish','never')
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
  Check '中文路径实际安装' ((Run $installer "/S /D=$program") -eq 0)
  $exe=Join-Path $program "$product.exe"
  $packageSha256=(Get-FileHash -LiteralPath (Join-Path $program 'resources/app.asar')).Hash
  Check '安装主程序存在' (Test-Path -LiteralPath $exe)
  Check '框架不再产生额外用户目录缓存' (-not(Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA "$qaPackage-updater/installer.exe")))
  Check '安装日志在配置目录' (Test-Path -LiteralPath (Join-Path $data 'logs/installer/last-install.log'))
  $entry=@(Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' | Get-ItemProperty | Where-Object {$_.DisplayName -like "$product*"})
  Check '独立应用注册项' ($entry.Count -eq 1 -and $entry[0].DisplayVersion -eq $version)
  Check '开始菜单和桌面独立快捷方式' ((Test-Path -LiteralPath (Join-Path ([Environment]::GetFolderPath('Programs')) "$product.lnk")) -and (Test-Path -LiteralPath (Join-Path ([Environment]::GetFolderPath('Desktop')) "$product.lnk")))
  Check '已安装程序实际启动与 SQLite 加密渲染' ((Run $exe '--smoke') -eq 0 -and (Get-Content (Join-Path $data 'smoke-result.json') -Raw | ConvertFrom-Json).ok)
  Start-Sleep -Milliseconds 800
  Check '覆盖升级保留用户数据' ((Run $installer '/S') -eq 0 -and (Get-Content (Join-Path $data 'keep-user-data.txt') -Raw).Trim() -eq $id)
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
  @{ok=$true;version=$version;packageSha256=$packageSha256;namespace=$appId;locationKey=$locationKey;root=$qaRoot;checks=$checks} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $report -Encoding utf8
}catch{
  @{ok=$false;version=$version;error=$_.Exception.Message;root=$qaRoot;checks=$checks} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $report -Encoding utf8
  throw
}finally{
  if($locationKey -match '^Software\\YOTOO\\DeployCenter\.Tests\\[a-f0-9-]{36}$' -and (Test-Path -LiteralPath "HKCU:\$locationKey")){Remove-Item -LiteralPath "HKCU:\$locationKey" -Recurse}
}
