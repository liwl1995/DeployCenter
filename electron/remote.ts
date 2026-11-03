import preflight from './remote-preflight.sh';
import runner from './remote-runner.sh';
import { shellQuote as q, remoteJar, type RunTarget, type Task } from '../src/model';
import { mustExec, type Transport } from './ssh';

export function remotePaths(task: Task, target: RunTarget) {
  const id = task.id + '-' + target.target.id;
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('部署目标内部标识不能用于远端任务目录');
  const base = target.target.directory.replace(/\/$/, '');
  const jobDir = base + '/.deploy-center/' + id;
  return {
    jobDir,
    lockDir: base + '/.deploy-center.lock',
    stagePath: base + '/.' + target.target.fileName + '.' + id + '.uploading',
    journalOffset: 0,
    logOffset: 0,
    phase: 'prepared' as const,
  };
}
export type DockerInfo = {
  id: string;
  running: boolean;
  restarts: number;
  mount: 'directory' | 'file';
  containerJar: string;
};
export async function inspectDocker(t: Transport, r: RunTarget): Promise<DockerInfo> {
  const raw = await mustExec(t, 'docker inspect -- ' + q(r.target.container));
  const value = JSON.parse(raw)[0];
  if (!value?.Id || !Array.isArray(value.Mounts)) throw new Error('Docker 容器检查结果无效');
  const jar = remoteJar(r.target);
  const canonical = (
    await mustExec(
      t,
      `if [ -e ${q(jar)} ]; then readlink -f -- ${q(jar)}; else cd -- ${q(r.target.directory)} && printf '%s/%s' "$(pwd -P)" ${q(r.target.fileName)}; fi`,
    )
  ).trim();
  const mounts = value.Mounts.filter(
    (m: { Type: string; Source: string }) =>
      m.Type === 'bind' &&
      (canonical === m.Source || canonical.startsWith(m.Source.replace(/\/$/, '') + '/')),
  ).sort((a: { Source: string }, b: { Source: string }) => b.Source.length - a.Source.length);
  const m = mounts[0];
  if (!m) throw new Error('配置的宿主机 JAR 不在该容器的绑定挂载中，已在停机前阻止部署');
  const file = canonical === m.Source;
  const containerJar = file
    ? m.Destination
    : m.Destination.replace(/\/$/, '') + canonical.slice(m.Source.replace(/\/$/, '').length);
  if (containerJar !== r.target.containerJar)
    throw new Error(
      `容器内路径与实际挂载不符：检测到 ${containerJar}，配置为 ${r.target.containerJar}`,
    );
  return {
    id: value.Id,
    running: !!value.State?.Running,
    restarts: Number(value.RestartCount || 0),
    mount: file ? 'file' : 'directory',
    containerJar,
  };
}
export function header(task: Task, r: RunTarget, allowWeak: boolean, docker?: DockerInfo) {
  const target = r.target,
    job = r.remote!;
  const health = target.health;
  let tcpHost = '',
    tcpPort = '';
  if (health.type === 'tcp') {
    const parsed = health.value.match(/^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/);
    if (!parsed) throw new Error('TCP 检查请输入 host:port 或 [IPv6]:port');
    tcpHost = parsed[1] || parsed[2];
    tcpPort = parsed[3];
  }
  const vars: Record<string, string> = {
    DIR: target.directory,
    JAR: remoteJar(target),
    JOB: job.jobDir,
    STAGE: job.stagePath,
    LOCK: job.lockDir,
    OWNER: task.id + '-' + target.id,
    RESTORE:
      target.directory.replace(/\/$/, '') +
      '/.' +
      target.fileName +
      '.' +
      task.id +
      '-' +
      target.id +
      '.restore',
    NEW_SIZE: String(task.artifact.size),
    NEW_HASH: task.artifact.sha256 || '',
    BACKUP: r.plannedBackupPath,
    BACKUP_ENABLED: r.backup.enabled ? '1' : '0',
    AUTO_ROLLBACK: r.backup.autoRollback ? '1' : '0',
    MODE: target.mode,
    CREATE_DIR: target.createDirectory ? '1' : '0',
    ALLOW_WEAK: allowWeak && target.hashPolicy === 'size-confirm' ? '1' : '0',
    STOP_CMD: target.stop,
    START_CMD: target.start,
    RESTART_CMD: target.restart,
    STOP_WARNING: target.stopFailure === 'warn' ? '1' : '0',
    CHMOD_EXECUTABLE: target.chmod ? '1' : '0',
    CONTAINER: target.container,
    CONTAINER_JAR: target.containerJar,
    CONTAINER_ID: docker?.id || '',
    INITIAL_RESTARTS: String(docker?.restarts || 0),
    ORIGINAL_RUNNING: docker?.running ? 'true' : 'false',
    COMMAND_TIMEOUT: String(target.commandTimeout || 120),
    STABILITY_SECONDS: String(target.stabilitySeconds || 5),
    HEALTH_TYPE: health.type,
    HEALTH_LOCATION: health.location || 'remote',
    HEALTH_VALUE: health.value,
    HEALTH_TIMEOUT: String(health.timeout),
    HEALTH_RETRIES: String(health.retries),
    HEALTH_INTERVAL: String(health.interval),
    TCP_HOST: tcpHost,
    TCP_PORT: tcpPort,
  };
  return (
    Object.entries(vars)
      .map(([key, value]) => key + '=' + q(value))
      .join('\n') +
    '\nexport DEPLOY_JAR="$JAR" DEPLOY_DIR="$DIR" DEPLOY_CONTAINER="$CONTAINER" DEPLOY_TASK_ID=' +
    q(task.id) +
    '\n'
  );
}
export function preflightScript(task: Task, r: RunTarget, allowWeak: boolean, docker?: DockerInfo) {
  return header(task, r, allowWeak, docker) + preflight;
}
export function runnerScript(task: Task, r: RunTarget, allowWeak: boolean, docker?: DockerInfo) {
  return header(task, r, allowWeak, docker) + runner;
}
export async function cleanupPrepared(transport: Transport, task: Task, r: RunTarget) {
  const job = r.remote;
  if (!job || job.phase !== 'prepared') return;
  const owner = task.id + '-' + r.target.id;
  await mustExec(
    transport,
    `if [ "$(cat ${q(job.lockDir + '/owner')} 2>/dev/null)" = ${q(owner)} ] && [ "$(cat ${q(job.jobDir + '/state')} 2>/dev/null)" = PREPARED ]; then rm -f -- ${q(job.stagePath)} ${q(job.lockDir + '/owner')} ${q(job.lockDir + '/created')}; rmdir -- ${q(job.lockDir)}; printf CANCELLED > ${q(job.jobDir + '/state')}; fi`,
  );
}
export async function writeRemoteFile(transport: Transport, file: string, text: string) {
  await mustExec(transport, 'umask 077; cat > ' + q(file), text);
}

export function dryRunScript(task: Task, r: RunTarget) {
  return (
    header(task, { ...r, remote: r.remote || remotePaths(task, r) }, false) +
    `set -eu
if [ -d "$DIR" ]; then check="$DIR"; printf '目录存在\\n'; else [ "$CREATE_DIR" = 1 ] || { printf '目录不存在，目标未允许创建\\n' >&2; exit 1; }; check="$DIR"; while [ ! -e "$check" ]; do check="$(dirname "$check")"; done; printf '目录缺失：正式部署将按配置创建，本次不创建\\n'; fi
[ -d "$check" ] && [ -w "$check" ] || { printf '目录或父目录不可写\\n' >&2; exit 1; }
[ ! -L "$JAR" ] || { printf '目标是符号链接\\n' >&2; exit 1; }
available="$(df -Pk -- "$check" | awk 'END {print $4}')"; needed=$(( (NEW_SIZE * 2 + 10485760 + 1023) / 1024 )); [ "$available" -ge "$needed" ] || { printf '磁盘空间不足\\n' >&2; exit 1; }; printf '权限、空间检查通过\\n'
if [ -e "$LOCK" ]; then printf '发现已有任务锁，持有者：'; cat "$LOCK/owner" 2>/dev/null || true; printf '\\n'; exit 1; fi
printf '未发现任务锁；试运行未写入远程文件\\n'
`
  );
}
