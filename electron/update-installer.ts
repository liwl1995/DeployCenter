import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import { plainPath } from './managed-path';

const encoded = (value: string) => Buffer.from(value, 'utf8').toString('base64');
/** 路径作为编码参数传给独立助手，不经过 shell；助手再次校验指纹后启动向导。 */
export function installerArguments(
  file: string,
  hash: string,
  installDir: string,
  log: string,
  pid: number,
) {
  if (!/^[a-f0-9]{64}$/.test(hash) || !Number.isSafeInteger(pid) || pid <= 0)
    throw new Error('安装参数无效');
  return [String(pid), encoded(file), hash, encoded(installDir), encoded(log)];
}
/** 助手握住当前进程句柄并确认就绪后，应用才可以退出；不杀进程、不静默安装。 */
export async function launchInstallerAfterExit(
  file: string,
  hash: string,
  installDir: string,
  settings: string,
  helper: string,
) {
  plainPath(settings);
  await fs.mkdir(settings, { recursive: true });
  const log = path.join(settings, 'update-install.log');
  await fs.appendFile(log, new Date().toISOString() + ' 准备启动更新安装向导\n', 'utf8');
  const args = installerArguments(file, hash, installDir, log, process.pid);
  await new Promise<void>((resolve, reject) => {
    // 独立 .NET 助手可在无控制台时执行，detached 防止应用退出时结束助手。
    const child = spawn(helper, args, {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '',
      errors = '',
      done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      child.stdout.destroy();
      child.stderr.destroy();
      if (error) {
        child.kill();
        void fs
          .appendFile(
            log,
            new Date().toISOString() + ' ' + error.message + (errors ? '\n' + errors : '') + '\n',
            'utf8',
          )
          .catch(() => {})
          .finally(() => reject(error));
      } else {
        child.unref();
        resolve();
      }
    };
    const timeout = setTimeout(
      () => finish(new Error('更新助手未能就绪，应用保持运行，请重试')),
      15000,
    );
    child.once('error', (error) =>
      finish(new Error('无法启动系统更新助手，应用保持运行：' + error.message)),
    );
    child.once('exit', (code, signal) =>
      finish(
        new Error(
          '更新助手提前退出（' +
            (signal || '退出码 ' + code) +
            '），应用保持运行，请查看更新安装日志',
        ),
      ),
    );
    child.stdout.on('data', (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-1000);
      if (output.includes('UPDATE_READY')) finish();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      errors = (errors + chunk.toString('utf8')).slice(-4000);
    });
  });
}
