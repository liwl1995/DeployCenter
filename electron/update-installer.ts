import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';

const encoded = (value: string) => Buffer.from(value, 'utf8').toString('base64');
/** 独立助手先握住当前进程句柄，确认就绪后应用才退出；不杀进程、不静默安装。 */
export function installerScript(
  file: string,
  hash: string,
  installDir: string,
  log: string,
  pid: number,
) {
  if (!/^[a-f0-9]{64}$/.test(hash) || !Number.isSafeInteger(pid) || pid <= 0)
    throw new Error('安装参数无效');
  return `
$ErrorActionPreference = 'Stop'
$decode = { param($value) [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($value)) }
$file = & $decode '${encoded(file)}'
$directory = & $decode '${encoded(installDir)}'
$log = & $decode '${encoded(log)}'
try {
  $parent = [Diagnostics.Process]::GetProcessById(${pid})
  $null = $parent.Handle
  [Console]::Out.WriteLine('UPDATE_READY')
  [Console]::Out.Flush()
  $parent.WaitForExit()
  # Electron 主进程退出后，等待同名子进程自然结束，避免安装器误判仍在运行。
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  do {
    $running = [Diagnostics.Process]::GetProcessesByName('YOTOO 部署中心')
    $legacy = [Diagnostics.Process]::GetProcessesByName('Deploy Center')
    $busy = $running.Length -gt 0 -or $legacy.Length -gt 0
    foreach ($process in ($running + $legacy)) { $process.Dispose() }
    if (-not $busy) { break }
    if ([DateTime]::UtcNow -ge $deadline) { throw '应用仍有进程运行，请关闭其他窗口后重试' }
    [Threading.Thread]::Sleep(250)
  } while ($true)
  if (([IO.File]::GetAttributes($file) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw '安装包不能是链接' }
  $stream = [IO.File]::OpenRead($file)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $actual = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
  finally { $stream.Dispose(); $sha.Dispose() }
  if ($actual -ne '${hash}') { throw '安装包校验失败' }
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $file
  $start.WorkingDirectory = [IO.Path]::GetDirectoryName($file)
  $start.UseShellExecute = $true
  $start.Arguments = '/D=' + $directory
  $null = [Diagnostics.Process]::Start($start)
} catch {
  [IO.File]::AppendAllText($log, [DateTime]::Now.ToString('s') + ' 更新安装未启动：' + $_.Exception.Message + [Environment]::NewLine, [Text.Encoding]::UTF8)
  $null = [Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms')
  [System.Windows.Forms.MessageBox]::Show('无法启动更新安装，请重新打开 YOTOO 部署中心并重试。' + [Environment]::NewLine + $_.Exception.Message, 'YOTOO 部署中心 更新失败') | Out-Null
  exit 1
}
`;
}
export async function launchInstallerAfterExit(
  file: string,
  hash: string,
  installDir: string,
  settings: string,
) {
  const log = path.join(settings, 'update-install.log');
  await fs.appendFile(log, new Date().toISOString() + ' 准备启动更新安装向导\n', 'utf8');
  const script = installerScript(file, hash, installDir, log, process.pid);
  const exe = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      exe,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      { detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '',
      done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      child.stdout.destroy();
      child.stderr.destroy();
      if (error) {
        child.kill();
        reject(error);
      } else {
        child.unref();
        resolve();
      }
    };
    const timeout = setTimeout(
      () => finish(new Error('更新助手未能就绪，应用保持运行，请重试')),
      15000,
    );
    child.once('error', () => finish(new Error('无法启动系统更新助手，应用保持运行')));
    child.once('exit', () => finish(new Error('更新助手提前退出，应用保持运行')));
    child.stdout.on('data', (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-1000);
      if (output.includes('UPDATE_READY')) finish();
    });
    child.stderr.on('data', () => {});
  });
}
