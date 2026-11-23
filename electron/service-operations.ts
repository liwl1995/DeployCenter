import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import type { Server, Target } from '../src/model';
import { shellQuote as q } from '../src/model';
import type { OperationPlan, OperationRecord, OperationStatus, ServiceOperation } from '../src/operations';
import { pendingSchedule } from '../src/schedules';
import { workbenchHeader, workbenchScope } from './workbench';
import type { Storage } from './storage';
import type { Transport } from './ssh';
import { LineRedactor } from './log-redactor';
import { MemoryCredentials } from './native-capabilities';
import script from './service-operations.sh';

export function operationCommands(target: Target, action: ServiceOperation) {
  if (target.mode === 'docker') {
    if (!target.container.trim()) throw new Error('请先配置容器名称');
    const start = 'docker start -- ' + q(target.container);
    const stop = 'docker stop --time 30 -- ' + q(target.container);
    return action === 'restart' ? [stop, start] : [action === 'start' ? start : stop];
  }
  const commands = action === 'restart' && !target.restart.trim() ? [target.stop, target.start] : [target[action]];
  if (!commands.every((command) => command.trim())) throw new Error('请先在部署目标中配置所需的启停命令');
  return commands;
}

function environment(target: Target, owner: string) {
  return workbenchHeader(target, owner) + Object.entries({
    MODE: target.mode, CONTAINER: target.container, OPS_JAR: target.fileName,
  }).map(([key, value]) => 'export ' + key + '=' + q(value)).join('\n') + '\n' + script + '\n';
}

export function operationScript(target: Target, owner: string, action: ServiceOperation, confirmedStopped: boolean) {
  operationCommands(target, action);
  return environment(target, owner) + Object.entries({
    MARKER: owner, ACTION: action,
    STOP: target.stop, START: target.start, RESTART: target.restart.trim() ? target.restart : '',
    LIMIT: String(target.commandTimeout ?? 120), STABILITY: String(target.stabilitySeconds ?? 8),
    CONFIRM_STOPPED: confirmedStopped ? '1' : '0',
  }).map(([key, value]) => key + '=' + q(value)).join('\n') + '\nrun_operation\n';
}

type Prepared = { plan: OperationPlan; signature: string; until: number };
const uncertain = (record: OperationRecord) =>
  !record.settled && (record.result === 'unknown' || record.result === 'running');

export class ServiceOperations {
  private readonly prepared = new Map<string, Prepared>();
  private active?: string;
  private checking = false;
  constructor(
    private readonly storage: Storage,
    private readonly connect: (server: Server, supplied: string, signal?: AbortSignal) => Promise<{ transport: Transport; secret: string }>,
    private readonly blocked: () => string | undefined,
    private readonly publish: (record: OperationRecord) => void,
  ) {}
  isBusy() { return !!this.active; }
  reason(scope: string) {
    return this.storage.operations(scope).some(uncertain) ? '该目标上次运维结果待核实，请先查看运行状态并确认。' : undefined;
  }
  private context(id: string) {
    const db = this.storage.database();
    const target = db.targets.find((item) => item.id === id);
    const server = target && db.servers.find((item) => item.id === target.serverId);
    const service = target && db.services.find((item) => item.id === target.serviceId);
    if (!target || !server || !service) throw new Error('找不到服务、目标或服务器配置');
    return { target, server, service, scope: workbenchScope(target, server) };
  }
  list(id: string) {
    const { scope } = this.context(id);
    return this.storage.operations(scope).map((record): OperationRecord =>
      record.result === 'running' && record.id !== this.active
        ? { ...record, result: 'unknown', message: '上次应用退出时尚未收到远程结果，请先核实' }
        : record);
  }
  private signature(target: Target, server: Server) {
    return JSON.stringify([target, server]);
  }
  prepare(id: string, action: ServiceOperation) {
    const { target, server, service, scope } = this.context(id);
    this.assertAvailable(scope);
    const nextRelease = this.storage.schedules().filter(pendingSchedule)
      .filter((schedule) => schedule.task.targets.some((item) => workbenchScope(item.target, item.server) === scope))
      .map((schedule) => schedule.scheduledAt).sort((a, b) => a - b)[0];
    const token = randomUUID();
    const now = Date.now();
    for (const [key, value] of this.prepared) if (value.until <= now) this.prepared.delete(key);
    if (this.prepared.size >= 32) this.prepared.delete(this.prepared.keys().next().value!);
    const plan: OperationPlan = {
      token, targetId: id, target: target.name, service: service.name, server: server.name,
      address: server.auth === 'alias' ? server.alias : server.host + ':' + server.port,
      production: target.production, action, commands: operationCommands(target, action), nextRelease,
    };
    this.prepared.set(token, { plan, until: now + 120_000, signature: this.signature(target, server) });
    return plan;
  }
  private assertAvailable(scope: string) {
    if (this.active) throw new Error('已有服务运维操作正在执行');
    const reason = this.blocked() || this.reason(scope);
    if (reason) throw new Error(reason);
  }
  async status(id: string, supplied: string): Promise<OperationStatus> {
    const { target, server } = this.context(id);
    if (this.checking) throw new Error('正在检查另一个目标，请稍后再刷新');
    this.checking = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 100_000);
    let transport: Transport | undefined;
    let mask = new MemoryCredentials({ active: supplied });
    try {
      const connection = await this.connect(server, supplied, controller.signal);
      transport = connection.transport;
      mask.clear();
      mask = new MemoryCredentials({ active: connection.secret });
      await transport.connect();
      const result = await transport.exec('bash -s', {
        input: environment(target, 'DC-OPS-STATUS') + 'status_result\n',
        timeout: 12000, maxOutput: 16384,
      });
      const [raw, locked, pid, age, restarts, health, started] = result.stdout.trimEnd().split('\t');
      const states = ['running', 'stopped', 'matched', 'not-found', 'unknown'] as const;
      const state = states.find((value) => value === raw);
      if (result.code || !state || !['0', '1'].includes(locked)) throw new Error('服务器未返回有效的运行状态');
      const startedAt = Date.parse(started || '');
      const reason = result.stderr.trim();
      const seconds = /^\d+$/.test(age || '') ? Number(age)
        : state === 'running' && Number.isFinite(startedAt) ? Math.max(0, (Date.now() - startedAt) / 1000) : undefined;
      return {
        state, locked: locked === '1', checkedAt: new Date().toISOString(),
        pid: /^\d+$/.test(pid || '') ? pid : undefined,
        restarts: /^\d+$/.test(restarts || '') ? Number(restarts) : undefined,
        health: ['none', 'starting', 'healthy', 'unhealthy'].includes(health) ? health : undefined,
        uptime: seconds === undefined ? undefined : seconds >= 86400
          ? Math.floor(seconds / 86400) + ' 天 ' + Math.floor(seconds % 86400 / 3600) + ' 小时'
          : seconds >= 3600 ? Math.floor(seconds / 3600) + ' 小时 ' + Math.floor(seconds % 3600 / 60) + ' 分钟'
          : Math.floor(seconds / 60) + ' 分钟',
        message: state === 'unknown'
          ? reason
            ? '无法读取运行状态：' + mask.redact(reason).slice(0, 512)
            : target.mode === 'docker'
              ? '容器未处于稳定运行或已停止状态。请查看日志并刷新状态。'
              : '未能唯一匹配 Java 进程，请核对进程和 JAR 文件名。'
          : undefined,
      };
    } catch (error) {
      throw new Error(mask.redact(String(error)));
    } finally {
      clearTimeout(timer);
      transport?.close();
      mask.clear();
      this.checking = false;
    }
  }
  async settle(id: string, recordId: string, confirmation: string, supplied: string) {
    const context = this.context(id);
    const record = this.storage.operations(context.scope).find((entry) => entry.id === recordId);
    if (!record || !uncertain(record) || record.id === this.active) throw new Error('没有需要核实的运维记录');
    if (confirmation !== context.target.name) throw new Error('请输入目标名称确认已人工核实');
    const status = await this.status(id, supplied);
    if (status.locked || status.state === 'unknown') throw new Error('仍有目标锁或无法读取状态，请先核实服务器');
    if (this.context(id).scope !== context.scope) throw new Error('目标配置已变化，请重新核实');
    record.result = 'unknown';
    record.settled = true;
    record.message = '已人工核实当前状态，原操作结果未确认';
    this.storage.saveOperation(record);
    this.publish(record);
    return record;
  }
  async run(token: string, confirmation: string, stopped: boolean, supplied: string) {
    const prepared = this.prepared.get(token);
    if (!prepared || prepared.until < Date.now()) throw new Error('确认已过期，请重新打开运维操作');
    const { plan } = prepared;
    const { target, server, scope } = this.context(plan.targetId);
    this.assertAvailable(scope);
    if (this.signature(target, server) !== prepared.signature) throw new Error('目标或服务器配置已变化，请重新确认');
    if (plan.production && confirmation !== plan.target) throw new Error('请输入正式环境的目标名称');
    const id = 'DC-OPS-' + randomUUID();
    const input = operationScript(target, id, plan.action, stopped);
    const record: OperationRecord = {
      id, targetId: target.id, target: target.name, server: server.name, scope,
      action: plan.action, actor: userInfo().username, started: Date.now(),
      result: 'running', message: '正在建立 SSH 连接', logs: '',
    };
    this.prepared.delete(token);
    this.active = id;
    let transport: Transport | undefined;
    let dispatched = false;
    let mask = new MemoryCredentials({ active: supplied });
    try {
      this.storage.saveOperation(record);
      this.publish(record);
      const connection = await this.connect(server, supplied);
      transport = connection.transport;
      mask.clear();
      mask = new MemoryCredentials({ active: connection.secret });
      await transport.connect();
      const current = this.context(plan.targetId);
      if (this.signature(current.target, current.server) !== prepared.signature)
        throw new Error('连接期间目标配置已变化，请重新确认');
      const channel = await transport.channel('bash -s');
      const readers = [new LineRedactor({ active: connection.secret }), new LineRedactor({ active: connection.secret })];
      let verdict: 'success' | 'unverified' | 'failed' | 'blocked' | 'unknown' | undefined;
      let finalMessage = '';
      let count = 0;
      const consume = (value: string, stdout: boolean) => {
        for (const line of value.split(/(?<=\n)/)) {
          if (!line) continue;
          if (stdout && line.startsWith(id + '\t')) {
            count++;
            const [, state, message] = line.trimEnd().split('\t');
            if (state === 'success' || state === 'unverified' || state === 'failed' || state === 'blocked' || state === 'unknown') {
              verdict = state; finalMessage = message;
            }
          } else record.logs = (record.logs + line).slice(-65536);
        }
      };
      let flush: ReturnType<typeof setTimeout> | undefined;
      const queue = () => { flush ??= setTimeout(() => { flush = undefined; this.publish(record); }, 120); };
      const listeners = [channel.output, channel.error].map((stream, index) => {
        stream.on('data', (chunk: Buffer) => {
          try { consume(readers[index].write(chunk), index === 0); queue(); }
          catch { channel.stop(); }
        });
        return stream;
      });
      const deadline = ((target.commandTimeout ?? 120) * 2 + (target.stabilitySeconds ?? 8) + 30) * 1000;
      const timer = setTimeout(() => channel.stop(), deadline);
      dispatched = true;
      channel.input.on('error', () => channel.stop());
      channel.input.end(input);
      try {
        const code = await channel.done;
        for (const [index, reader] of readers.entries()) consume(reader.end(), index === 0);
        if (code === 0 && count === 1 && verdict && finalMessage) {
          record.result = verdict; record.message = finalMessage;
        } else {
          record.result = 'unknown'; record.message = '没有收到可靠的远程结果，请先核实目标状态与任务锁';
        }
      } finally {
        clearTimeout(timer); clearTimeout(flush);
        listeners.forEach((stream) => stream.removeAllListeners('data'));
      }
    } catch (error) {
      record.result = dispatched ? 'unknown' : 'failed';
      record.message = dispatched ? '连接中断或结果无法确认，请先核实目标状态与任务锁' : '远程命令尚未提交';
      record.logs = (record.logs + '\n' + mask.redact(String(error))).slice(-65536);
    } finally {
      transport?.close();
      mask.clear();
      this.active = undefined;
    }
    record.elapsed = Date.now() - record.started;
    this.storage.saveOperation(record);
    this.publish(record);
    return record;
  }
}
