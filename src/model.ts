export type Mode = 'jar' | 'docker';
export type Health = {
  type: 'none' | 'http' | 'tcp' | 'command';
  location?: 'local' | 'remote';
  value: string;
  timeout: number;
  retries: number;
  interval: number;
  /** 启动校验通过后的静默等待；缺省兼容旧配置。 */
  startDelay?: number;
  /** 静默等待之后的就绪探测窗口；设置后不再由重试次数提前结束。 */
  maxWait?: number;
};
export type Backup = {
  enabled: boolean;
  directory: string;
  template: string;
  autoRollback: boolean;
};
export type Server = {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  auth: 'alias' | 'password' | 'key';
  alias: string;
  keyPath: string;
  note: string;
  credentialMode: 'ask' | 'windows';
  sshConfigFile?: string;
};
export type Service = {
  id: string;
  name: string;
  code: string;
  description: string;
  root: string;
  workDir: string;
  tool: 'wrapper' | 'maven' | 'auto';
  mavenPath: string;
  jdk: string;
  args: string;
  profiles: string;
  jarDir: string;
  jarName: string;
  git: { branch: string; commit: string; time: string; dirty?: boolean };
  buildTimeout?: number;
  logEncoding?: 'auto' | 'utf8' | 'gb18030';
};
export type Target = {
  id: string;
  serviceId: string;
  serverId: string;
  name: string;
  production: boolean;
  directory: string;
  fileName: string;
  mode: Mode;
  stop: string;
  start: string;
  restart: string;
  chmod: boolean;
  stopFailure: 'fail' | 'warn';
  container: string;
  containerJar: string;
  mount: 'directory' | 'file';
  health: Health;
  backup: Backup;
  createDirectory: boolean;
  hashPolicy: 'required' | 'size-confirm';
  hasOldJar: boolean;
  version: string;
  currentHash?: string;
  lastDeploy: string;
  healthState: string;
  commandTimeout?: number;
  stabilitySeconds?: number;
};
export type Settings = {
  failurePolicy: 'stop' | 'continue';
  theme: 'system' | 'light' | 'dark';
  allowMavenNonzero: boolean;
  historyLimit: number;
  historyDays?: number;
  staleLockMinutes?: number;
  demoMode: boolean;
};
export type Artifact = {
  name: string;
  size: number;
  modified: string;
  exists: boolean;
  path: string;
  source: 'sample' | 'file' | 'unknown' | 'remote';
  sha256?: string;
  originalPath?: string;
};
export type Step = {
  key: string;
  label: string;
  critical?: boolean;
  startedAt?: number;
  endedAt?: number;
  elapsed?: number;
  status?: 'pending' | 'running' | 'success' | 'failed' | 'skipped';
};
export type BuildContext = {
  tool: string;
  command: string;
  workDir: string;
  jdk: string;
  jdkPath: string;
  jarPath: string;
};
export type TaskRecord = {
  id: string;
  buildLogs: string[];
  buildSteps: Step[];
  elapsed: number;
  started: string;
};
export type ServiceSnapshot = Pick<Service, 'id' | 'name' | 'git'>;
export type TargetSnapshot = Pick<
  Target,
  | 'id'
  | 'serverId'
  | 'name'
  | 'directory'
  | 'fileName'
  | 'mode'
  | 'container'
  | 'containerJar'
  | 'version'
>;
export type ServerSnapshot = Pick<
  Server,
  'id' | 'name' | 'auth' | 'alias' | 'host' | 'port' | 'user'
>;
export type TargetStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'unverified'
  | 'failed'
  | 'rollingback'
  | 'rolledback'
  | 'cancelled'
  | 'skipped'
  | 'unknown';
export type RunTarget = {
  target: Target;
  server: Server;
  backup: Backup;
  plannedBackupPath: string;
  backupPath?: string;
  backupCreated: boolean;
  backupHash?: string;
  backupSize?: number;
  backupVersion?: string;
  startedAt?: number;
  endedAt?: number;
  upload: { bytes: number; total: number; percent: number; speed: number };
  hashMismatch: boolean;
  remote?: {
    jobDir: string;
    lockDir: string;
    stagePath: string;
    journalOffset: number;
    logOffset: number;
    phase: 'prepared' | 'launching' | 'running' | 'complete';
  };
  status: TargetStatus;
  phase: number;
  steps: Step[];
  logs: string[];
  fail: boolean;
  elapsed: number;
  error?: string;
  recovery?: string;
};
export type Task = {
  id: string;
  operation: 'deploy' | 'rollback';
  service: Service;
  artifact: Artifact;
  build: 'rebuild' | 'existing';
  targets: RunTarget[];
  failurePolicy: Settings['failurePolicy'];
  status: 'running' | 'cancelling' | 'success' | 'partial' | 'failed' | 'cancelled' | 'interrupted';
  buildPhase: number;
  buildSteps: Step[];
  buildContext: BuildContext;
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
  buildLogs: string[];
  active: number;
  started: string;
  elapsed: number;
  sourceBackup?: string;
  protectCurrent: boolean;
  deployedVersion?: string;
  dryRun?: boolean;
};
export type History = {
  id: string;
  taskId: string;
  operation: Task['operation'];
  service: ServiceSnapshot;
  target: TargetSnapshot;
  server: ServerSnapshot;
  artifact: Artifact;
  build: Task['build'];
  status: TargetStatus;
  time: string;
  elapsed: number;
  backupPath?: string;
  backupCreated: boolean;
  backupHash?: string;
  backupSize?: number;
  backupVersion?: string;
  steps: Step[];
  logs: string[];
  error?: string;
  recovery?: string;
};
export type Database = {
  schema: 3;
  services: Service[];
  servers: Server[];
  targets: Target[];
  jdks: { name: string; path: string }[];
  settings: Settings;
  history: History[];
  taskHistory: Record<string, TaskRecord>;
  lastService: string;
  lastTargets: string[];
};

import { seed } from './demo';
export { seed };
export function localJar(service: Service) {
  return /^[a-zA-Z]:[\\/]|^\\\\/.test(service.jarDir)
    ? `${service.jarDir}\\${service.jarName}`
    : `${service.root}\\${service.jarDir}\\${service.jarName}`;
}
export function artifactFor(service: Service): Artifact {
  return {
    name: service.jarName,
    size: service.id === 'crm' ? 84211200 : 54881280,
    modified: '2026-11-03T10:00:00+08:00',
    exists: true,
    path: localJar(service),
    source: 'sample',
  };
}
export const remoteJar = (t: Pick<Target, 'directory' | 'fileName'>) =>
  `${t.directory.replace(/\/$/, '')}/${t.fileName}`;
export const serverAddress = (s: ServerSnapshot) =>
  s.auth === 'alias' ? s.alias : `${s.user}@${s.host}:${s.port}`;
export const modeLabel = (mode: Mode) => (mode === 'docker' ? 'Docker JAR' : '普通 JAR');
export const statusLabel: Record<TargetStatus, string> = {
  pending: '等待执行',
  running: '正在部署',
  success: '检查通过',
  unverified: '启动成功 · 健康未验证',
  failed: '部署失败',
  rollingback: '正在回滚',
  rolledback: '失败 · 已回滚',
  cancelled: '已取消',
  skipped: '已跳过',
  unknown: '待核实 · 远端状态未知',
};
export const fmtTime = (value: string) =>
  new Date(value).toLocaleString('zh-CN', { hour12: false });
export const shellQuote = (v: string) => "'" + v.replace(/'/g, "'\\''") + "'";
export function backupPath(t: Target, b: Backup, taskId: string, date = new Date()) {
  const stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}-${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')}${String(date.getSeconds()).padStart(2, '0')}`;
  const name = b.template
    .replaceAll('{name}', t.fileName.replace(/\.jar$/i, ''))
    .replaceAll('{jarName}', t.fileName)
    .replaceAll('{yyyyMMdd-HHmmss}', stamp)
    .replaceAll('{task}', taskId);
  const dir = b.directory.startsWith('/')
    ? b.directory
    : `${t.directory}/${b.directory || 'backups'}`;
  return `${dir.replace(/\/$/, '')}/${name}`;
}
export type Recovery = { raw: string; backupKey?: string };
export function loadDatabase(): { database: Database; recovery?: Recovery } {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem('deploy-center-v2');
    if (raw === null) return { database: seed() };
    const data = JSON.parse(raw);
    if (validDatabase(data)) {
      data.lastTargets = data.lastTargets.filter((id) =>
        data.targets.some((t) => t.id === id && !t.production),
      );
      return { database: data };
    }
  } catch {
    /* 保留原键；损坏数据不能被示例配置覆盖。 */
  }
  const recovery: Recovery = { raw: raw ?? '' };
  try {
    let stamp = Date.now();
    while (localStorage.getItem('deploy-center-v2.backup-' + stamp) !== null) stamp++;
    const key = 'deploy-center-v2.backup-' + stamp;
    localStorage.setItem(key, recovery.raw);
    recovery.backupKey = key;
  } catch {
    /* 配额不足时仍保留内存副本及原键，允许下载后由用户决定。 */
  }
  return { database: seed(), recovery };
}
export function snapshotService(s: Service): ServiceSnapshot {
  return { id: s.id, name: s.name, git: { ...s.git } };
}
export function snapshotTarget(t: Target): TargetSnapshot {
  return {
    id: t.id,
    serverId: t.serverId,
    name: t.name,
    directory: t.directory,
    fileName: t.fileName,
    mode: t.mode,
    container: t.container,
    containerJar: t.containerJar,
    version: t.version,
  };
}
export function snapshotServer(s: Server): ServerSnapshot {
  return {
    id: s.id,
    name: s.name,
    host: s.host,
    user: s.user,
    port: s.port,
    auth: s.auth,
    alias: s.alias,
  };
}
export function validDatabase(data: unknown): data is Database {
  const object = (v: unknown): v is Record<string, any> =>
    !!v && typeof v === 'object' && !Array.isArray(v);
  const strings = (v: unknown, keys: string[]) =>
    object(v) && keys.every((k) => typeof v[k] === 'string');
  const b = (v: unknown) =>
    object(v) &&
    strings(v, ['directory', 'template']) &&
    typeof v.enabled === 'boolean' &&
    typeof v.autoRollback === 'boolean';
  const service = (v: unknown) =>
    object(v) &&
    strings(v, [
      'id',
      'name',
      'code',
      'description',
      'root',
      'workDir',
      'mavenPath',
      'jdk',
      'args',
      'profiles',
      'jarDir',
      'jarName',
    ]) &&
    ['auto', 'wrapper', 'maven'].includes(v.tool) &&
    strings(v.git, ['branch', 'commit', 'time']) &&
    Number.isFinite(Date.parse(v.git.time));
  const server = (v: unknown) =>
    object(v) &&
    strings(v, ['id', 'name', 'host', 'user', 'alias', 'keyPath', 'note']) &&
    Number.isInteger(v.port) &&
    v.port > 0 &&
    v.port <= 65535 &&
    ['alias', 'password', 'key'].includes(v.auth) &&
    ['ask', 'windows'].includes(v.credentialMode);
  const target = (v: unknown) =>
    object(v) &&
    strings(v, [
      'id',
      'serviceId',
      'serverId',
      'name',
      'directory',
      'fileName',
      'stop',
      'start',
      'restart',
      'container',
      'containerJar',
      'version',
      'lastDeploy',
      'healthState',
    ]) &&
    ['jar', 'docker'].includes(v.mode) &&
    ['fail', 'warn'].includes(v.stopFailure) &&
    ['file', 'directory'].includes(v.mount) &&
    ['required', 'size-confirm'].includes(v.hashPolicy) &&
    ['production', 'chmod', 'createDirectory', 'hasOldJar'].every(
      (k) => typeof v[k] === 'boolean',
    ) &&
    b(v.backup) &&
    object(v.health) &&
    ['none', 'http', 'tcp', 'command'].includes(v.health.type) &&
    typeof v.health.value === 'string' &&
    (v.health.startDelay === undefined ||
      (Number.isInteger(v.health.startDelay) &&
        v.health.startDelay >= 0 &&
        v.health.startDelay <= 3600)) &&
    (v.health.maxWait === undefined ||
      (Number.isInteger(v.health.maxWait) && v.health.maxWait >= 1 && v.health.maxWait <= 3600)) &&
    ['timeout', 'retries', 'interval'].every(
      (k) => Number.isFinite(v.health[k]) && v.health[k] > 0,
    );
  const artifact = (v: unknown) =>
    object(v) &&
    strings(v, ['name', 'modified', 'path']) &&
    ['sample', 'file', 'unknown', 'remote'].includes(v.source) &&
    typeof v.exists === 'boolean' &&
    Number.isFinite(v.size) &&
    v.size >= 0;
  const unique = (list: { id: string }[]) =>
    list.every((v) => !['__proto__', 'constructor', 'prototype'].includes(v.id)) &&
    new Set(list.map((v) => v.id)).size === list.length;
  if (!object(data)) return false;
  const d = data;
  return (
    d.schema === 3 &&
    Array.isArray(d.services) &&
    d.services.every(service) &&
    unique(d.services) &&
    Array.isArray(d.servers) &&
    d.servers.every(server) &&
    unique(d.servers) &&
    Array.isArray(d.targets) &&
    d.targets.every(
      (t: any) =>
        target(t) &&
        d.services.some((s: Service) => s.id === t.serviceId) &&
        d.servers.some((s: Server) => s.id === t.serverId),
    ) &&
    unique(d.targets) &&
    Array.isArray(d.jdks) &&
    d.jdks.every((j: unknown) => strings(j, ['name', 'path'])) &&
    Array.isArray(d.history) &&
    d.history.every(
      (h: any) =>
        strings(h, ['id', 'taskId', 'time']) &&
        strings(h.service, ['id', 'name']) &&
        strings(h.service.git, ['branch', 'commit', 'time']) &&
        strings(h.target, [
          'id',
          'serverId',
          'name',
          'directory',
          'fileName',
          'mode',
          'container',
          'containerJar',
          'version',
        ]) &&
        strings(h.server, ['id', 'name', 'host', 'user', 'auth', 'alias']) &&
        Number.isInteger(h.server.port) &&
        typeof h.backupCreated === 'boolean' &&
        (!h.backupCreated || typeof h.backupPath === 'string') &&
        Array.isArray(h.steps) &&
        validSteps(h.steps) &&
        object(d.taskHistory) &&
        Object.hasOwn(d.taskHistory, h.taskId) &&
        artifact(h.artifact) &&
        ['success', 'unverified', 'failed', 'rolledback', 'unknown'].includes(h.status) &&
        Array.isArray(h.logs) &&
        h.logs.every((l: unknown) => typeof l === 'string') &&
        ['deploy', 'rollback'].includes(h.operation) &&
        ['existing', 'rebuild'].includes(h.build) &&
        Number.isFinite(h.elapsed),
    ) &&
    object(d.taskHistory) &&
    Object.entries(d.taskHistory).every(
      ([id, r]) =>
        object(r) &&
        id === r.id &&
        !['__proto__', 'constructor', 'prototype'].includes(id) &&
        Array.isArray(r.buildLogs) &&
        r.buildLogs.every((l: unknown) => typeof l === 'string') &&
        Array.isArray(r.buildSteps) &&
        validSteps(r.buildSteps) &&
        typeof r.started === 'string' &&
        Number.isFinite(r.elapsed),
    ) &&
    object(d.settings) &&
    ['stop', 'continue'].includes(d.settings.failurePolicy) &&
    ['system', 'light', 'dark'].includes(d.settings.theme) &&
    typeof d.settings.allowMavenNonzero === 'boolean' &&
    Number.isInteger(d.settings.historyLimit) &&
    d.settings.historyLimit >= 1 &&
    d.settings.historyLimit <= 10000 &&
    typeof d.settings.demoMode === 'boolean' &&
    typeof d.lastService === 'string' &&
    Array.isArray(d.lastTargets) &&
    d.lastTargets.every((id: unknown) => typeof id === 'string')
  );
}
/** 原型不保存认证口令；对导入配置中的额外敏感字段同样排除。 */
export function safeConfigJson(db: Database) {
  return JSON.stringify(
    db,
    (key, value) =>
      key !== 'credentialMode' && /password|passphrase|privatekey|secret|credential/i.test(key)
        ? undefined
        : value,
    2,
  );
}

function validSteps(steps: unknown[]): boolean {
  return steps.every(
    (s: any) =>
      s &&
      typeof s.key === 'string' &&
      typeof s.label === 'string' &&
      (s.elapsed === undefined || (Number.isFinite(s.elapsed) && s.elapsed >= 0)) &&
      (s.startedAt === undefined || Number.isFinite(s.startedAt)) &&
      (s.endedAt === undefined || Number.isFinite(s.endedAt)) &&
      (s.status === undefined ||
        ['pending', 'running', 'success', 'failed', 'skipped'].includes(s.status)),
  );
}
export const seconds = (value: number) => value.toFixed(1) + ' 秒';
