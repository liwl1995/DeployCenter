import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import Sqlite from 'better-sqlite3';
import type { Database, Task } from '../src/model';
import type { HistorySearchResult, SearchHit, MaintenanceRecord } from '../src/features';

/** 独立线程只读 SQLite 后立即关闭连接，避免长时间读事务妨碍主进程备份和迁移。 */
export async function scanHistory(directory: string, query: string): Promise<HistorySearchResult> {
  if (!query.trim() || query.length > 200) throw new Error('请输入 1–200 字的搜索内容');
  const needle = query.toLocaleLowerCase(),
    result: HistorySearchResult = { hits: [], total: 0, warnings: [] };
  const sql = new Sqlite(path.join(directory, 'deploy-center.sqlite'), {
    readonly: true,
    fileMustExist: true,
  });
  let audits: { json: string }[] = [];
  let rows: { json: string }[], config: Database | undefined;
  try {
    rows = sql.prepare('SELECT json FROM tasks ORDER BY updated DESC').all() as { json: string }[];
    if (
      sql
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='maintenance_events'")
        .get()
    )
      audits = sql.prepare('SELECT json FROM maintenance_events ORDER BY at DESC').all() as {
        json: string;
      }[];
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
  const add = (hit: SearchHit) => {
    result.total++;
    if (result.hits.length < 200) result.hits.push({ ...hit, text: hit.text.slice(0, 500) });
  };
  const matches = (text: string) => text.toLocaleLowerCase().includes(needle);
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
          if (matches(text))
            add({
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
      task = JSON.parse(row.json);
      if (
        typeof task.id !== 'string' ||
        typeof task.service?.name !== 'string' ||
        !Array.isArray(task.targets) ||
        !task.targets.every(
          (r) =>
            typeof r.target?.id === 'string' &&
            typeof r.target?.name === 'string' &&
            typeof r.server?.name === 'string',
        )
      )
        throw new Error();
    } catch {
      result.warnings.push('已跳过格式异常的任务记录。');
      continue;
    }
    ids.add(task.id);
    for (const [section, value] of [
      ['服务', task.service.name],
      ['本次内容', task.note || ''],
    ] as const)
      if (matches(value)) add({ taskId: task.id, section, text: value });
    for (const run of task.targets)
      for (const [section, value] of [
        ['环境', run.target.name],
        ['服务器', [run.server.name, run.server.host, run.server.alias].join(' ')],
      ] as const)
        if (matches(value)) add({ taskId: task.id, targetId: run.target.id, section, text: value });
    await log(task);
    for (const run of task.targets) await log(task, run.target.id);
  }
  for (const row of audits) {
    try {
      const audit: MaintenanceRecord = JSON.parse(row.json);
      const text = [
        audit.targetName,
        audit.serverName,
        audit.message,
        ...audit.requested.map((f) => f.path),
      ].join(' · ');
      if (matches(text)) add({ taskId: audit.id, section: '备份清理记录', text });
      await log(audit);
    } catch {
      result.warnings.push('部分备份清理记录无法读取，原记录已保留。');
    }
  }
  // 普通配置导入没有 tasks 表行，仍能检索历史快照；不会伪造完整日志。
  for (const history of Array.isArray(config?.history) ? config!.history : [])
    if (
      typeof history.service?.name === 'string' &&
      typeof history.target?.name === 'string' &&
      typeof history.server?.name === 'string' &&
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
      if (matches(text))
        add({ taskId: history.taskId, targetId: history.target.id, section: '导入历史', text });
    }
  result.warnings = [...new Set(result.warnings)];
  return result;
}
if (!isMainThread)
  void scanHistory(workerData.directory, workerData.query)
    .then((result) => parentPort!.postMessage({ result }))
    .catch((e) => parentPort!.postMessage({ error: String(e) }));
