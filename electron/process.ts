import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import iconv from 'iconv-lite';

export type ProcessOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeout?: number;
  onData?: (text: string) => void;
  encoding?: 'auto' | 'utf8' | 'gb18030';
  maxOutput?: number;
};
export type ProcessResult = {
  code: number;
  stdout: string;
  stderr: string;
  successMarker: boolean;
};
export const stripAnsi = (s: string) => s.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
export function splitArguments(text: string): string[] {
  const args: string[] = [];
  let value = '',
    quote = '',
    started = false;
  for (const char of text) {
    if (char === '\0' || char === '\r' || char === '\n')
      throw new Error('构建参数不能包含换行或 NUL');
    if (quote) {
      if (char === quote) quote = '';
      else value += char;
      started = true;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) {
        args.push(value);
        value = '';
        started = false;
      }
    } else {
      value += char;
      started = true;
    }
  }
  if (quote) throw new Error('构建参数中的引号未闭合');
  if (started) args.push(value);
  return args;
}
function stopOwnedProcess(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.on('error', () => child.kill());
  } else child.kill('SIGTERM');
}
export function runProcess(
  file: string,
  args: string[],
  opts: ProcessOptions = {},
): Promise<ProcessResult> {
  if (opts.signal?.aborted) return Promise.reject(new Error('操作已取消'));
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: opts.env || process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    let out = '',
      err = '',
      marker = false,
      killed = '',
      carries = new Map<string, string>(),
      settled = false;
    const decoders = new Map<string, ReturnType<typeof iconv.getDecoder>>();
    const undecided = new Map<string, Buffer>();
    const add = (kind: 'stdout' | 'stderr', data: Buffer, final = false) => {
      let text = '';
      if (!decoders.has(kind)) {
        let encoding = opts.encoding || 'auto';
        const pending = Buffer.concat([undecided.get(kind) || Buffer.alloc(0), data]);
        if (encoding === 'auto' && !final && pending.every((byte) => byte < 128))
          text = pending.toString('ascii');
        else {
          if (encoding === 'auto') {
            // Maven 常先打印 ASCII 横幅；直到非 ASCII 行出现才判断 UTF-8 或 GBK。
            if (!final && !pending.includes(10) && pending.length < 4096) {
              undecided.set(kind, pending);
              return;
            }
            try {
              new TextDecoder('utf8', { fatal: true }).decode(pending, { stream: !final });
              encoding = 'utf8';
            } catch {
              encoding = 'gb18030';
            }
          }
          decoders.set(kind, iconv.getDecoder(encoding));
          undecided.delete(kind);
          text = decoders.get(kind)!.write(pending);
        }
      } else text = decoders.get(kind)!.write(data);
      if (final) text += decoders.get(kind)?.end() || '';
      text = stripAnsi(text);
      const carry = carries.get(kind) || '';
      marker ||= (carry + text).includes('BUILD SUCCESS');
      carries.set(kind, (carry + text).slice(-100));
      if (kind === 'stdout') out = (out + text).slice(-(opts.maxOutput || 1024 * 1024));
      else err = (err + text).slice(-(opts.maxOutput || 1024 * 1024));
      if (text) opts.onData?.(text);
    };
    child.stdout!.on('data', (data) => add('stdout', data));
    child.stderr!.on('data', (data) => add('stderr', data));
    const abort = () => {
      killed = '操作已取消';
      stopOwnedProcess(child);
    };
    const timer = setTimeout(() => {
      killed = `命令执行超时（${Math.round((opts.timeout || 1800000) / 1000)} 秒）`;
      stopOwnedProcess(child);
    }, opts.timeout || 1800000);
    opts.signal?.addEventListener('abort', abort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', abort);
    };
    child.once('error', (error) => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error(`无法启动 ${file}：${error.message}`));
      }
    });
    child.once('close', (code) => {
      if (!settled) {
        settled = true;
        cleanup();
        add('stdout', Buffer.alloc(0), true);
        add('stderr', Buffer.alloc(0), true);
        killed
          ? reject(new Error(killed))
          : resolve({ code: code ?? -1, stdout: out, stderr: err, successMarker: marker });
      }
    });
  });
}
/** 不使用 call，避免批处理的二次展开；所有 Maven 参数作为一个加引号的参数传入。 */
export async function runBatch(
  file: string,
  args: string[],
  tempRoot: string,
  opts: ProcessOptions = {},
) {
  if (process.platform !== 'win32' || !/\.(cmd|bat)$/i.test(file))
    return runProcess(file, args, opts);
  const check = (s: string) => {
    if (/["\r\n\0]/.test(s)) throw new Error('批处理参数不支持嵌入双引号或换行，请调整构建参数');
  };
  [file, ...args].forEach(check);
  const dir = await mkdtemp(path.join(tempRoot, 'build-command-'));
  const script = path.join(dir, 'launch.cmd');
  // 输入经 Unicode 环境变量进入 cmd，不把中文路径或口令写入批处理，也不二次展开百分号。
  const env = {
    ...(opts.env || process.env),
    DEPLOY_CENTER_CWD: opts.cwd || process.cwd(),
    DEPLOY_CENTER_TOOL: file,
  };
  args.forEach((arg, i) => ((env as Record<string, string>)[`DEPLOY_CENTER_ARG_${i}`] = arg));
  await writeFile(
    script,
    '@echo off\r\nsetlocal DisableDelayedExpansion\r\ncd /d "%DEPLOY_CENTER_CWD%" || exit /b 1\r\n"%DEPLOY_CENTER_TOOL%" ' +
      args.map((_, i) => `"%DEPLOY_CENTER_ARG_${i}%"`).join(' ') +
      '\r\n',
    'ascii',
  );
  try {
    return await runProcess(
      process.env.ComSpec || 'cmd.exe',
      ['/d', '/v:off', '/c', 'launch.cmd'],
      { ...opts, env, cwd: dir },
    );
  } finally {
    const absolute = path.resolve(dir);
    if (absolute.startsWith(path.resolve(tempRoot) + path.sep))
      await rm(absolute, { recursive: true, force: true });
  }
}
