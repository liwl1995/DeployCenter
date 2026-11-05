import { describe, it, expect } from 'vitest';
import { seed, fmtTime, seconds } from '../src/model';
import {
  healthLabels,
  targetVersion,
  shortHash,
  taskLabels,
  targetLabels,
  stepLabels,
  toolLabels,
  taskResult,
  cloneTarget,
  cloneService,
  confirmProduction,
} from '../src/presentation';
describe('1.2.0 展示和数据含义', () => {
  it('中文映射覆盖所有内部状态及工具模式', () => {
    expect(Object.keys(taskLabels)).toHaveLength(7);
    expect(Object.keys(targetLabels)).toHaveLength(10);
    expect(Object.keys(stepLabels)).toHaveLength(5);
    expect(Object.keys(toolLabels)).toHaveLength(3);
    expect(Object.keys(healthLabels)).toHaveLength(4);
    for (const value of [
      ...Object.values(taskLabels),
      ...Object.values(targetLabels),
      ...Object.values(stepLabels),
      ...Object.values(toolLabels),
      ...Object.values(healthLabels),
    ])
      expect(value).toMatch(/[\u4e00-\u9fff]/);
    expect(taskResult({ dryRun: true, status: 'success' })).toBe('检查通过');
    expect(taskResult({ dryRun: true, status: 'failed' })).toBe('检查未通过');
  });
  it('时间统一补零，时长按分小时表达', () => {
    expect(fmtTime('2026-11-03T17:22:19')).toBe('2026-11-03 17:22:19');
    expect(seconds(27.2)).toBe('27.2 秒');
    expect(seconds(169.2)).toBe('2 分 49 秒');
    expect(seconds(3788)).toBe('1 小时 3 分');
  });
  it('JAR 指纹不能冒充 Git 提交，哈希只显示7位', () => {
    const hash = 'a'.repeat(64);
    expect(targetVersion({ version: hash.slice(0, 12), currentHash: hash })).toEqual({
      commit: undefined,
      jar: hash,
    });
    expect(shortHash(hash)).toBe('aaaaaaa');
    expect(targetVersion({ version: 'b'.repeat(40), currentHash: hash }).commit).toBe(
      'b'.repeat(40),
    );
  });
  it('克隆不继承线上版本、正式标记或历史，源对象保持不变', () => {
    const db = seed(),
      target = cloneTarget(
        { ...db.targets[0], production: true, currentHash: 'a'.repeat(64) },
        'copy',
      );
    expect(target.production).toBe(false);
    expect(target.currentHash).toBeUndefined();
    expect(target.lastDeploy).toBe('未记录');
    expect(cloneService(db.services[0], 'copy').git.commit).toBe('未记录');
    expect(db.services[0].id).not.toBe('copy');
  });
  it('多个正式目标逐一核对名称，不能用旧 DEPLOY 绕过', () => {
    const targets = seed()
      .targets.slice(0, 2)
      .map((target, i) => ({ target: { ...target, production: true, name: '正式' + i } }));
    const task = { targets: targets as import('../src/model').RunTarget[], dryRun: false };
    expect(confirmProduction(task, { [targets[0].target.id]: 'DEPLOY' })).toBe(false);
    expect(
      confirmProduction(task, Object.fromEntries(targets.map((r) => [r.target.id, r.target.name]))),
    ).toBe(true);
  });
});
