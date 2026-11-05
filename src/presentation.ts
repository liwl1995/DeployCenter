import type { Database, Service, Target, Task, TargetStatus } from './model';

// Record 的键覆盖类型联合；新增内部枚举而未补中文时，类型检查和覆盖测试都会失败。
export const taskLabels: Record<Task['status'], string> = {
  running: '执行中',
  cancelling: '取消中',
  success: '已完成',
  partial: '部分完成',
  failed: '执行失败',
  cancelled: '已取消',
  interrupted: '待核实',
};
export const targetLabels: Record<TargetStatus, string> = {
  pending: '等待执行',
  running: '执行中',
  success: '健康检查通过',
  unverified: '已启动 · 健康未验证',
  failed: '执行失败',
  rollingback: '正在回滚',
  rolledback: '失败 · 已回滚',
  cancelled: '已取消',
  skipped: '已跳过',
  unknown: '远端状态待核实',
};
export const toolLabels: Record<Service['tool'], string> = {
  auto: '自动选择构建工具',
  wrapper: '项目 Maven 封装脚本',
  maven: '本地 Maven',
};
export const stepLabels: Record<NonNullable<import('./model').Step['status']>, string> = {
  pending: '等待',
  running: '执行中',
  success: '通过',
  failed: '失败',
  skipped: '已跳过',
};
export const healthLabels: Record<import('./model').Health['type'], string> = {
  none: '未配置',
  http: 'HTTP 请求',
  tcp: 'TCP 端口',
  command: '自定义命令',
};
export const authLabels: Record<import('./model').Server['auth'], string> = {
  alias: '系统 SSH 别名',
  password: '用户名和密码',
  key: '私钥认证',
};
export const operationLabel = (
  task: Pick<Task, 'dryRun' | 'operation'> & {
    uncertain?: boolean;
    maintenance?: import('./features').MaintenanceRecord;
  },
) =>
  task.maintenance
    ? '备份清理'
    : task.uncertain
      ? '记录待恢复'
      : task.dryRun
        ? '试运行'
        : task.operation === 'rollback'
          ? '回滚'
          : '部署';
export const taskResult = (
  task: Pick<Task, 'dryRun' | 'status'> & {
    uncertain?: boolean;
    maintenance?: import('./features').MaintenanceRecord;
  },
) =>
  task.maintenance
    ? {
        pending: '执行结果待返回',
        success: '清理完成',
        partial: '部分清理',
        failed: '未清理',
        unknown: '清理结果待核实',
      }[task.maintenance.status]
    : task.uncertain
      ? '记录无法读取'
      : task.dryRun
        ? (
            {
              success: '检查通过',
              partial: '检查未通过',
              failed: '检查未通过',
              running: '检查中',
              cancelling: '取消检查中',
              cancelled: '检查已取消',
              interrupted: '检查待核实',
            } satisfies Record<Task['status'], string>
          )[task.status]
        : taskLabels[task.status];
export const validHash = (value?: string) => !!value && /^[a-f\d]{7,64}$/i.test(value);
export const shortHash = (value?: string) => (validHash(value) ? value!.slice(0, 7) : '未记录');
/** 旧版本字段可能是 JAR 指纹前缀，只有与 JAR 指纹不同的哈希才可解释为提交。 */
export function knownCommit(version?: string, jarHash?: string) {
  return validHash(version) && !(jarHash && jarHash.startsWith(version!)) ? version : undefined;
}
export function targetVersion(target: Pick<Target, 'version' | 'currentCommit' | 'currentHash'>) {
  return {
    commit: target.currentCommit || knownCommit(target.version, target.currentHash),
    jar: target.currentHash,
  };
}
export function productionNames(task: Pick<Task, 'targets' | 'dryRun'>) {
  return task.dryRun
    ? []
    : task.targets
        .filter((r) => r.target.production)
        .map((r) => ({ id: r.target.id, name: r.target.name }));
}
export function confirmProduction(
  task: Pick<Task, 'targets' | 'dryRun'>,
  names: Record<string, string>,
) {
  return productionNames(task).every((t) => names[t.id] === t.name);
}
export function cloneService(service: Service, id: string = crypto.randomUUID()): Service {
  return {
    ...structuredClone(service),
    id,
    name: service.name + ' 副本',
    code: service.code + '-copy',
    git: { branch: '未检查', commit: '未记录', time: new Date(0).toISOString() },
  };
}
export function cloneTarget(target: Target, id: string = crypto.randomUUID()): Target {
  return {
    ...structuredClone(target),
    id,
    name: target.name + ' 副本',
    production: false,
    version: '未记录',
    currentHash: undefined,
    currentCommit: undefined,
    lastDeploy: '未记录',
    healthState: target.health.type === 'none' ? '未配置健康检查' : '未检查',
    hasOldJar: false,
  };
}
export function deletionReason(db: Database, entity: 'server' | 'jdk', id: string) {
  const refs =
    entity === 'server'
      ? db.targets.filter((t) => t.serverId === id).map((t) => t.name)
      : db.services.filter((s) => s.jdk === id).map((s) => s.name);
  return refs.length ? '正在被 ' + refs.join('、') + ' 使用，请先修改引用。' : '';
}
export function publicReason(error: string) {
  if (/指纹|host key|fingerprint/i.test(error)) return '主机身份核对未通过';
  if (/空间|磁盘|space/i.test(error)) return '可用磁盘空间不足';
  if (/权限|permission|denied/i.test(error)) return '目录或命令权限不足';
  if (/健康|health/i.test(error)) return '应用未在等待窗口内就绪';
  if (/构建|maven|build/i.test(error)) return '本机构建未通过';
  if (/取消/.test(error)) return '任务已取消';
  return '执行未通过，请在应用内查看脱敏日志';
}
export function failureAdvice(error: string) {
  const reason = publicReason(error);
  return {
    reason,
    action: /指纹/.test(reason)
      ? 'identity'
      : /空间|权限/.test(reason)
        ? 'diagnose'
        : /就绪/.test(reason)
          ? 'logs'
          : 'build',
    text: /指纹/.test(reason)
      ? '从独立渠道核对服务器主机指纹，确认变更原因；不要忽略身份校验。'
      : /空间/.test(reason)
        ? '查看磁盘剩余空间，清理确认可删除的文件后重试。'
        : /权限/.test(reason)
          ? '只读查看目标目录权限，确认登录用户拥有部署所需权限。'
          : /就绪/.test(reason)
            ? '查看应用日志并核对健康地址与启动等待窗口。'
            : '打开执行日志定位第一处错误，再决定是否重试。',
  };
}

export function taskWindowTitle(task: Task) {
  if (!['running', 'cancelling'].includes(task.status)) return 'YOTOO 部署中心';
  const action =
    task.status === 'cancelling'
      ? '安全取消中'
      : task.dryRun
        ? '检查中'
        : task.operation === 'rollback'
          ? '回滚中'
          : task.buildPhase < 3
            ? '构建准备中'
            : '部署中';
  return (
    action +
    ' ' +
    Math.min(task.active + 1, task.targets.length) +
    '/' +
    task.targets.length +
    ' · YOTOO 部署中心'
  );
}
export function taskProgress(task: Task) {
  if (!['running', 'cancelling'].includes(task.status)) return -1;
  const build = Math.min(1, task.buildPhase / Math.max(1, task.buildSteps.length));
  const targets = task.targets.reduce(
    (n, r) =>
      n +
      (['pending', 'running', 'rollingback'].includes(r.status)
        ? Math.min(1, r.phase / Math.max(1, r.steps.length))
        : 1),
    0,
  );
  return Math.max(0, Math.min(1, (build + targets) / (1 + task.targets.length)));
}
/** 通知只使用结果与原因白名单，不拼接备注、原始日志、命令或凭据。 */
export function taskNotice(task: Task, redact: (text: string) => string = (text) => text) {
  const environments = task.targets.map((r) => r.target.name).join('、') || '构建阶段';
  const reason = ['failed', 'partial', 'interrupted'].includes(task.status)
    ? task.buildSteps.some((s) => s.status === 'failed')
      ? '本机构建未通过'
      : publicReason(task.targets.find((r) => r.error)?.error || '')
    : '';
  return redact(
    task.service.name +
      ' · ' +
      environments +
      ' · ' +
      operationLabel(task) +
      ' · ' +
      taskResult(task) +
      (reason ? '。' + reason : ''),
  )
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 300);
}
