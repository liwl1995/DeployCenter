import type { RunTarget, TargetStatus } from '../src/model';
import type { FinalState } from './workbench';

export function targetOutcome(state: FinalState): TargetStatus {
  switch (state) {
    case 'SUCCESS':
      return 'success';
    case 'UNVERIFIED':
      return 'unverified';
    case 'ROLLEDBACK':
      return 'rolledback';
    case 'CANCELLED':
      return 'cancelled';
    case 'FAILED':
    case 'ROLLBACK_FAILED':
      return 'failed';
  }
}

export function applyRemoteJournal(r: RunTarget, text: string) {
  for (const line of text.split('\n').filter(Boolean)) {
    const [stamp, kind, key, status] = line.split('\t');
    const time = Number(stamp);
    if (!Number.isSafeInteger(time) || time < 0) throw new Error('远端任务事件无效');
    if (kind === 'BACKUP') {
      if (!Number.isSafeInteger(Number(key)) || Number(key) <= 0)
        throw new Error('远端备份大小无效');
      r.backupCreated = true;
      r.backupCreatedAt = time;
      r.backupPath = r.plannedBackupPath;
      r.backupSize = Number(key);
      r.backupHash = /^[a-f0-9]{64}$/i.test(status) ? status : undefined;
      continue;
    }
    if (kind !== 'STEP') continue;
    let index = r.steps.findIndex((s) => s.key === key);
    if (key === 'rollback' && index < 0) {
      r.steps.push({ key: 'rollback', label: '恢复旧版本并重新启动、检查', critical: true });
      index = r.steps.length - 1;
    }
    if (index < 0) continue;
    const step = r.steps[index];
    r.phase = index;
    if (status === 'START') {
      step.startedAt = time;
      step.status = 'running';
      if (key === 'rollback') r.status = 'rollingback';
    } else {
      step.endedAt = time;
      step.elapsed = Math.max(0, time - (step.startedAt ?? time)) / 1000;
      step.status = status === 'OK' ? 'success' : status === 'FAIL' ? 'failed' : 'skipped';
      if (status !== 'FAIL') r.phase = index + 1;
      else {
        r.steps.slice(index + 1).forEach((s) => {
          if (s.status === 'pending') s.status = 'skipped';
        });
        r.error = '远端步骤失败：' + step.label;
      }
    }
  }
}
