import { serverAddress, remoteJar, type Database, type History, type Task } from './model';
import { toHistory } from './engine';
import { knownCommit } from './presentation';
export function canRollback(db: Database, h: History): boolean {
  const current = db.targets.find((t) => t.id === h.target.id),
    server = current && db.servers.find((s) => s.id === current.serverId);
  return (
    h.status !== 'unknown' &&
    h.backupCreated &&
    !h.backupRemoved &&
    !!h.backupPath &&
    !!current &&
    !!server &&
    remoteJar(current) === remoteJar(h.target) &&
    current.mode === h.target.mode &&
    current.container === h.target.container &&
    current.containerJar === h.target.containerJar &&
    serverAddress(server) === serverAddress(h.server)
  );
}
export function pruneHistory(db: Database): Database {
  const history = [...db.history]
      .sort((a, b) => Date.parse(b.time) - Date.parse(a.time))
      .slice(0, db.settings.historyLimit),
    ids = new Set(history.map((h) => h.taskId));
  return {
    ...db,
    history,
    taskHistory: Object.fromEntries(Object.entries(db.taskHistory).filter(([id]) => ids.has(id))),
  };
}
export function recordTask(db: Database, task: Task, updateTargets = true): Database {
  if (
    db.history.some((h) => h.taskId === task.id) &&
    !db.history.some((h) => h.taskId === task.id && h.status === 'unknown')
  )
    return db;
  const history = toHistory(task);
  return pruneHistory({
    ...db,
    history: [...history, ...db.history.filter((h) => h.taskId !== task.id)],
    taskHistory: history.length
      ? {
          ...db.taskHistory,
          [task.id]: {
            id: task.id,
            buildLogs: [...task.buildLogs],
            buildSteps: structuredClone(task.buildSteps),
            elapsed: task.elapsed,
            started: task.started,
          },
        }
      : db.taskHistory,
    targets: db.targets.map((t) => {
      const r = task.targets.find((r) => r.target.id === t.id);
      return updateTargets && r && ['success', 'unverified', 'rolledback'].includes(r.status)
        ? {
            ...t,
            version:
              r.status === 'rolledback'
                ? r.backupVersion || t.version
                : task.deployedVersion || task.service.git.commit,
            currentHash:
              r.status === 'rolledback'
                ? r.backupHash || t.currentHash
                : task.artifact.sha256 || t.currentHash,
            currentCommit:
              r.status === 'rolledback'
                ? knownCommit(r.backupVersion, r.backupHash)
                : task.deployedCommit || knownCommit(task.deployedVersion, task.artifact.sha256),
            lastDeploy: new Date(task.started).toISOString(),
            healthState:
              r.status === 'unverified' || r.target.health.type === 'none'
                ? '未配置健康检查'
                : '上次检查通过',
          }
        : t;
    }),
  });
}
export function historyLogs(db: Database, h: History): string[] {
  return [
    '=== 构建日志 ===',
    ...(db.taskHistory[h.taskId]?.buildLogs || []),
    '=== 目标日志 ===',
    ...h.logs,
  ];
}
