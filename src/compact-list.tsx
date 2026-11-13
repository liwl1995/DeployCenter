import type { TaskSummary } from './platform';
import { fmtTime } from './model';
import { taskResult } from './presentation';

export type CompactTone = 'good' | 'warn' | 'progress' | 'neutral';
export function CompactStatus({ label, tone }: { label: string; tone: CompactTone }) {
  return (
    <span className={'compact-status ' + tone} title={label}>
      <i aria-hidden="true" />
      {label}
    </span>
  );
}
/** 任务成功不等于健康已确认，紧凑摘要仍保留这个区别。 */
export function historyState(row: TaskSummary): { label: string; tone: CompactTone } {
  if (row.maintenance || row.uncertain)
    return {
      label: taskResult(row),
      tone: row.uncertain || row.status !== 'success' ? 'warn' : 'good',
    };
  if (row.buildFailed) return { label: '构建失败', tone: 'warn' };
  if (
    row.status === 'success' &&
    !row.dryRun &&
    row.targets?.some((t) => t.status === 'unverified')
  )
    return { label: '健康未验证', tone: 'warn' };
  if (row.status === 'failed' && row.targets?.some((t) => t.status === 'rolledback'))
    return { label: '失败 · 已回滚', tone: 'warn' };
  return {
    label: taskResult(row),
    tone:
      row.status === 'success'
        ? 'good'
        : ['failed', 'partial', 'interrupted'].includes(row.status)
          ? 'warn'
          : ['running', 'cancelling'].includes(row.status)
            ? 'progress'
            : 'neutral',
  };
}
export function historyDay(value: string, now = new Date()) {
  if (!Number.isFinite(Date.parse(value))) return { key: 'unknown', label: '时间未记录' };
  const key = fmtTime(value).slice(0, 10);
  const today = fmtTime(now.toISOString()).slice(0, 10);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const previous = fmtTime(yesterday.toISOString()).slice(0, 10);
  return { key, label: (key === today ? '今天 · ' : key === previous ? '昨天 · ' : '') + key };
}
/** 只提取检测输出里的实际版本；无法识别时保留完整输出供展开查看。 */
export function compactVersion(output: string | undefined, kind: 'jdk' | 'maven') {
  const text = (output || '').replace(/\x1b\[[0-9;]*m/g, '');
  const match =
    kind === 'jdk'
      ? /(?:openjdk|java|javac)(?:\s+version)?\s+"?([0-9][\w.+-]*)/i.exec(text)
      : /Apache Maven\s+([0-9][\w.+-]*)/i.exec(text);
  return match ? (kind === 'jdk' ? 'Java ' : 'Maven ') + match[1] : '版本未识别';
}
export function shortReason(value?: string) {
  return (value || '请展开查看检测详情')
    .replace(/^Error:\s*/i, '')
    .replace(/^Error invoking remote method ['"][^'"]+['"]:\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}
