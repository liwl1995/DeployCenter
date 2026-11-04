// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { localHealth } from '../electron/health';
import { healthTiming } from '../src/health-timing';
import { seed, type Health } from '../src/model';
import { serviceInfo } from '../electron/files';
import { validateDatabase } from '../electron/validate';
import { runProcess } from '../electron/process';
import runner from '../electron/remote-runner.sh';
const base = path.resolve('.test-data');
const dirs: string[] = [];
async function temp() {
  await fs.mkdir(base, { recursive: true });
  const dir = await fs.mkdtemp(path.join(base, 'v110 中文 '));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    if (!dir.startsWith(base + path.sep)) throw new Error('测试路径越界');
    await fs.rm(dir, { recursive: true, force: true });
  }
});
const health = (patch: Partial<Health> = {}): Health => ({
  type: 'http',
  value: 'http://127.0.0.1:1/health',
  timeout: 10,
  retries: 1,
  interval: 5,
  startDelay: 0,
  maxWait: 300,
  ...patch,
});
function clock() {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}
describe('1.1.0 启动就绪窗口', () => {
  it('先静默等待，慢启动超过旧重试次数仍可在窗口内成功', async () => {
    const c = clock(),
      times: number[] = [];
    const passed = await localHealth(
      health({ startDelay: 30 }),
      c,
      new AbortController().signal,
      () => {},
      async () => {
        times.push(c.now());
        return c.now() >= 210000;
      },
    );
    expect(passed).toBe(true);
    expect(times[0]).toBe(30000);
    expect(times.length).toBeGreaterThan(1);
    expect(c.now()).toBe(210000);
  });
  it('总窗口耗尽才失败，最后一次探测超时按剩余窗口截断', async () => {
    const c = clock(),
      limits: number[] = [];
    expect(
      await localHealth(
        health({ maxWait: 18 }),
        c,
        new AbortController().signal,
        () => {},
        async (_h, ms) => {
          limits.push(ms);
          c.advance(ms);
          return false;
        },
      ),
    ).toBe(false);
    expect(limits).toEqual([10000, 3000]);
    expect(c.now()).toBe(18000);
  });
  it('启动即就绪时不等待整个窗口', async () => {
    const c = clock();
    expect(
      await localHealth(
        health(),
        c,
        new AbortController().signal,
        () => {},
        async () => true,
      ),
    ).toBe(true);
    expect(c.now()).toBe(0);
  });
  it('旧配置保留次数语义，读取时不强制迁移', async () => {
    const h = health({ maxWait: undefined, startDelay: undefined, retries: 2, interval: 2 });
    const c = clock();
    let attempts = 0;
    expect(healthTiming(h)).toEqual({ delay: 0, window: 22, byWindow: false });
    expect(
      await localHealth(
        h,
        c,
        new AbortController().signal,
        () => {},
        async () => {
          attempts++;
          return false;
        },
      ),
    ).toBe(false);
    expect(attempts).toBe(2);
    expect(c.now()).toBe(2000);
  });
  it('启动等待中中止，不再执行探测', async () => {
    const controller = new AbortController();
    const c = clock();
    let calls = 0;
    const wait = {
      ...c,
      sleep: async (ms: number) => {
        await c.sleep(ms);
        controller.abort();
      },
    };
    expect(
      await localHealth(
        health({ startDelay: 30 }),
        wait,
        controller.signal,
        () => {},
        async () => {
          calls++;
          return true;
        },
      ),
    ).toBe(false);
    expect(calls).toBe(0);
    expect(c.now()).toBe(1000);
  });
  it('配置校验接受启动等待，拒绝负数与过大窗口，同时接受旧数据', () => {
    const db = seed();
    expect(validateDatabase(db)).toBe(db);
    db.targets[0].health = health({ startDelay: 30, maxWait: 600 });
    expect(validateDatabase(db)).toBe(db);
    db.targets[0].health.startDelay = -1;
    expect(() => validateDatabase(db)).toThrow();
    db.targets[0].health.startDelay = 0;
    db.targets[0].health.maxWait = 3601;
    expect(() => validateDatabase(db)).toThrow();
  });
  it('真实 Bash 的同一健康函数支持分钟级慢启动与总超时（隔离假时钟）', async () => {
    const dir = await temp();
    const unix = (p: string) =>
      p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d: string) => '/' + d.toLowerCase());
    const functions = runner.slice(
      runner.indexOf('container_ready() {'),
      runner.indexOf('\nbackup_old() {'),
    );
    const script =
      `set -e\n${functions}\nMODE=jar; HEALTH_LOCATION=remote; HEALTH_TYPE=http; HEALTH_VALUE=fixture; HEALTH_TIMEOUT=10; HEALTH_RETRIES=1; HEALTH_INTERVAL=5; HEALTH_DELAY=30; HEALTH_WINDOW=300; HEALTH_BY_WINDOW=1\n` +
      `date(){ cat "$FIXTURE_ROOT/clock"; }\nsleep(){ n=$(cat "$FIXTURE_ROOT/clock"); printf '%s' "$((n + $1))" > "$FIXTURE_ROOT/clock"; }\ncurl(){ n=$(cat "$FIXTURE_ROOT/clock"); if [ "$n" -ge 210 ]; then printf 200; else printf 503; fi; }\nprintf 0 > "$FIXTURE_ROOT/clock"\nhealth_check\n[ "$(cat "$FIXTURE_ROOT/clock")" = 210 ]\nHEALTH_DELAY=0; HEALTH_WINDOW=18; printf 0 > "$FIXTURE_ROOT/clock"\ncurl(){ printf 503; }\nif health_check; then exit 7; fi\n[ "$(cat "$FIXTURE_ROOT/clock")" = 18 ]\nprintf 'window-ok\\n'\n`;
    const file = path.join(dir, 'health.sh');
    await fs.writeFile(file, script);
    const result = await runProcess(
      process.env.DEPLOY_CENTER_TEST_BASH || 'E:/dev/git/bin/bash.exe',
      [unix(file)],
      {
        timeout: 20000,
        env: { ...process.env, FIXTURE_ROOT: unix(dir), MSYS2_ARG_CONV_EXCL: '*' },
      },
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('window-ok');
    // 复用实际稳定性与健康函数，验证 Docker starting 不会提前使启动失败。
    const stability = runner.slice(runner.indexOf('stability() {'), runner.indexOf('# 应用健康'));
    const dockerScenario =
      `set -e\n${stability}\n${functions}\nMODE=docker; HEALTH_TYPE=http; HEALTH_LOCATION=remote; HEALTH_VALUE=fixture; HEALTH_TIMEOUT=10; HEALTH_RETRIES=1; HEALTH_INTERVAL=5; HEALTH_DELAY=0; HEALTH_WINDOW=60; HEALTH_BY_WINDOW=1; STABILITY_SECONDS=2; COMMAND_TIMEOUT=120; restart_baseline=2; CONTAINER=fixture\n` +
      `date(){ cat "$FIXTURE_ROOT/clock"; }\nsleep(){ n=$(cat "$FIXTURE_ROOT/clock"); printf '%s' "$((n + $1))" > "$FIXTURE_ROOT/clock"; }\ntimeout(){ shift; "$@"; }\ncurl(){ printf 200; }\ndocker(){ case "$3" in *Running*RestartCount*) n=$(cat "$FIXTURE_ROOT/clock"); if [ "$n" -ge 20 ]; then printf 'true 2 healthy'; else printf 'true 2 starting'; fi;; *Running*) printf true;; *RestartCount*) printf 2;; *Health*) printf starting;; esac; }\nprintf 0 > "$FIXTURE_ROOT/clock"\nstability\n[ "$(cat "$FIXTURE_ROOT/clock")" = 2 ]\nhealth_check\n[ "$(cat "$FIXTURE_ROOT/clock")" = 22 ]\nprintf 'docker-wait-ok\\n'\n`;
    await fs.writeFile(file, dockerScenario);
    const dockerResult = await runProcess(
      process.env.DEPLOY_CENTER_TEST_BASH || 'E:/dev/git/bin/bash.exe',
      [unix(file)],
      {
        timeout: 10000,
        env: { ...process.env, FIXTURE_ROOT: unix(dir), MSYS2_ARG_CONV_EXCL: '*' },
      },
    );
    expect(dockerResult.code, dockerResult.stderr).toBe(0);
    expect(dockerResult.stdout).toContain('docker-wait-ok');
  }, 25000);
});
describe('1.1.0 本机产物与 Git 摘要', () => {
  it('中文空格目录真实读取产物元数据、分支提交和工作区修改', async () => {
    const dir = await temp();
    await fs.mkdir(path.join(dir, 'target'));
    await fs.writeFile(path.join(dir, 'target', 'app.jar'), 'metadata-only');
    await fs.writeFile(path.join(dir, 'readme.txt'), 'fixture');
    const git = (args: string[]) =>
      runProcess(
        'git',
        ['-C', dir, '-c', 'core.hooksPath=' + path.join(dir, 'empty-hooks'), ...args],
        { timeout: 10000 },
      );
    expect((await git(['init', '--initial-branch=local-fixture'])).code).toBe(0);
    expect((await git(['add', 'readme.txt'])).code).toBe(0);
    expect(
      (
        await git([
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          'commit',
          '--no-gpg-sign',
          '-m',
          'fixture',
        ])
      ).code,
    ).toBe(0);
    const s = { ...seed().services[0], root: dir, jarDir: 'target', jarName: 'app.jar' };
    const info = await serviceInfo(s);
    expect(info.artifact.size).toBe(13);
    expect(info.artifact.exists).toBe(true);
    expect(info.artifact.path).toBe(path.join(dir, 'target', 'app.jar'));
    expect(info.artifact.sha256).toBeUndefined();
    expect(info.git.branch).toBe('local-fixture');
    expect(info.git.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(info.git.dirty).toBe(true);
    const missing = await serviceInfo({ ...s, jarName: 'missing.jar' });
    expect(missing.artifact.exists).toBe(false);
    expect(missing.artifactError).toContain('不存在');
    expect(missing.git.commit).toBe(info.git.commit);
  });
});
