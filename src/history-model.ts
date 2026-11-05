import type { Database, Task } from './model';
import type { TaskSummary } from './platform';
export function summarizeTask(task: Task): TaskSummary {
  return {
    id: task.id,
    service: task.service.name,
    serviceId: task.service.id,
    operation: task.operation,
    status: task.status,
    started: task.started,
    elapsed: task.elapsed,
    dryRun: task.dryRun,
    note: task.note,
    jarHash: task.artifact.sha256,
    commit: task.deployedCommit,
    buildFailed: task.buildSteps.some((s) => s.status === 'failed'),
    targets: task.targets.map((r) => ({
      id: r.target.id,
      name: r.target.name,
      serverId: r.server.id,
      server: r.server.name,
      status: r.status,
      elapsed: r.elapsed,
    })),
  };
}
export function importedSummaries(db: Database, existing: Set<string>): TaskSummary[] {
  const groups = new Map<string, Database['history']>();
  for (const h of db.history)
    if (!existing.has(h.taskId)) groups.set(h.taskId, [...(groups.get(h.taskId) || []), h]);
  return [...groups.entries()].map(([id, group]) => {
    const first = group[0],
      allGood = group.every((h) => ['success', 'unverified'].includes(h.status)),
      someGood = group.some((h) => ['success', 'unverified'].includes(h.status));
    return {
      id,
      service: first.service.name,
      serviceId: first.service.id,
      operation: first.operation,
      status: group.some((h) => h.status === 'unknown')
        ? 'interrupted'
        : allGood
          ? 'success'
          : someGood
            ? 'partial'
            : 'failed',
      started: first.time,
      elapsed: db.taskHistory[id]?.elapsed || Math.max(...group.map((h) => h.elapsed)),
      note: first.note,
      jarHash: first.artifact.sha256,
      commit: first.deployedCommit,
      imported: true,
      targets: group.map((h) => ({
        id: h.target.id,
        name: h.target.name,
        server: h.server.name,
        serverId: h.server.id,
        elapsed: h.elapsed,
        status: h.status,
      })),
    };
  });
}
