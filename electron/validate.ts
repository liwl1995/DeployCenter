import path from 'node:path';
import { z } from 'zod';
import { validDatabase, type Database } from '../src/model';
import type { Approval, PrepareRequest } from '../src/platform';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const backup = z.object({
  enabled: z.boolean(),
  directory: z.string().max(2048),
  template: z.string().min(1).max(220),
  autoRollback: z.boolean(),
});
export const prepareSchema = z.object({
  serviceId: id,
  targetIds: z
    .array(id)
    .min(1)
    .max(100)
    .refine((a) => new Set(a).size === a.length, '部署目标重复'),
  build: z.enum(['rebuild', 'existing']),
  jarPath: z.string().max(32760).optional(),
  overrides: z.record(z.string(), backup),
  failurePolicy: z.enum(['stop', 'continue']),
  historyId: z.string().max(150).optional(),
  dryRun: z.boolean().optional(),
});
export const approvalSchema = z.object({
  productionWord: z.string().max(30),
  allowWeak: z.boolean(),
  protectCurrent: z.boolean(),
});
export const credentialsSchema = z.record(z.string(), z.string().max(8192));
export const parsePrepare = (v: unknown): PrepareRequest => prepareSchema.parse(v);
export const parseApproval = (v: unknown): Approval => approvalSchema.parse(v);
const clean = (s: string, label: string) => {
  if (/[\r\n\0]/.test(s)) throw new Error(label + '不能包含控制字符');
};
export function validateDatabase(v: unknown): Database {
  if (!validDatabase(v)) throw new Error('配置版本、字段或引用关系无效');
  for (const s of v.services) {
    id.parse(s.id);
    if (!s.name.trim()) throw new Error('服务名称不能为空');
    for (const p of [s.root, s.workDir, s.jarDir, s.jarName, s.mavenPath]) clean(p, '本地路径');
    if (!path.isAbsolute(s.root)) throw new Error('项目根目录必须是本机绝对路径');
    if (!/^[^/\\\0\r\n]+\.jar$/i.test(s.jarName)) throw new Error('本地 JAR 文件名无效');
    if (
      s.buildTimeout !== undefined &&
      (!Number.isInteger(s.buildTimeout) || s.buildTimeout < 30 || s.buildTimeout > 86400)
    )
      throw new Error('构建超时应为 30–86400 秒');
    if (s.args.length > 32760) throw new Error('构建参数过长');
  }
  for (const s of v.servers) {
    id.parse(s.id);
    clean(s.alias, 'SSH 别名');
    clean(s.host, '主机');
    clean(s.user, '用户名');
    if (
      s.auth === 'alias'
        ? !s.alias || s.alias.startsWith('-') || /\s/.test(s.alias)
        : !s.host || !s.user || /\s/.test(s.host) || /\s/.test(s.user)
    )
      throw new Error('服务器地址、用户名或 SSH 别名无效');
  }
  for (const t of v.targets) {
    id.parse(t.id);
    if (!t.directory.startsWith('/') || t.directory === '/')
      throw new Error('远程目录必须是非根目录的绝对路径');
    clean(t.directory, '远程目录');
    clean(t.fileName, '远程文件名');
    clean(t.container, '容器名');
    clean(t.containerJar, '容器内路径');
    if (!/^[^/\\\0\r\n]+\.jar$/i.test(t.fileName)) throw new Error('远程 JAR 文件名无效');
    if (
      t.mode === 'docker'
        ? !t.container || t.container.startsWith('-') || !t.containerJar.startsWith('/')
        : !t.start.trim() && !t.restart.trim()
    )
      throw new Error('请配置容器和容器内路径，或 JAR 启动命令');
    if (t.health.type === 'http' && !/^https?:\/\//i.test(t.health.value))
      throw new Error('HTTP 检查地址必须以 http:// 或 https:// 开头');
    if (t.health.type === 'tcp' && !/^(?:\[[^\]]+\]|[^:]+):\d+$/.test(t.health.value))
      throw new Error('TCP 检查地址须为 host:port');
    if (
      t.commandTimeout !== undefined &&
      (!Number.isInteger(t.commandTimeout) || t.commandTimeout < 5 || t.commandTimeout > 3600)
    )
      throw new Error('远程命令超时应为 5–3600 秒');
    if (
      t.stabilitySeconds !== undefined &&
      (!Number.isInteger(t.stabilitySeconds) || t.stabilitySeconds < 1 || t.stabilitySeconds > 300)
    )
      throw new Error('容器稳定性观察应为 1–300 秒');
    if (t.health.location !== undefined) z.enum(['local', 'remote']).parse(t.health.location);
    for (const k of ['timeout', 'retries', 'interval'] as const)
      if (t.health[k] > (k === 'retries' ? 100 : 3600) || !Number.isInteger(t.health[k]))
        throw new Error('健康检查次数或时间超出范围');
    validateBackup(t.backup);
  }
  if (v.settings.historyDays !== undefined)
    z.number().int().min(0).max(3650).parse(v.settings.historyDays);
  if (v.settings.staleLockMinutes !== undefined)
    z.number().int().min(1).max(10080).parse(v.settings.staleLockMinutes);
  return v;
}
export function validateBackup(value: unknown) {
  const b = backup.parse(value);
  clean(b.directory, '备份目录');
  clean(b.template, '备份文件名');
  if (
    /[\/\\]/.test(b.template) ||
    /\{(?!name\}|jarName\}|yyyyMMdd-HHmmss\}|task\})[^}]*\}/.test(b.template)
  )
    throw new Error('备份模板含未知变量或路径分隔符');
  return b;
}
