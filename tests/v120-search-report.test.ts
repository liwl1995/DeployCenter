// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Storage } from '../electron/storage';
import { scanHistory } from '../electron/history-search';
import { deploymentReport } from '../src/report';
import { MemoryCredentials } from '../electron/native-capabilities';
import { createTask } from '../src/engine';
import { seed } from '../src/model';
const created: { dir: string; store: Storage }[] = [];
afterEach(async () => {
  for (const { dir, store } of created.splice(0)) {
    await store.settle();
    store.close();
    if (!dir.startsWith(path.resolve('.test-data') + path.sep)) throw new Error('测试目录越界');
    await fs.rm(dir, { recursive: true, force: true });
  }
});
async function fixture() {
  const base = path.resolve('.test-data');
  await fs.mkdir(base, { recursive: true });
  const dir = await fs.mkdtemp(path.join(base, 'history-search-'));
  const store = new Storage(dir, {
    encrypt: async (s) => Buffer.from(s),
    decrypt: async (b) => b.toString(),
  });
  created.push({ dir, store });
  const db = seed();
  db.history = [];
  db.taskHistory = {};
  store.saveConfig(db);
  await store.settle();
  const task = createTask(db, db.services[0], [db.targets[0]], {}, 'existing');
  task.id = 'DC-full-search';
  task.status = 'failed';
  task.targets[0].status = 'failed';
  task.note = '本次优化 客户中文关键词';
  task.buildSteps[0].elapsed = 27.2;
  store.saveTask(task);
  return { dir, store, task };
}
it('全文搜索覆盖备注、服务、环境、服务器和完整日志，返回命中位置且限制展示200处', async () => {
  const { dir, store, task } = await fixture();
  store.appendLog(
    task.id,
    Array.from({ length: 10000 }, (_, i) => '构建输出 行号' + i).join('\n') + '\n',
  );
  store.appendLog(task.id, '目标日志独有词\n', task.targets[0].target.id);
  expect((await scanHistory(dir, '中文关键词')).hits[0].section).toBe('本次内容');
  expect((await scanHistory(dir, task.service.name)).hits[0].section).toBe('服务');
  store.recordMaintenance({
    id: 'DC-CLEAN-search',
    targetId: task.targets[0].target.id,
    targetName: '清理测试环境',
    serverId: task.targets[0].server.id,
    serverName: '备份专用服务器',
    connection: 'fixture',
    directory: '/backups',
    time: new Date().toISOString(),
    status: 'unknown',
    requested: [],
    deleted: [],
    message: '清理审计独有词',
  });
  expect((await scanHistory(dir, '清理审计独有词')).hits[0]).toMatchObject({
    taskId: 'DC-CLEAN-search',
    section: '备份清理记录',
  });
  const target = await scanHistory(dir, '目标日志独有词');
  expect(target.hits[0]).toMatchObject({
    taskId: task.id,
    targetId: task.targets[0].target.id,
    section: '目标日志',
    line: 1,
  });
  const full = await scanHistory(dir, '构建输出');
  expect(full.total).toBe(10000);
  expect(full.hits).toHaveLength(200);
  expect(full.hits[0].line).toBe(1);
  expect(
    (await scanHistory(dir, task.targets[0].server.name)).hits.some((h) => h.section === '服务器'),
  ).toBe(true);
  await expect(scanHistory(dir, '')).rejects.toThrow('1–200');
});
it('Markdown报告包括备注、版本、备份、步骤和摘要，敏感字段不投影且日志不能破坏代码围栏', async () => {
  const { task } = await fixture(),
    secret = 'fixture-password';
  task.note = '说明 password=' + secret;
  task.deployedCommit = 'a'.repeat(40);
  task.artifact.sha256 = 'b'.repeat(64);
  task.targets[0].backupCreated = true;
  task.targets[0].backupPath = '/backup/app.jar';
  Object.assign(task, { credentials: { password: secret } });
  const redactor = new MemoryCredentials({ active: secret });
  const report = deploymentReport(
    task,
    {
      build: ['[ERROR] password=' + secret, '```\n<script>malicious()</script>'],
      targets: { [task.targets[0].target.id]: ['目标日志'] },
    },
    (s) => redactor.redact(s),
  );
  redactor.clear();
  expect(report).toContain('27.2 秒');
  expect(report).toContain(task.deployedCommit);
  expect(report).toContain('/backup/app.jar');
  expect(report).toContain('本次内容');
  expect(report).toContain('目标日志');
  expect(report).not.toContain(secret);
  expect(report).not.toContain('credentials');
  expect(report).toContain('````text');
});
