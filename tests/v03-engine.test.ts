import { describe, it, expect } from 'vitest';
import { seed, safeConfigJson, loadDatabase, type Task } from '../src/model';
import {
  createTask,
  startTask,
  tick,
  toHistory,
  requestFailure,
  cancelTask,
  targetSteps,
  buildContext,
} from '../src/engine';
import { recordTask, canRollback, pruneHistory, historyLogs } from '../src/records';
import { CredentialSession, credentialServers } from '../src/credentials';
import { diagnostics, acceptJar, inspectJar } from '../src/validation';

function finish(task: Task, clock?: () => number) {
  for (let i = 0; i < 200 && ['running', 'cancelling'].includes(task.status); i++)
    task = tick(task, clock);
  return task;
}
function setup() {
  const db = seed();
  db.history = [];
  db.taskHistory = {};
  return db;
}
describe('v0.3 A1–A6 / B7：版本、备份、时间与历史', () => {
  it('A1 部署 v2 再回滚 v1 后，当前版本确实成为 v1', () => {
    let db = setup();
    db.targets[0].version = 'v1';
    db.services[0].git.commit = 'v2';
    db = recordTask(db, finish(createTask(db, db.services[0], [db.targets[0]], {}, 'existing')));
    expect(db.targets[0].version).toBe('v2');
    const historical = db.history[0];
    expect(historical.target.version).toBe('v1');
    const service = {
      ...db.services[0],
      git: { ...historical.service.git, commit: historical.target.version },
    };
    db = recordTask(
      db,
      finish(
        createTask(db, service, [db.targets[0]], {}, 'existing', historical.artifact, historical),
      ),
    );
    expect(db.targets[0].version).toBe('v1');
  });
  it('A2 修改备份标题并清空日志，不影响结构化回滚资格', () => {
    const db = setup();
    const task = createTask(db, db.services[0], [db.targets[0]], {}, 'existing');
    task.targets[0].steps.find((s) => s.key === 'backup')!.label = 'Save previous artifact';
    const done = finish(task);
    done.targets[0].logs = [];
    const record = toHistory(done)[0];
    expect(record.backupCreated).toBe(true);
    expect(canRollback(db, record)).toBe(true);
  });
  it('A2 备份未执行，不能生成回滚备份记录', () => {
    const db = setup(),
      task = createTask(db, db.services[0], [db.targets[0]], {}, 'existing');
    expect(task.targets[0].backupPath).toBeUndefined();
    task.targets[0].status = 'failed';
    task.targets[0].logs = ['备份当前版本并校验'];
    expect(toHistory(task)[0].backupPath).toBeUndefined();
    expect(canRollback(db, toHistory(task)[0])).toBe(false);
  });
  it('A3 非法 JSON 和旧 schema 保留原键，备份原始字符串', () => {
    for (const raw of ['{broken JSON', JSON.stringify({ ...seed(), schema: 2 })]) {
      localStorage.clear();
      localStorage.setItem('deploy-center-v2', raw);
      const loaded = loadDatabase();
      expect(loaded.recovery?.raw).toBe(raw);
      expect(localStorage.getItem(loaded.recovery!.backupKey!)).toBe(raw);
      expect(localStorage.getItem('deploy-center-v2')).toBe(raw);
    }
    localStorage.clear();
  });
  it('A4 注入时钟计算步骤、目标、任务真实耗时与上传速度', () => {
    const db = setup();
    let now = 1000;
    const clock = () => now;
    let task = createTask(
      db,
      db.services[0],
      [db.targets[0]],
      {},
      'existing',
      undefined,
      undefined,
      clock,
    );
    now = 3500;
    task = tick(task, clock);
    expect(task.buildSteps[0].elapsed).toBe(2.5);
    now = 4000;
    task = tick(task, clock);
    now = 5000;
    task = tick(task, clock);
    now = 6000;
    task = tick(task, clock);
    now = 7000;
    task = tick(task, clock);
    now = 8000;
    task = tick(task, clock);
    expect(task.targets[0].upload.percent).toBe(33);
    expect(task.targets[0].upload.speed).toBe(Math.ceil(task.artifact.size / 3));
    now = 9000;
    task = tick(task, clock);
    expect(task.targets[0].upload.percent).toBe(67);
    now = 10000;
    task = tick(task, clock);
    expect(task.targets[0].upload.percent).toBe(100);
    expect(task.targets[0].steps.find((s) => s.key === 'upload')!.elapsed).toBe(3);
    task = finish(task, () => (now += 500));
    expect(task.elapsed).toBe((now - 1000) / 1000);
    expect(task.targets[0].elapsed).toBe((now - 5000) / 1000);
    expect(task.targets[0].steps.reduce((sum, s) => sum + (s.elapsed || 0), 0)).toBe(
      task.targets[0].elapsed,
    );
    expect(toHistory(task)[0].steps.find((s) => s.key === 'upload')!.elapsed).toBe(3);
    const restarted = startTask(
      createTask(db, db.services[0], [db.targets[0]], {}, 'existing'),
      () => 20000,
    );
    expect(tick(restarted, () => 21000).elapsed).toBe(1);
  });
  it('A6 跳过、未切换的取消目标均不写版本历史', () => {
    const db = setup();
    const task = createTask(db, db.services[0], db.targets.slice(0, 3), {}, 'existing');
    const failure = finish(requestFailure(task));
    expect(toHistory(failure)).toHaveLength(1);
    const cancelled = tick(cancelTask(task));
    expect(toHistory(cancelled)).toHaveLength(0);
    let prepared = task;
    while (prepared.buildPhase < 3) prepared = tick(prepared);
    expect(toHistory(tick(cancelTask(prepared)))).toHaveLength(0);
  });
  it('B7 三目标的构建日志只存一次，目标快照不含构建配置和认证信息', () => {
    const db = setup();
    const task = finish(createTask(db, db.services[0], db.targets.slice(0, 3), {}, 'existing'));
    task.buildLogs.push('unique-build-marker');
    const stored = recordTask(db, task);
    expect(stored.history).toHaveLength(3);
    expect(Object.keys(stored.taskHistory)).toHaveLength(1);
    expect(safeConfigJson(stored).split('unique-build-marker')).toHaveLength(2);
    expect(Object.keys(stored.history[0].service).sort()).toEqual(['git', 'id', 'name']);
    expect(stored.history[0].target).not.toHaveProperty('backup');
    expect(stored.history[0].server).not.toHaveProperty('keyPath');
    expect(stored.history[0].logs.join('\n')).not.toContain('unique-build-marker');
    expect(historyLogs(stored, stored.history[0]).join('\n')).toContain('unique-build-marker');
  });
  it('B7 按时间清理最旧目标记录，并删除不再引用的任务日志', () => {
    const db = seed();
    db.settings.historyLimit = 1;
    const trimmed = pruneHistory(db);
    expect(trimmed.history[0].id).toBe('h1');
    expect(Object.keys(trimmed.taskHistory)).toEqual(['DC-SAMPLE-001']);
  });
});
describe('v0.3 B8 / C9 / D10 / E12–14', () => {
  it('B8 凭据会话仅在内存，按服务器去重，清理后不再可取', () => {
    const db = seed();
    db.servers[0].auth = 'password';
    expect(credentialServers([db.servers[0], db.servers[0]])).toHaveLength(1);
    const session = new CredentialSession();
    session.set({ s19: 'memory-only' });
    expect(session.get('s19')).toBe('memory-only');
    session.clear();
    expect(session.get('s19')).toBeUndefined();
    const poisoned = { ...db, password: 'memory-only' };
    expect(safeConfigJson(poisoned)).not.toContain('memory-only');
    expect(JSON.parse(safeConfigJson(db)).servers[0].credentialMode).toBe('ask');
  });
  it('C9 三个脚本目标均无伪造健康检查，运行字段按方式独立生成', () => {
    const db = seed();
    for (const id of ['t19', 't112', 't72']) {
      const t = db.targets.find((t) => t.id === id)!;
      expect(t.health.type).toBe('none');
      expect(t.healthState).toBe('未配置健康检查');
      expect(t.version).toBe('未记录');
      expect(t.lastDeploy).toBe('未记录');
    }
    expect(db.targets[3].start).toBe('./yotoo-campus-alarm-service.jar start');
    expect(db.targets[3].stop).toBe('./yotoo-campus-alarm-service.jar stop');
    expect(db.targets[0].stop).toBe('');
    expect(db.targets[0].start).toBe('');
    expect(db.targets[3].container).toBe('');
    expect(db.targets[3].containerJar).toBe('');
    const http = db.targets.filter((t) => t.health.type === 'http');
    expect(http).toHaveLength(1);
    expect(http[0].name).toContain('新增示例');
  });
  it.each(['file', 'directory'] as const)(
    'D10 %s 挂载都先停容器、原子替换、启动后查哈希',
    (mount) => {
      const db = seed();
      db.targets[0].mount = mount;
      const steps = targetSteps(db.targets[0], db.targets[0].backup);
      expect(steps.find((s) => s.key === 'replace')!.label).toContain('原子 mv');
      const keys = steps.map((s) => s.key);
      expect(keys.indexOf('stop')).toBeLessThan(keys.indexOf('replace'));
      expect(keys.indexOf('start')).toBeLessThan(keys.indexOf('containerHash'));
    },
  );
  it('D10 容器内哈希不一致触发失败，并按有效备份回滚', () => {
    const db = setup();
    const done = finish(
      requestFailure(
        createTask(db, db.services[0], [db.targets[0]], {}, 'existing'),
        'containerHash',
      ),
    );
    expect(done.targets[0].error).toContain('容器内 JAR 哈希不一致');
    expect(done.targets[0].status).toBe('rolledback');
    expect(done.targets[0].steps.find((s) => s.key === 'containerHash')!.status).toBe('failed');
  });
  it('E12 完整构建上下文包含 Maven / Wrapper、Profile、工作目录和 JDK', () => {
    const db = seed(),
      s = db.services[0];
    s.profiles = 'release,test';
    s.workDir = 'backend';
    const wrapper = buildContext(db, s);
    expect(wrapper.command).toContain('-Prelease,test');
    expect(wrapper.tool).toContain('mvnw.cmd');
    expect(wrapper.workDir).toBe(s.root + '\\backend');
    expect(wrapper.jdkPath).toBe('E:\\dev\\jdk\\jdk21');
    s.tool = 'maven';
    s.mavenPath = 'E:\\Maven Home\\bin\\mvn.cmd';
    expect(buildContext(db, s).command).toContain('"E:\\Maven Home\\bin\\mvn.cmd"');
  });
  it('E13 排查命令包含登录方式并转义远程路径和名称', () => {
    const db = seed(),
      s = db.servers[0],
      t = db.targets[0];
    t.container = "it's crm";
    expect(diagnostics(s, t).split('\n')[0]).toBe("ssh 'cordys-19'");
    expect(diagnostics(s, t)).toContain("'it'\\''s crm'");
    s.auth = 'password';
    s.user = 'deploy';
    s.host = 'example.test';
    s.port = 2222;
    expect(diagnostics(s, t).split('\n')[0]).toBe("ssh -p 2222 'deploy@example.test'");
    s.auth = 'key';
    expect(diagnostics(s, t).split('\n')[0]).toContain('ssh -p 2222');
  });
});
function zip(name = 'META-INF/MANIFEST.MF', value = 'Manifest-Version: 1.0\r\n') {
  const n = new TextEncoder().encode(name),
    data = new TextEncoder().encode(value),
    buffer = new Uint8Array(30 + n.length + data.length + 46 + n.length + 22),
    view = new DataView(buffer.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint32(18, data.length, true);
  view.setUint32(22, data.length, true);
  view.setUint16(26, n.length, true);
  buffer.set(n, 30);
  buffer.set(data, 30 + n.length);
  const dir = 30 + n.length + data.length;
  view.setUint32(dir, 0x02014b50, true);
  view.setUint32(dir + 20, data.length, true);
  view.setUint32(dir + 24, data.length, true);
  view.setUint16(dir + 28, n.length, true);
  buffer.set(n, dir + 46);
  const end = dir + 46 + n.length;
  view.setUint32(end, 0x06054b50, true);
  view.setUint16(end + 8, 1, true);
  view.setUint16(end + 10, 1, true);
  view.setUint32(end + 12, 46 + n.length, true);
  view.setUint32(end + 16, dir, true);
  return buffer;
}
describe('v0.3 E14：JAR 结构接受条件', () => {
  it('接受含非空 Manifest 的 ZIP', () => expect(acceptJar(zip())).toBe(true));
  it('接受带 Spring Boot 启动脚本前缀的 ZIP', () => {
    const prefix = new TextEncoder().encode('#!/bin/sh\n'),
      original = zip(),
      combined = new Uint8Array(prefix.length + original.length);
    combined.set(prefix);
    combined.set(original, prefix.length);
    expect(acceptJar(combined)).toBe(true);
  });
  it('拒绝只有伪造头部或截断 ZIP 的文件', () => {
    expect(acceptJar(new TextEncoder().encode('PK\u0003\u0004pretend jar'))).toBe(false);
    expect(acceptJar(zip().slice(0, -3))).toBe(false);
  });
  it('拒绝没有 Manifest 或空 Manifest', () => {
    expect(inspectJar(zip('app.class')).reason).toContain('MANIFEST');
    expect(acceptJar(zip('META-INF/MANIFEST.MF', ''))).toBe(false);
  });
  it('拒绝中央目录偏移损坏和名称不一致', () => {
    const broken = zip();
    new DataView(broken.buffer).setUint32(broken.length - 6, 0xffffff, true);
    expect(acceptJar(broken)).toBe(false);
    const names = zip();
    names[30] = 88;
    expect(acceptJar(names)).toBe(false);
  });
});
