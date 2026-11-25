import { withinDateRange, type DateRange } from './date-range';
import { fmtTime, type History } from './model';
import type { TaskSummary } from './platform';

export type HistoryScope = {
  service: string;
  server: string;
  environment: string;
  date: DateRange;
};

export function matchesHistoryTarget(serverId: string, name: string, scope: HistoryScope) {
  return (
    (scope.server === 'all' || serverId === scope.server) &&
    (scope.environment === 'all' || name === scope.environment)
  );
}

export function matchesHistoryScope(serviceId: string, started: string, scope: HistoryScope) {
  return (
    (scope.service === 'all' || serviceId === scope.service) &&
    withinDateRange(fmtTime(started).slice(0, 10), scope.date)
  );
}

type Counts = {
  success: number;
  unverified: number;
  failed: number;
  durationSum: number;
  durationCount: number;
};
const emptyCounts = (): Counts => ({
  success: 0,
  unverified: 0,
  failed: 0,
  durationSum: 0,
  durationCount: 0,
});
function summarize(counts: Counts) {
  const total = counts.success + counts.unverified + counts.failed;
  return {
    total,
    success: counts.success,
    unverified: counts.unverified,
    failed: counts.failed,
    rate: total ? ((counts.success + counts.unverified) / total) * 100 : null,
    average: counts.durationCount ? counts.durationSum / counts.durationCount : null,
  };
}
type Measured = 'success' | 'unverified' | 'failed';
function add(counts: Counts, status: Measured, elapsed: number) {
  counts[status]++;
  if (Number.isFinite(elapsed) && elapsed >= 0) {
    counts.durationSum += elapsed;
    counts.durationCount++;
  }
}

const failureGroups = [
  [/健康检查|HTTP GET 返回|HTTP\s+[45]\d\d/i, '健康检查未通过'],
  [/权限不足|权限不够|无写入权限|无法写入|permission denied|部署目录.*权限/i, '目录或权限错误'],
  [/SSH|连接.*失败|connection (?:timed out|refused)|ETIMEDOUT|ECONNREFUSED/i, '服务器连接失败'],
  [/启动失败|启动服务|服务未启动|未能启动|容器重启/, '服务启动失败'],
] as const;

function failureReason(record: History) {
  const failedStep = record.steps.find((step) => step.status === 'failed');
  const raw = record.error?.trim() || failedStep?.label || '';
  if (!raw) return '未记录原因';
  const group = failureGroups.find(([pattern]) => pattern.test(raw));
  if (group) return group[1];
  // 失败原因以错误首行为准，后续堆栈留在原记录中。
  return raw.split(/\r?\n/)[0];
}

const day = 86_400_000;
const dateNumber = (date: string) => Date.parse(date + 'T00:00:00Z') / day;
const dateKey = (number: number) => new Date(number * day).toISOString().slice(0, 10);
function trend(days: Map<number, Counts>, range: DateRange) {
  const observed = [...days.keys()].sort((a, b) => a - b);
  if (!observed.length) return { bucketDays: 1, buckets: [] };
  const from = range.from ? dateNumber(range.from) : observed[0];
  const to = range.to ? dateNumber(range.to) : observed[observed.length - 1];
  const span = to - from + 1;
  // 宽日期范围仍保持刻度可读，空区间保留为缺口而非 0%。
  const bucketDays = span <= 8 ? 1 : Math.ceil(span / 84) * 7;
  const buckets = Array.from({ length: Math.ceil(span / bucketDays) }, () => emptyCounts());
  for (const [date, values] of days) {
    const bucket = buckets[Math.floor((date - from) / bucketDays)];
    if (!bucket) continue;
    bucket.success += values.success;
    bucket.unverified += values.unverified;
    bucket.failed += values.failed;
    bucket.durationSum += values.durationSum;
    bucket.durationCount += values.durationCount;
  }
  return {
    bucketDays,
    buckets: buckets.map((counts, index) => {
      const first = from + index * bucketDays;
      return {
        from: dateKey(first),
        to: dateKey(Math.min(first + bucketDays - 1, to)),
        ...summarize(counts),
      };
    }),
  };
}

export function deployStats(
  history: readonly History[],
  tasks: readonly TaskSummary[],
  scope: HistoryScope,
) {
  const totals = emptyCounts();
  const excluded = {
    rollback: 0,
    dryRun: 0,
    interrupted: 0,
    unknown: 0,
    cancelled: 0,
    skipped: 0,
    buildFailed: 0,
  };
  const byService = new Map<string, { name: string; time: string; counts: Counts }>();
  const byDay = new Map<number, Counts>();
  const reasons = new Map<string, number>();
  const taskTargets = new Set<string>();
  for (const record of history) {
    if (
      !matchesHistoryScope(record.service.id, record.time, scope) ||
      !matchesHistoryTarget(record.server.id, record.target.name, scope)
    )
      continue;
    const key = JSON.stringify([record.taskId, record.target.id]);
    if (taskTargets.has(key)) continue;
    taskTargets.add(key);
    if (record.operation === 'rollback' || record.status === 'rolledback') {
      excluded.rollback++;
      continue;
    }
    const status = record.status;
    if (status === 'unknown' || status === 'cancelled' || status === 'skipped') {
      excluded[status]++;
      continue;
    }
    if (status !== 'success' && status !== 'unverified' && status !== 'failed') continue;
    add(totals, status, record.elapsed);
    let service = byService.get(record.service.id);
    if (!service) {
      service = { name: record.service.name, time: record.time, counts: emptyCounts() };
      byService.set(record.service.id, service);
    } else if (record.time > service.time) {
      service.name = record.service.name;
      service.time = record.time;
    }
    add(service.counts, status, record.elapsed);
    const date = dateNumber(fmtTime(record.time).slice(0, 10));
    if (Number.isFinite(date)) {
      const daily = byDay.get(date) || emptyCounts();
      add(daily, status, record.elapsed);
      byDay.set(date, daily);
    }
    if (status === 'failed') {
      const reason = failureReason(record);
      reasons.set(reason, (reasons.get(reason) || 0) + 1);
    }
  }
  // 试运行与构建失败没有目标历史。取消、跳过和未核实的目标可能只存在于任务摘要。
  for (const task of tasks) {
    if (
      task.maintenance ||
      task.uncertain ||
      !matchesHistoryScope(task.serviceId || task.service, task.started, scope)
    )
      continue;
    const targets = (task.targets || []).filter((target) =>
      matchesHistoryTarget(target.serverId, target.name, scope),
    );
    if (!targets.length && (scope.server !== 'all' || scope.environment !== 'all')) continue;
    if (task.dryRun) {
      excluded.dryRun++;
      continue;
    }
    if (task.status === 'interrupted') excluded.interrupted++;
    if (task.operation !== 'deploy') continue;
    if (task.buildFailed) {
      excluded.buildFailed++;
      continue;
    }
    for (const target of targets) {
      if (taskTargets.has(JSON.stringify([task.id, target.id]))) continue;
      if (
        target.status === 'unknown' ||
        target.status === 'skipped' ||
        target.status === 'cancelled'
      ) {
        excluded[target.status]++;
      }
    }
  }
  return {
    ...summarize(totals),
    ...trend(byDay, scope.date),
    excluded,
    services: [...byService]
      .map(([id, { name, counts }]) => ({ id, name, ...summarize(counts) }))
      .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'zh-CN')),
    failures: [...reasons]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason, 'zh-CN')),
  };
}
