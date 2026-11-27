import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import Sqlite from 'better-sqlite3';
import type { Database, Task } from '../src/model';
import type { HistorySearchResult, HistorySearchScope, SearchHit, MaintenanceRecord } from '../src/features';
import { backupCleanupService, unreadableTaskNote, unreadableTaskService } from '../src/history-model';
import { parseTaskRecord } from './task-record';

type SearchRow = { id: string; json: string };

/** 独立线程只读 SQLite 后立即关闭连接，避免长时间读事务妨碍主进程备份和迁移。 */
export async function scanHistory(
  directory: string,
  query: string,
  scope?: HistorySearchScope,
): Promise<HistorySearchResult> {
  const term = query.trim();
  if (!term || term.length > 200) throw new Error('请输入 1–200 字的搜索内容');
  const needle = term.toLocaleLowerCase();
  const result: HistorySearchResult = { taskIds: [], hits: [], total: 0, warnings: [] };
  const scopedIds = scope && new Set(scope.taskIds);
  if (scopedIds?.size === 0) return result;
  // 通过一个参数传入列表，避免大量任务超出 SQLite 的参数个数限制。
  const where = scopedIds ? ' WHERE id IN (SELECT value FROM json_each(?))' : '';
  const params = scopedIds ? [JSON.stringify([...scopedIds])] : [];
  const sql = new Sqlite(path.join(directory, 'deploy-center.sqlite'), {
    readonly: true,
    fileMustExist: true,
  });
  let audits: SearchRow[] = [];
  let rows: SearchRow[], config: Database | undefined;
  try {
    rows = sql.prepare('SELECT id,json FROM tasks' + where + ' ORDER BY updated DESC')
      .all(...params) as SearchRow[];
    if (
      sql
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='maintenance_events'")
        .get()
    )
      audits = sql.prepare('SELECT id,json FROM maintenance_events' + where + ' ORDER BY at DESC')
        .all(...params) as SearchRow[];
    const saved = sql.prepare('SELECT json FROM config WHERE id=1').get() as
      | { json: string }
      | undefined;
    if (saved)
      try {
        config = JSON.parse(saved.json);
      } catch {
        result.warnings.push('配置元数据无法读取，仅搜索任务和日志。');
      }
  } finally {
    sql.close();
  }
  const matchedTasks = new Set<string>();
  const match = (hit: SearchHit) => {
    const index = hit.text.toLocaleLowerCase().indexOf(needle);
    if (index < 0) return;
    matchedTasks.add(hit.taskId);
    result.total++;
    if (result.hits.length >= 200) return;
    const start = Math.max(0, index - 120);
    const end = start + 498;
    const text = (start > 0 ? '…' : '') + hit.text.slice(start, end) + (end < hit.text.length ? '…' : '');
    result.hits.push({ ...hit, text });
  };
  const matchesTarget = (serverId: string, environment: string) =>
    (scope?.serverId === undefined || serverId === scope.serverId) &&
    (scope?.environment === undefined || environment === scope.environment);
  const ids = new Set<string>();
  const log = async (task: Pick<Task, 'id'>, targetId?: string) => {
    if (!/^DC-[a-zA-Z0-9-]+$/.test(task.id) || (targetId && !/^[a-zA-Z0-9_-]+$/.test(targetId)))
      return;
    const file = path.join(directory, 'logs', task.id, targetId ? targetId + '.log' : 'build.log');
    try {
      for (const item of [path.join(directory, 'logs'), path.dirname(file), file])
        if ((await fsp.lstat(item)).isSymbolicLink()) throw new Error('链接日志不可读取');
      const stream = fs.createReadStream(file, { encoding: 'utf8' }),
        reader = createInterface({ input: stream, crlfDelay: Infinity });
      let line = 0,
        failure: Error | undefined;
      stream.on('error', (error) => {
        failure = error;
        reader.close();
      });
      try {
        for await (const text of reader) {
          line++;
          match({
            taskId: task.id,
            targetId,
            section: targetId ? '目标日志' : '构建日志',
            line,
            text,
          });
        }
        if (failure) throw failure;
      } finally {
        reader.close();
        stream.destroy();
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
        result.warnings.push('部分日志不可读取或为链接，已跳过：' + task.id);
    }
  };
  for (const row of rows!) {
    let task: Task;
    try {
      task = parseTaskRecord(row.json, row.id);
    } catch {
      result.warnings.push('已跳过格式异常的任务记录。');
      if (scope?.serverId === undefined && scope?.environment === undefined)
        match({
          taskId: row.id,
          section: unreadableTaskService,
          text: unreadableTaskService + ' · ' + unreadableTaskNote,
        });
      continue;
    }
    ids.add(task.id);
    const targets = task.targets.filter((run) => matchesTarget(run.server.id, run.target.name));
    if (!targets.length && (scope?.serverId !== undefined || scope?.environment !== undefined))
      continue;
    for (const [section, text] of [
      ['服务', task.service.name],
      ['本次内容', typeof task.note === 'string' ? task.note : ''],
    ] as const)
      match({ taskId: task.id, section, text });
    for (const run of targets)
      for (const [section, text] of [
        ['环境', run.target.name],
        ['服务器', [run.server.name, run.server.host, run.server.alias].join(' ')],
      ] as const)
        match({ taskId: task.id, targetId: run.target.id, section, text });
    await log(task);
    for (const run of targets) await log(task, run.target.id);
  }
  for (const row of audits) {
    try {
      const audit: MaintenanceRecord = JSON.parse(row.json);
      if (audit.id !== row.id) throw new Error('备份清理记录编号不一致');
      if (!matchesTarget(audit.serverId, audit.targetName)) continue;
      const text = [
        backupCleanupService,
        audit.targetName,
        audit.serverName,
        audit.message,
        ...audit.requested.map((f) => f.path),
      ].join(' · ');
      match({ taskId: audit.id, section: '备份清理记录', text });
      await log(audit);
    } catch {
      result.warnings.push('部分备份清理记录无法读取，原记录已保留。');
    }
  }
  // 普通配置导入没有 tasks 表行，仍能检索历史快照；不会伪造完整日志。
  for (const history of Array.isArray(config?.history) ? config!.history : [])
    if (
      (!scopedIds || scopedIds.has(history.taskId)) &&
      typeof history.service?.name === 'string' &&
      typeof history.target?.name === 'string' &&
      typeof history.server?.name === 'string' &&
      matchesTarget(history.server.id, history.target.name) &&
      !ids.has(history.taskId)
    ) {
      const text = [
        history.service.name,
        history.target.name,
        history.server.name,
        history.server.host,
        history.note || '',
        ...(history.logs || []),
      ].join(' · ');
      match({ taskId: history.taskId, targetId: history.target.id, section: '导入历史', text });
    }
  result.taskIds = [...matchedTasks];
  result.warnings = [...new Set(result.warnings)];
  return result;
}
if (!isMainThread)
  void scanHistory(workerData.directory, workerData.query, workerData.scope)
    .then((result) => parentPort!.postMessage({ result }))
    .catch((e) => parentPort!.postMessage({ error: String(e) }));
