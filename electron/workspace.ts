import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { shellQuote as q, remoteJar, type Database, type Server, type Target } from '../src/model';
import type {
  DiagnosticResult,
  LocalPrecheck,
  PrecheckItem,
  LocalPrecheckRequest,
  ToolResult,
  DiagnosticKind,
} from '../src/features';
import { inspectJar, jarPath, resolveBuild, checkJdk, gitInfo } from './files';
import { runBatch, runProcess } from './process';
import { MemoryCredentials } from './native-capabilities';
import type { Transport } from './ssh';

import { localComparison } from '../src/workspace-model';
import { targetVersion } from '../src/presentation';
export const diagnosticLabels: Record<DiagnosticKind, string> = {
  directory: '目标目录文件',
  disk: '磁盘剩余',
  container: '容器状态',
  logs: '最近应用日志',
  process: '服务进程',
  lock: '目标任务锁',
  server: '服务器体检',
};
/** 诊断只允许固定模板；不会执行配置里的启停或健康检查命令。 */
export function diagnosticCommand(kind: DiagnosticKind, target?: Target) {
  if (kind === 'server')
    return "printf '连接与认证：通过\\n'; uname -a; id; df -Pk .; if command -v docker >/dev/null 2>&1; then docker --version; if docker info --format '{{.ServerVersion}}' 2>/dev/null; then printf 'Docker 引擎可访问\\n'; else printf 'Docker 引擎不可访问，请检查权限或运行状态\\n'; fi; else printf 'Docker 不可用\\n'; fi";
  if (!target) throw new Error('请选择部署目标');
  const dir = q(target.directory),
    file = q(remoteJar(target));
  switch (kind) {
    case 'directory':
      return 'ls -lan -- ' + dir + '; stat -- ' + file;
    case 'disk':
      return 'df -Pk -- ' + dir;
    case 'container':
      if (target.mode !== 'docker') throw new Error('该目标没有容器');
      return 'docker inspect -- ' + q(target.container);
    case 'logs':
      if (target.mode === 'docker') return 'docker logs --tail 200 -- ' + q(target.container);
      if (
        !target.appLogPath ||
        !path.posix.isAbsolute(target.appLogPath) ||
        /[\r\n\0]/.test(target.appLogPath)
      )
        throw new Error('请先在目标配置中填写应用日志的绝对路径');
      return 'tail -n 200 -- ' + q(target.appLogPath);
    case 'process':
      return 'ps -eo pid,etime,args | grep -F -- ' + q(target.fileName) + ' | grep -v grep';
    case 'lock': {
      const lock = target.directory.replace(/\/$/, '') + '/.deploy-center.lock';
      return (
        'if [ -d ' +
        q(lock) +
        ' ]; then printf "存在任务锁\\n"; cat -- ' +
        q(lock + '/owner') +
        ' ' +
        q(lock + '/created') +
        '; else printf "没有任务锁\\n"; fi'
      );
    }
    default:
      throw new Error('不支持的只读诊断');
  }
}
export async function diagnose(
  transport: Transport,
  kind: DiagnosticKind,
  target?: Target,
  credential = '',
): Promise<DiagnosticResult> {
  const command = diagnosticCommand(kind, target),
    redactor = new MemoryCredentials({ active: credential });
  try {
    const result = await transport.exec(command, { timeout: 30000, maxOutput: 2 * 1024 ** 2 });
    return {
      kind,
      command: redactor.redact(command),
      output: redactor.redact(result.stdout + result.stderr),
      ok: result.code === 0,
      time: new Date().toISOString(),
    };
  } finally {
    redactor.clear();
  }
}
export async function aliases(
  file = path.join(process.env.USERPROFILE || process.env.HOME || '', '.ssh', 'config'),
) {
  const hosts: string[] = [],
    warnings: string[] = [];
  try {
    const stat = await fsp.stat(file);
    if (stat.size > 1024 ** 2) throw new Error('SSH 配置超过 1 MB');
    const text = await fsp.readFile(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (/^\s*Include\s/i.test(line))
        warnings.push(
          '配置含 Include 引用，候选列表可能不完整，可手动输入别名；实际连接由系统 SSH 完整解析。',
        );
      const matched = line.match(/^\s*Host\s+(.+?)\s*(?:#.*)?$/i);
      if (matched)
        for (const token of matched[1].split(/\s+/)) {
          const name = token.replace(/^["']|["']$/g, '');
          if (name && !/[*!?]/.test(name) && !hosts.includes(name)) hosts.push(name);
        }
    }
  } catch (e) {
    warnings.push('未能读取 SSH 别名列表，可继续手动输入：' + String(e));
  }
  return { hosts, warnings: [...new Set(warnings)] };
}
export const sameServer = (a: Server, b: Server) =>
  JSON.stringify([a.auth, a.host, a.port, a.user, a.alias, a.keyPath, a.sshConfigFile]) ===
  JSON.stringify([b.auth, b.host, b.port, b.user, b.alias, b.keyPath, b.sshConfigFile]);
export async function toolInfo(
  db: Database,
  serviceId: string,
  temp: string,
  versions = false,
): Promise<ToolResult> {
  const service = db.services.find((s) => s.id === serviceId);
  if (!service) throw new Error('服务不存在');
  const result: ToolResult = {
    serviceId,
    tool: '',
    workDir: '',
    version: '未检查版本',
    javaVersion: '',
    available: false,
    reason: '',
  };
  try {
    const resolved = await resolveBuild(service, db.jdks, temp);
    result.javaVersion = await checkJdk(resolved.jdkPath);
    result.workDir = resolved.cwd;
    if (path.isAbsolute(resolved.tool)) {
      if (!(await fsp.stat(resolved.tool)).isFile()) throw new Error('构建工具不是普通文件');
      result.tool = resolved.tool;
    } else {
      const found = await runProcess(
        process.platform === 'win32' ? 'where.exe' : 'which',
        [resolved.tool],
        { timeout: 10000 },
      );
      if (found.code || !found.stdout.trim()) throw new Error('找不到构建工具：' + resolved.tool);
      result.tool = found.stdout.trim().split(/\r?\n/)[0];
    }
    if (versions) {
      await fsp.mkdir(temp, { recursive: true });
      const output =
        process.platform === 'win32' &&
        !/\.cmd$/i.test(resolved.tool) &&
        /mvnw$/.test(resolved.tool)
          ? await runProcess('bash.exe', [resolved.tool, '--version'], {
              cwd: resolved.cwd,
              env: resolved.env,
              timeout: 60000,
            })
          : await runBatch(resolved.tool, ['--version'], temp, {
              cwd: resolved.cwd,
              env: resolved.env,
              timeout: 60000,
            });
      if (output.code) throw new Error(output.stdout + output.stderr);
      result.version = output.stdout + output.stderr;
    }
    result.available = true;
  } catch (e) {
    result.reason = String(e);
  }
  return result;
}
export async function localPrecheck(
  db: Database,
  request: LocalPrecheckRequest,
  saved: string[],
  temp: string,
  probe = toolInfo,
  inspect = inspectJar,
): Promise<LocalPrecheck> {
  const service = db.services.find((s) => s.id === request.serviceId);
  if (!service) throw new Error('服务不存在');
  const items: PrecheckItem[] = [];
  const add = (
    key: string,
    label: string,
    state: PrecheckItem['state'],
    reason: string,
    blocking: boolean,
  ) => items.push({ key, label, state, reason, blocking });
  const targets = request.targetIds.map((id) =>
    db.targets.find((t) => t.id === id && t.serviceId === service.id),
  );
  if (targets.some((t) => !t)) throw new Error('部署目标不属于当前服务');
  add(
    'targets',
    '部署目标',
    targets.length ? 'pass' : 'fail',
    targets.length ? '已选择 ' + targets.length + ' 个目标' : '请先选择部署目标',
    true,
  );
  const result: LocalPrecheck = { items, checkedAt: new Date().toISOString() };
  if (request.build === 'rebuild') {
    const jdk = db.jdks.find((j) => j.name === service.jdk);
    if (!jdk) {
      add('jdk', '构建 JDK', 'fail', '请为此服务选择已配置的 JDK', true);
      add('tool', '构建工具', 'unchecked', '先配置 JDK 后再检查构建工具', true);
    } else {
      const checked = await probe(db, service.id, temp);
      result.tool = checked.tool;
      result.javaVersion = checked.javaVersion;
      add(
        'jdk',
        '构建 JDK',
        checked.javaVersion ? 'pass' : 'fail',
        checked.javaVersion
          ? jdk.name + ' 可用，仅作用于构建进程'
          : checked.reason || 'JDK 检查未通过',
        true,
      );
      add(
        'tool',
        '构建工具',
        checked.available ? 'pass' : 'fail',
        checked.available ? checked.tool : checked.reason,
        true,
      );
    }
    add('jar', '部署 JAR', 'unchecked', '构建后完整校验新产物并固定同一份文件', false);
  } else {
    add('jdk', '构建 JDK', 'pass', '使用现有 JAR，本次不需要构建 JDK', false);
    add('tool', '构建工具', 'pass', '本次跳过构建工具', false);
    try {
      const a = await inspect(request.jarPath || jarPath(service));
      result.hash = a.sha256;
      add('jar', '部署 JAR', 'pass', '文件存在且完整性校验通过', true);
      const equal = targets.filter((t) => t?.currentHash && t.currentHash === a.sha256);
      if (equal.length)
        add(
          'same',
          '与线上相同',
          'pass',
          equal.map((t) => t!.name).join('、') + ' 的 JAR 指纹相同；仍可部署以重新启动',
          false,
        );
    } catch (e) {
      add('jar', '部署 JAR', 'fail', String(e), true);
    }
  }
  for (const target of targets as Target[]) {
    const server = db.servers.find((s) => s.id === target.serverId)!;
    const keyMissing = server.auth === 'key' && (!server.keyPath || !fs.existsSync(server.keyPath));
    add(
      'credential-' + server.id,
      server.name + ' · 凭据',
      keyMissing
        ? 'fail'
        : server.auth === 'alias' || saved.includes(server.id)
          ? 'pass'
          : 'unchecked',
      keyMissing
        ? '私钥文件不存在'
        : server.auth === 'alias'
          ? '使用系统 SSH 配置与 Agent，连接时核对身份'
          : saved.includes(server.id)
            ? '已保存本机加密凭据，连接时解密'
            : '部署确认时输入密码或私钥口令',
      keyMissing,
    );
    add(
      'lock-' + target.id,
      target.name + ' · 任务锁',
      'unchecked',
      '尚未连接检查；试运行可检查，正式部署仍会再次核对',
      false,
    );
  }
  return result;
}

/** 只比较本地 Git 与已记录版本，不连接远端；提交参数限定为哈希，避免选项注入。 */
export async function localDifferences(db: Database) {
  const result: Record<string, string> = {};
  for (const service of db.services) {
    let jar: import('../src/model').Artifact | undefined;
    try {
      jar = await inspectJar(jarPath(service));
    } catch {
      /* 文件缺失不冒充相同版本。 */
    }
    const git = await gitInfo(service.root);
    for (const target of db.targets.filter((t) => t.serviceId === service.id)) {
      let ahead: number | undefined, behind: number | undefined;
      const commit = targetVersion(target).commit;
      if (commit && /^[a-f0-9]{7,40}$/i.test(commit) && /^[a-f0-9]{40}$/i.test(git.commit)) {
        try {
          const value = await runProcess(
            'git',
            ['-C', service.root, 'rev-list', '--left-right', '--count', commit + '...HEAD', '--'],
            { timeout: 10000 },
          );
          if (!value.code && /^\d+\s+\d+$/.test(value.stdout.trim()))
            [behind, ahead] = value.stdout.trim().split(/\s+/).map(Number);
        } catch {
          /* 缺少本地历史时如实显示无法判断。 */
        }
      }
      result[target.id] = localComparison({
        ahead,
        behind,
        dirty: git.dirty,
        sameJar: !!jar?.sha256 && jar.sha256 === target.currentHash,
        newerJar:
          !!jar?.sha256 &&
          !!target.currentHash &&
          jar.sha256 !== target.currentHash &&
          Date.parse(jar.modified) > Date.parse(target.lastDeploy),
      });
    }
  }
  return result;
}
