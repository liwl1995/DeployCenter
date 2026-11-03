import { describe, expect, it } from 'vitest';
import {
  seed,
  remoteJar,
  shellQuote,
  safeConfigJson,
  validDatabase,
  type Task,
} from '../src/model';
import {
  createTask,
  tick,
  requestFailure,
  cancelTask,
  toHistory,
  targetSteps,
} from '../src/engine';
import { acceptBuild, acceptUpload } from '../src/validation';
function run(task: Task) {
  let t = task;
  for (let i = 0; i < 150 && ['running', 'cancelling'].includes(t.status); i++) t = tick(t);
  return t;
}
function prepare() {
  const db = seed();
  return {
    db,
    task: createTask(
      db,
      db.services[0],
      db.targets.filter((t) => t.serviceId === 'crm'),
      {},
      'rebuild',
    ),
  };
}
describe('目标与部署引擎', () => {
  it('服务器是独立实体，且本地与远程文件名互不绑定', () => {
    const db = seed();
    expect(db.targets.filter((t) => t.serverId === 's72')).toHaveLength(2);
    expect(db.services[0].jarName).toBe('cordys-crm.jar');
    expect(remoteJar(db.targets[2])).toBe('/data/crm/crm.jar');
  });
  it('三个目标依次推进，一次构建，区分健康未验证', () => {
    let { task } = prepare();
    for (let i = 0; i < 4; i++) task = tick(task);
    expect(task.targets[0].status).toBe('running');
    expect(task.targets[1].status).toBe('pending');
    const done = run(task);
    expect(done.targets.map((t) => t.status)).toEqual(['unverified', 'unverified', 'success']);
    expect(done.buildLogs.filter((l) => l.includes('Maven 构建成功'))).toHaveLength(1);
    expect(toHistory(done)).toHaveLength(3);
  });
  it('失败默认回滚并停止后续目标', () => {
    const { task } = prepare();
    const done = run(requestFailure(task));
    expect(done.targets.map((t) => t.status)).toEqual(['rolledback', 'skipped', 'skipped']);
    expect(done.status).toBe('failed');
    expect(toHistory(done)[0].backupPath).toContain('backups');
  });
  it('继续策略不会把其他目标标记失败', () => {
    const { task } = prepare();
    task.failurePolicy = 'continue';
    const done = run(requestFailure(task));
    expect(done.targets.map((t) => t.status)).toEqual(['rolledback', 'unverified', 'success']);
    expect(done.status).toBe('partial');
  });
  it('禁用备份时失败不可自动回滚，也不能生成备份记录', () => {
    const { db, task } = prepare();
    const t = createTask(
      db,
      db.services[0],
      [db.targets[0]],
      { t19: { ...task.targets[0].backup, enabled: false } },
      'existing',
    );
    const done = run(requestFailure(t));
    expect(done.targets[0].status).toBe('failed');
    expect(toHistory(done)[0].backupPath).toBeUndefined();
  });
  it('首次部署正常跳过旧文件备份', () => {
    const { db } = prepare();
    db.targets[0].hasOldJar = false;
    const done = run(createTask(db, db.services[0], [db.targets[0]], {}, 'existing'));
    expect(done.status).toBe('success');
    expect(done.targets[0].logs.some((l) => l.includes('无旧 JAR'))).toBe(true);
    expect(toHistory(done)[0].backupPath).toBeUndefined();
  });
  it('准备阶段取消先进入取消中，再清理与结束', () => {
    const { task } = prepare();
    const requested = cancelTask(task);
    expect(requested.status).toBe('cancelling');
    const done = tick(requested);
    expect(done.status).toBe('cancelled');
    expect(done.targets.every((t) => t.status === 'skipped')).toBe(true);
  });
  it('切换阶段取消完成当前目标后才跳过其他目标', () => {
    let { task } = prepare();
    while (task.buildPhase < 3 || !task.targets[0].steps[task.targets[0].phase].critical)
      task = tick(task);
    task = cancelTask(task);
    expect(tick(task).status).toBe('cancelling');
    const done = run(task);
    expect(done.targets[0].status).toBe('unverified');
    expect(done.targets[1].status).toBe('skipped');
    expect(done.status).toBe('cancelled');
  });
  it('普通 JAR 和 Docker 的阶段匹配运行方式', () => {
    const db = seed();
    expect(targetSteps(db.targets[0], db.targets[0].backup).map((x) => x.key)).toContain(
      'containerHash',
    );
    const jar = targetSteps(db.targets[3], db.targets[3].backup);
    expect(jar.map((x) => x.key)).toContain('chmod');
    expect(jar.map((x) => x.key)).not.toContain('containerHash');
  });
  it('带单引号的路径被统一 shell 引用', () =>
    expect(shellQuote("/data/it's jar")).toBe("'/data/it'\\''s jar'"));
});
describe('正式实现需要遵守的接受条件', () => {
  it('配置导入检查引用关系，导出排除额外认证口令', () => {
    const db = seed();
    expect(validDatabase(db)).toBe(true);
    const poisoned = { ...db, password: 'do-not-export' };
    expect(safeConfigJson(poisoned)).not.toContain('do-not-export');
    db.targets[0].serverId = 'missing';
    expect(validDatabase(db)).toBe(false);
  });
  it('无健康检查的目标不能伪造 HTTP 故障或成功', () => {
    const db = seed();
    const target = db.targets[0];
    const done = run(requestFailure(createTask(db, db.services[0], [target], {}, 'existing')));
    expect(done.targets[0].error).toContain('启动命令执行失败');
    expect(done.targets[0].logs.join('\n')).not.toContain('HTTP 200');
  });
  it('Maven 非零退出不能复用旧产物', () => {
    const result = {
      exitCode: 1,
      successMarker: true,
      validJar: true,
      modified: 100,
      started: 200,
    };
    expect(acceptBuild(result, true)).toBe(false);
    expect(acceptBuild({ ...result, modified: 300 }, true)).toBe(true);
    expect(acceptBuild({ ...result, modified: 300 }, false)).toBe(false);
  });
  it('没有远端哈希时，必须显式允许退化校验', () => {
    const local = { size: 100, hash: 'a' };
    expect(acceptUpload(local, { size: 100 }, 'required', true)).toBe(false);
    expect(acceptUpload(local, { size: 100 }, 'size-confirm', false)).toBe(false);
    expect(acceptUpload(local, { size: 100 }, 'size-confirm', true)).toBe(true);
    expect(acceptUpload(local, { size: 100, hash: 'b' }, 'size-confirm', true)).toBe(false);
  });
});
