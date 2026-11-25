import { describe, expect, it } from 'vitest';
import { deployStats, matchesHistoryTarget, type HistoryScope } from '../src/deploy-stats';
import { createTask, toHistory } from '../src/engine';
import { summarizeTask } from '../src/history-model';
import { seed, type TargetStatus } from '../src/model';

const all: HistoryScope = {
  service: 'all',
  server: 'all',
  environment: 'all',
  date: { from: '', to: '' },
};

function task(id: string, statuses: TargetStatus[], day = 10) {
  const db = seed();
  const service = db.services[0];
  const targets = statuses.map((_, i) => ({
    ...db.targets.find((target) => target.serviceId === service.id)!,
    id: 'target-' + i,
    serverId: db.servers[i % db.servers.length].id,
    name: '环境 ' + i,
  }));
  const result = createTask(db, service, targets, {}, 'existing');
  result.id = id;
  result.started = new Date(2026, 10, day, 12).toISOString();
  result.status = 'partial';
  result.targets.forEach((target, i) => {
    target.status = statuses[i];
    target.elapsed = (i + 1) * 10;
  });
  return result;
}

describe('部署统计', () => {
  it('按目标结果计数，包含健康未验证和失败耗时，独立统计其他状态', () => {
    const deployment = task('deploy', [
      'success',
      'unverified',
      'failed',
      'unknown',
      'cancelled',
      'skipped',
    ]);
    const rollback = task('rollback', ['success']);
    rollback.operation = 'rollback';
    const trial = task('trial', ['success']);
    trial.dryRun = true;
    const blocked = task('build', ['skipped']);
    blocked.buildSteps[0].status = 'failed';
    deployment.status = 'interrupted';
    const history = [...toHistory(deployment), ...toHistory(rollback)];
    const stats = deployStats(
      [...history, history[0]],
      [deployment, rollback, trial, blocked].map(summarizeTask),
      all,
    );
    expect(stats).toMatchObject({ total: 3, success: 1, unverified: 1, failed: 1, average: 20 });
    expect(stats.rate).toBeCloseTo(66.6667, 3);
    expect(stats.excluded).toEqual({
      rollback: 1,
      dryRun: 1,
      interrupted: 1,
      unknown: 1,
      cancelled: 1,
      skipped: 1,
      buildFailed: 1,
    });
    expect(stats.services[0]).toMatchObject({ total: 3, average: 20 });
  });

  it('服务器与环境必须匹配同一目标，且日期范围包含两端', () => {
    const deployment = task('deploy', ['success', 'failed']);
    const [first, second] = toHistory(deployment);
    expect(first.server.id).not.toBe(second.server.id);
    const scope = { ...all, server: first.server.id, environment: second.target.name };
    const summary = summarizeTask(deployment);
    expect(
      summary.targets?.some((target) => matchesHistoryTarget(target.serverId, target.name, scope)),
    ).toBe(false);
    expect(deployStats([first, second], [summary], scope).rate).toBeNull();
    const date = { from: '2026-11-10', to: '2026-11-10' };
    expect(
      deployStats([first, second], [summary], { ...scope, environment: first.target.name, date })
        .total,
    ).toBe(1);
  });

  it('优先使用错误并回退至失败步骤，缺失日期的趋势保持空白', () => {
    const first = toHistory(task('first', ['failed', 'failed'], 10));
    first[0].error = '自定义部署错误\n下一行';
    first[0].steps[0].status = 'failed';
    first[1].steps[0].status = 'failed';
    first[1].steps[0].label = '启动服务';
    const last = toHistory(task('last', ['success'], 12));
    const stats = deployStats([...first, ...last], [], all);
    expect(stats.failures).toEqual(
      expect.arrayContaining([
        { reason: '自定义部署错误', count: 1 },
        { reason: '服务启动失败', count: 1 },
      ]),
    );
    expect(stats.buckets.map(({ rate, average }) => [rate, average])).toEqual([
      [0, 15],
      [null, null],
      [100, 10],
    ]);
    const wide = deployStats([...first, ...last], [], {
      ...all,
      date: { from: '2026-01-01', to: '2026-12-31' },
    });
    expect(wide.buckets.length).toBeLessThanOrEqual(12);
    expect(wide.buckets.reduce((sum, bucket) => sum + bucket.total, 0)).toBe(3);
  });
});
