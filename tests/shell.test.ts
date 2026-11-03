// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { seed } from '../src/model';
import { createTask } from '../src/engine';
import { remotePaths, preflightScript, runnerScript } from '../electron/remote';
import { runProcess } from '../electron/process';
const bash = process.env.DEPLOY_CENTER_TEST_BASH || 'E:/dev/git/bin/bash.exe';
const available =
  process.platform !== 'win32' &&
  (await fs.access(bash).then(
    () => true,
    () => false,
  ));
if (!available)
  console.warn(
    '[SKIP] 远端 Bash 流程测试需要可设置 POSIX 权限的 Linux 环境；当前 Windows Git Bash 的 mkdir -m 700 被 ACL 拒绝。未降低生产脚本权限要求。',
  );
const unix = (p: string) =>
  p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive: string) => '/' + drive.toLowerCase());
describe.skipIf(!available)('本机临时目录执行真实 Bash 部署脚本（不使用业务 SSH）', () => {
  async function scenario(
    options: {
      first?: boolean;
      fail?: boolean;
      backup?: boolean;
      docker?: boolean;
      badHash?: boolean;
      cancel?: boolean;
      mount?: 'file' | 'directory';
    } = {},
  ) {
    const base = path.resolve('.test-data');
    await fs.mkdir(base, { recursive: true });
    const dir = await fs.mkdtemp(path.join(base, "shell 中文 space-'"));
    try {
      const db = seed(),
        target = {
          ...db.targets[3],
          directory: unix(dir),
          fileName: 'service.jar',
          hasOldJar: !options.first,
          start: 'if grep -q fail service.jar; then exit 1; fi; printf started >> commands.log',
          stop: 'printf stopped >> commands.log',
          health: { type: 'none' as const, value: '', timeout: 1, retries: 1, interval: 1 },
          stabilitySeconds: 1,
        };
      target.backup = { ...target.backup, enabled: options.backup !== false };
      if (options.docker) {
        target.mode = 'docker';
        target.container = 'test-container';
        target.containerJar = '/app/service.jar';
        target.mount = options.mount || 'directory';
        target.stop = '';
        target.start = '';
      }
      const task = createTask(db, db.services[1], [target], {}, 'existing');
      const r = task.targets[0];
      r.remote = remotePaths(task, r);
      const old = 'old fixture',
        next = options.fail ? 'fail fixture' : 'new fixture';
      task.artifact.size = Buffer.byteLength(next);
      task.artifact.sha256 = createHash('sha256').update(next).digest('hex');
      if (!options.first) await fs.writeFile(path.join(dir, 'service.jar'), old);
      const docker = options.docker
        ? {
            id: 'container-id',
            running: true,
            restarts: 0,
            mount: target.mount,
            containerJar: target.containerJar,
          }
        : undefined;
      const mock = options.docker
        ? `docker(){ case "$1" in inspect) if [ "$2" = -f ]; then case "$3" in *Running*) printf true;; *RestartCount*) printf 0;; *Health*) printf none;; *Id*) printf container-id;; esac; else printf '[]'; fi;; stop|start) printf '%s' "$1" >> "$DIR/commands.log";; exec) ${options.badHash ? "printf 'bad-hash  file\\n'" : 'sha256sum -- "$JAR"'};; logs) printf 'fixture logs\\n';; *) return 1;; esac; }\n`
        : '';
      const run = async (name: string, script: string) => {
        const file = path.join(dir, name + '.sh');
        await fs.writeFile(file, mock + script);
        return runProcess(bash, [unix(file)], {
          timeout: 20000,
          encoding: 'utf8',
          env: { ...process.env, MSYS2_ARG_CONV_EXCL: '*' },
        });
      };
      const checked = await run('preflight', preflightScript(task, r, false, docker));
      expect(checked.code, checked.stderr).toBe(0);
      await fs.writeFile(path.join(dir, path.posix.basename(r.remote.stagePath)), next);
      if (options.cancel)
        await fs.writeFile(
          path.join(dir, '.deploy-center', task.id + '-' + target.id, 'cancel'),
          '1',
        );
      const result = await run('runner', runnerScript(task, r, false, docker));
      expect(result.code, result.stderr).toBe(0);
      const state = await fs.readFile(
          path.join(dir, '.deploy-center', task.id + '-' + target.id, 'state'),
          'utf8',
        ),
        contents = await fs.readFile(path.join(dir, 'service.jar'), 'utf8');
      const commands = await fs.readFile(path.join(dir, 'commands.log'), 'utf8').catch(() => '');
      const journal = await fs
        .readFile(path.join(dir, '.deploy-center', task.id + '-' + target.id, 'journal'), 'utf8')
        .catch(() => '');
      expect(
        await fs.access(path.join(dir, '.deploy-center.lock')).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
      expect(
        await fs.access(path.join(dir, path.posix.basename(r.remote.stagePath))).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
      return { state, contents, commands, journal, stdout: result.stdout, stderr: result.stderr };
    } finally {
      if (!path.resolve(dir).startsWith(base + path.sep)) throw new Error('测试目录越界');
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
  it('普通 JAR 校验、备份、停服、原子替换、启动和清理', async () => {
    const r = await scenario();
    expect(r.state).toBe('UNVERIFIED');
    expect(r.contents).toBe('new fixture');
    expect(r.commands).toBe('stoppedstarted');
    expect(r.journal).toContain('BACKUP');
  });
  it('首次部署跳过备份和停止，不报错', async () => {
    const r = await scenario({ first: true });
    expect(r.state).toBe('UNVERIFIED');
    expect(r.commands).toBe('started');
    expect(r.journal).not.toContain('BACKUP');
  });
  it('启动失败后恢复真实备份并重新启动旧服务', async () => {
    const r = await scenario({ fail: true });
    expect(r.state).toBe('ROLLEDBACK');
    expect(r.contents).toBe('old fixture');
    expect(r.journal).toContain('rollback\tOK');
  });
  it('无备份失败明确 FAILED，不假装回滚成功', async () => {
    const r = await scenario({ fail: true, backup: false });
    expect(r.state).toBe('FAILED');
    expect(r.contents).toBe('fail fixture');
  });
  it('停服前取消不修改旧文件，清理上传和任务锁', async () => {
    const r = await scenario({ cancel: true });
    expect(r.state).toBe('CANCELLED');
    expect(r.contents).toBe('old fixture');
    expect(r.commands).toBe('');
  });
  it.each(['directory', 'file'] as const)(
    'Docker %s 挂载都完成原子替换、容器内哈希和稳定观察',
    async (mount) => {
      const r = await scenario({ docker: true, mount });
      expect(r.state).toBe('UNVERIFIED');
      expect(r.commands).toBe('stopstart');
      expect(r.journal).toContain('containerHash\tOK');
    },
  );
  it('Docker 容器内哈希持续不一致，明确标为回滚校验失败', async () => {
    const r = await scenario({ docker: true, badHash: true });
    expect(r.state).toBe('ROLLBACK_FAILED');
    expect(r.contents).toBe('old fixture');
    expect(r.stdout + r.stderr).toContain('fixture logs');
  });
});
