import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { plainPath } from './managed-path';

const encoded = (value: string) => Buffer.from(value, 'utf8').toString('base64');
/** 运行副本放在用户数据目录，安装程序可替换资源目录里的原件。 */
async function runtimeHelper(source: string, directory: string) {
  const contents = await fs.readFile(source);
  const digest = createHash('sha256').update(contents).digest('hex');
  const target = plainPath(path.join(directory, 'update-handoff-' + digest + '.exe'));
  await fs.mkdir(directory, { recursive: true });
  try {
    await fs.writeFile(target, contents, { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  if (!(await fs.readFile(plainPath(target))).equals(contents))
    throw new Error('更新助手运行副本校验失败，请检查数据目录');
  return target;
}
/** 路径作为编码参数传给独立助手，不经过命令行解释器。 */
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
/** 助手获得当前进程句柄并确认就绪后，应用才可以正常退出。 */
export async function launchInstallerAfterExit(
  file: string,
  hash: string,
  installDir: string,
  settings: string,
  helper: string,
  runtime: string,
  silent?: { version: string; executable: string },
) {
  plainPath(settings);
  await fs.mkdir(settings, { recursive: true });
  const log = path.join(settings, 'update-install.log');
  await fs.appendFile(log, new Date().toISOString() + ' 准备启动更新安装\n', 'utf8');
  const args = installerArguments(file, hash, installDir, log, process.pid);
  if (silent) args.push(silent.version, encoded(silent.executable));
  const executable = await runtimeHelper(helper, runtime);
  await new Promise<void>((resolve, reject) => {
    // 独立 .NET 助手可在无控制台时执行，detached 防止应用退出时结束助手。
    const child = spawn(executable, args, {
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
