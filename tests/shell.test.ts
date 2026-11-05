// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { seed, shellQuote as q, type Target } from '../src/model';
import { createTask } from '../src/engine';
import { launchRunner, preflightScript, remotePaths, runnerScript } from '../electron/remote';
import {
  cleanWorkbench,
  verifyWorkbench,
  workbenchHeader,
  type FinalState,
} from '../electron/workbench';
import {
  archiveLegacyWorkbench,
  canDiscard,
  discardWorkbench,
  inspectWorkbench,
} from '../electron/workbench-inspection';
import { memoryChannel, type Transport } from '../electron/ssh';
import { Storage } from '../electron/storage';
import { WorkbenchRecovery } from '../electron/workbench-recovery';

const distro = process.env.DEPLOY_CENTER_TEST_WSL;
const available = process.platform !== 'win32' || !!distro;
const bash =
  process.platform === 'win32' ? 'wsl.exe' : process.env.DEPLOY_CENTER_TEST_BASH || '/bin/bash';
const args = process.platform === 'win32' ? ['-d', distro || '', '--', '/bin/bash', '-s'] : ['-s'];

function shell(script: string) {
  return new Promise<{ code: number; stdout: string; stderr: string; bytes: Buffer }>(
    (resolve, reject) => {
      const child = spawn(bash, args, { windowsHide: true });
      const out: Buffer[] = [],
        err: Buffer[] = [];
      let size = 0;
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('隔离 Linux 测试命令超时'));
      }, 60000);
      const read = (output: Buffer[]) => (chunk: Buffer) => {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) {
          child.kill();
          reject(new Error('隔离测试输出超过限制'));
        } else output.push(chunk);
      };
      child.stdout.on('data', read(out));
      child.stderr.on('data', read(err));
      child.stdin.on('error', () => {});
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        const bytes = Buffer.concat(out);
        resolve({
          code: code ?? 1,
          stdout: bytes.toString('utf8'),
          stderr: Buffer.concat(err).toString('utf8'),
          bytes,
        });
      });
      child.stdin.end(script);
    },
  );
}
async function run(script: string) {
  const result = await shell(script);
  if (result.code) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}
function session(prefix = ''): Transport {
  return {
    async connect() {},
    async channel() {
      return memoryChannel();
    },
    async exec(command, options) {
      return shell(prefix + (options?.input ?? command));
    },
    async upload() {
      throw new Error('脚本验收不使用网络上传');
    },
    async read(file, offset, limit = 262144) {
      const f = q(file);
      const result = await shell(
        'if [ -f ' +
          f +
          ' ] && [ ! -L ' +
          f +
          ' ]; then tail -c +' +
          (offset + 1) +
          ' -- ' +
          f +
          ' | head -c ' +
          limit +
          '; fi',
      );
      if (result.code) throw new Error(result.stderr);
      return result.bytes;
    },
    close() {},
  };
}
async function fixture<T>(callback: (directory: string) => Promise<T>) {
  const dir = await run('mktemp -d /tmp/deploy-center-workbench.XXXXXXXX');
  if (!/^\/tmp\/deploy-center-workbench\.[A-Za-z0-9]+$/.test(dir)) throw new Error('测试目录越界');
  try {
    return await callback(dir);
  } finally {
    await run('rm -rf -- ' + q(dir));
  }
}

type Case = {
  first?: boolean;
  fail?: boolean;
  backup?: boolean;
  docker?: boolean;
  badHash?: boolean;
  cancel?: boolean;
  mount?: 'file' | 'directory';
  extra?: boolean;
  foreign?: boolean;
};
const fakeDocker = [
  '#!/bin/bash',
  'case "$1" in',
  '  inspect) if [ "$2" = -f ]; then case "$3" in',
  '    *Running*) printf true;; *RestartCount*) printf 0;; *Health*) printf none;; *Id*) printf container-id;;',
  '  esac; else printf "[]"; fi;;',
  '  stop|start) printf "%s" "$1" >> commands.log;;',
  '  exec) if [ -f bad-hash ]; then printf "bad-hash  file\\n"; else sha256sum -- service.jar; fi;;',
  '  logs) sleep .1; printf "最后一行容器日志\\n";;',
  '  *) exit 1;;',
  'esac',
].join('\n');
function setFile(file: string, value: string) {
  return 'printf "%s" ' + q(value) + ' > ' + q(file) + '\n';
}
function makeRun(directory: string, options: Case = {}) {
  const db = seed();
  const target: Target = {
    ...db.targets[3],
    directory,
    fileName: 'service.jar',
    hasOldJar: !options.first,
    mode: options.docker ? 'docker' : 'jar',
    start: 'if grep -q fail service.jar; then exit 1; fi; printf started >> commands.log',
    stop: 'printf stopped >> commands.log',
    health: { type: 'none', value: '', timeout: 1, retries: 1, interval: 1 },
    backup: { ...db.targets[3].backup, enabled: options.backup !== false },
    stabilitySeconds: 1,
  };
  if (options.docker) {
    target.container = 'test-container';
    target.containerJar = '/app/service.jar';
    target.mount = options.mount || 'directory';
    target.stop = '';
    target.start = '';
  }
  const task = createTask(db, db.services[1], [target], {}, 'existing');
  const r = task.targets[0];
  r.remote = remotePaths(task, r);
  const next = options.fail ? 'fail fixture' : 'new fixture';
  task.deployedCommit = 'a'.repeat(40);
  task.service.git.branch = 'fixture-deploy';
  task.artifact.size = Buffer.byteLength(next);
  task.artifact.sha256 = createHash('sha256').update(next).digest('hex');
  const docker = options.docker
    ? {
        id: 'container-id',
        running: true,
        restarts: 0,
        mount: target.mount,
        containerJar: target.containerJar,
      }
    : undefined;
  return { task, r, target, docker, next, owner: task.id + '-' + target.id };
}

describe.skipIf(!available)('隔离 Linux Bash 执行远程部署和收尾（Docker 使用本地命令夹具）', () => {
  async function scenario(options: Case = {}) {
    return fixture(async (dir) => {
      const { task, r, target, docker, next, owner } = makeRun(dir, options);
      const job = r.remote!.jobDir;
      const prefix = 'export PATH=' + q(dir) + ':$PATH\n';
      const checked = await shell(
        'set -e\n' +
          prefix +
          setFile(dir + '/docker', fakeDocker) +
          'chmod +x -- ' +
          q(dir + '/docker') +
          '\n' +
          (options.badHash ? setFile(dir + '/bad-hash', '1') : '') +
          (!options.first ? setFile(dir + '/service.jar', 'old fixture') : '') +
          preflightScript(task, r, false, docker),
      );
      expect(checked.code, checked.stderr).toBe(0);
      const result = await shell(
        'set -e\n' +
          prefix +
          setFile(r.remote!.stagePath, next) +
          (options.cancel ? setFile(job + '/cancel', '1') : '') +
          setFile(job + '/runner.sh', runnerScript(task, r, false, docker)) +
          launchRunner(r, owner) +
          '\nwait "$!"\n',
      );
      expect(result.code, result.stderr).toBe(0);
      const transport = session(prefix);
      const state = (await run('cat -- ' + q(job + '/state'))) as FinalState;
      expect(await run('test -d ' + q(r.remote!.lockDir) + ' && printf YES')).toBe('YES');
      const files: Record<string, string> = {};
      const receipt = await verifyWorkbench(transport, r, owner, state, (name, bytes) => {
        files[name] = (files[name] || '') + bytes.toString();
      });
      const contents = await run('cat -- ' + q(dir + '/service.jar'));
      const commands = await run('cat -- ' + q(dir + '/commands.log') + ' 2>/dev/null || true');
      if (options.extra) {
        await run(
          setFile(dir + '/keep', '外部文件') +
            'ln -s -- ' +
            q(dir + '/keep') +
            ' ' +
            q(job + '/unknown-link'),
        );
        await expect(cleanWorkbench(transport, target, receipt)).rejects.toThrow('unknown-link');
        expect(await run('cat -- ' + q(dir + '/keep'))).toBe('外部文件');
        expect(await run('cat -- ' + q(job + '/state'))).toBe(state);
        await run('rm -- ' + q(job + '/unknown-link'));
      }
      if (options.foreign) {
        const base = path.resolve('.test-data');
        await fs.mkdir(base, { recursive: true });
        const data = await fs.mkdtemp(path.join(base, 'workbench-foreign-'));
        const crypto = {
          encrypt: async (value: string) => Buffer.from(value),
          decrypt: async (value: Buffer) => value.toString(),
        };
        let storage = new Storage(data, crypto);
        try {
          const db = seed();
          db.history = [];
          db.taskHistory = {};
          db.targets = [{ ...target, version: '本机原版本' }];
          storage.saveConfig(db);
          const exec = transport.exec.bind(transport);
          let disconnected = true;
          transport.exec = async (command, options) => {
            if (disconnected && options?.input?.includes('printf CLEANED'))
              throw new Error('连接在清理前断开');
            return exec(command, options);
          };
          let recovery = new WorkbenchRecovery(
            storage,
            () => transport,
            () => true,
          );
          const review = await recovery.inspect(target.id, '');
          expect(review.action).toBe('import');
          expect(review.owner).toBe(owner);
          await expect(recovery.resolve(review.token, '错误环境')).rejects.toThrow('完整环境名称');
          await expect(recovery.resolve(review.token, target.name)).resolves.toContain('待清理');
          expect(storage.database().targets[0].version).toBe('本机原版本');
          expect(storage.database().history[0]).toMatchObject({
            status: 'failed',
            cleanupWarning: expect.any(String),
            service: { git: { branch: 'fixture-deploy', commit: 'a'.repeat(40) } },
          });
          expect(
            await fs.readFile(
              storage.logPath(storage.database().history[0].taskId, target.id),
              'utf8',
            ),
          ).toContain('最后一行容器日志');
          expect(await run('cat -- ' + q(job + '/state'))).toBe(state);
          storage.close();
          storage = new Storage(data, crypto);
          disconnected = false;
          recovery = new WorkbenchRecovery(
            storage,
            () => transport,
            () => true,
          );
          const pending = await recovery.inspect(target.id, '');
          expect(pending.action).toBe('cleanup');
          await expect(recovery.resolve(pending.token, target.name)).resolves.toContain('已清理');
          expect(storage.database().history).toHaveLength(1);
          expect(storage.database().history[0].cleanupWarning).toBeUndefined();
        } finally {
          await storage.settle();
          storage.close();
          if (!path.resolve(data).startsWith(base + path.sep)) throw new Error('本机测试目录越界');
          await fs.rm(data, { recursive: true, force: true });
        }
      } else await cleanWorkbench(transport, target, receipt);
      await cleanWorkbench(transport, target, receipt);
      expect(
        await run(
          'test ! -e ' + q(job) + ' && test ! -e ' + q(r.remote!.lockDir) + ' && printf YES',
        ),
      ).toBe('YES');
      return {
        state,
        contents,
        commands,
        journal: files.journal || '',
        output: files['output.log'] || '',
      };
    });
  }
  it('普通 JAR 校验、备份、停服、原子替换；在确认本机保存前保留目标锁', async () => {
    const r = await scenario();
    expect(r.state).toBe('UNVERIFIED');
    expect(r.contents).toBe('new fixture');
    expect(r.commands).toBe('stoppedstarted');
    expect(r.journal).toContain('BACKUP');
  }, 90000);
  it('首次部署跳过备份和停止，不报错', async () => {
    const r = await scenario({ first: true });
    expect(r.state).toBe('UNVERIFIED');
    expect(r.commands).toBe('started');
    expect(r.journal).not.toContain('BACKUP');
  }, 90000);
  it('启动失败后恢复真实备份并重新启动旧服务', async () => {
    const r = await scenario({ fail: true });
    expect(r.state).toBe('ROLLEDBACK');
    expect(r.contents).toBe('old fixture');
    expect(r.journal).toContain('rollback\tOK');
  }, 90000);
  it('无备份失败明确 FAILED，不假装回滚成功', async () => {
    const r = await scenario({ fail: true, backup: false });
    expect(r.state).toBe('FAILED');
    expect(r.contents).toBe('fail fixture');
  }, 90000);
  it('停服前取消不修改旧文件，保留现场直到核对后清理', async () => {
    const r = await scenario({ cancel: true });
    expect(r.state).toBe('CANCELLED');
    expect(r.contents).toBe('old fixture');
    expect(r.commands).toBe('');
  }, 90000);
  it.each(['directory', 'file'] as const)(
    'Docker %s 挂载完成原子替换、容器内哈希和稳定观察',
    async (mount) => {
      const r = await scenario({ docker: true, mount });
      expect(r.state).toBe('UNVERIFIED');
      expect(r.commands).toBe('stopstart');
      expect(r.journal).toContain('containerHash\tOK');
    },
    90000,
  );
  it('Docker 失败收尾的最后一行日志已进入校验；未知链接保持原样', async () => {
    const r = await scenario({ docker: true, badHash: true, extra: true });
    expect(r.state).toBe('ROLLBACK_FAILED');
    expect(r.contents).toBe('old fixture');
    expect(r.output).toContain('最后一行容器日志');
  }, 90000);
  it('另一台电脑补存终态和日志；清理掉线后重启只补清理，不重复写历史', async () => {
    const result = await scenario({ docker: true, badHash: true, foreign: true });
    expect(result.state).toBe('ROLLBACK_FAILED');
  }, 90000);
  it('旧版任务和备份审计只在确认归档后移开，保留原内容', async () => {
    await fixture(async (dir) => {
      const { target, r } = makeRun(dir);
      const transport = session();
      const task = 'DC-OLD-v1-t72';
      const audit = 'DC-CLEAN-00000000-0000-0000-0000-000000000000';
      const job = r.remote!.jobDir;
      await run(
        'mkdir -p -- ' +
          q(job + '/' + task) +
          ' ' +
          q(job + '/' + audit) +
          '\n' +
          setFile(job + '/' + task + '/state', 'SUCCESS') +
          setFile(job + '/' + task + '/output.log', '旧版任务日志') +
          setFile(job + '/' + audit + '/state', 'FINISHED') +
          setFile(job + '/' + audit + '/exit-code', '0'),
      );
      const info = await inspectWorkbench(transport, target);
      expect(info.legacy).toEqual([audit, task]);
      expect(info.unknown).toHaveLength(0);
      const archive = await archiveLegacyWorkbench(
        transport,
        target,
        'DC-ARCHIVE-test',
        info.legacy,
      );
      expect(await run('cat -- ' + q(archive + '/' + task + '/output.log'))).toBe('旧版任务日志');
      expect(await run('cat -- ' + q(archive + '/' + audit + '/exit-code'))).toBe('0');
      expect(await run('test ! -e ' + q(job) + ' && printf YES')).toBe('YES');
    });
  }, 90000);
  it('工作台已清理但在释放旧锁时掉线，只补清理旧锁，不干扰新锁', async () => {
    await fixture(async (dir) => {
      const { task, r, target, owner } = makeRun(dir, { first: true });
      const transport = session();
      await run(preflightScript(task, r, false));
      await run(workbenchHeader(target, owner) + 'printf CANCELLED > "$JOB/state"');
      const receipt = await verifyWorkbench(transport, r, owner, 'CANCELLED', () => {});
      await run(
        workbenchHeader(target, owner) +
          [
            'printf "%s" "$OWNER" > "$LOCK/cleanup"',
            'dc_remove_files; rmdir -- "$JOB"',
            'mv -T -- "$LOCK" "$LOCK.released.$OWNER"',
          ].join('\n'),
      );
      const freshOwner = 'DC-NEW-fixture';
      await run(workbenchHeader(target, freshOwner) + 'dc_acquire');
      await cleanWorkbench(transport, target, receipt);
      expect(await run('cat -- ' + q(r.remote!.lockDir + '/owner'))).toBe(freshOwner);
      expect(
        await run('test ! -e ' + q(r.remote!.lockDir + '.released.' + owner) + ' && printf YES'),
      ).toBe('YES');
    });
  }, 90000);
  it('没有目标锁仍拒绝覆盖旧工作台；PID 复用不视为原进程仍在运行', async () => {
    await fixture(async (dir) => {
      const { task, r, target, owner } = makeRun(dir);
      const job = r.remote!.jobDir;
      const transport = session();
      await run(preflightScript(task, r, false));
      await run(
        'rm -- ' +
          q(r.remote!.lockDir + '/owner') +
          ' ' +
          q(r.remote!.lockDir + '/created') +
          '; rmdir -- ' +
          q(r.remote!.lockDir),
      );
      const attempt = await shell(preflightScript(task, r, false));
      expect(attempt.code).not.toBe(0);
      expect(attempt.stderr).toContain('先核实上一任务');
      expect(await run('head -n 1 -- ' + q(job + '/task'))).toBe(owner);
      await run(
        workbenchHeader(target, owner) +
          'dc_acquire\nprintf 1 > "$LOCK/created"\nprintf RUNNING > "$JOB/state"\n' +
          'printf "1 0 %s\\n" "$(cat /proc/sys/kernel/random/boot_id)" > "$JOB/pid"',
      );
      const inspection = await inspectWorkbench(transport, target);
      expect(inspection.process).toBe('1');
      expect(canDiscard(inspection, 1)).toBe(true);
      await discardWorkbench(transport, target, inspection, 1);
      expect(await run('test ! -e ' + q(job) + ' && printf YES')).toBe('YES');
    });
  }, 90000);
});
