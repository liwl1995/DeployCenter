import { createHash } from 'node:crypto';
import type { Database, Task } from '../src/model';
import { pendingSchedule, scheduleWindow } from '../src/schedules';
import type { Storage } from './storage';
import type { Controller } from './controller';
import type { Pin } from './contracts';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** 排除部署结果、Git 现场及说明文字，配置变化不能静默改变已确认的发布。 */
export function scheduleConfiguration(db: Database, task: Task) {
  const service = db.services.find((s) => s.id === task.service.id);
  return digest([
    service && { ...service, git: undefined, description: undefined },
    task.targets.map((r) => {
      const target = db.targets.find((t) => t.id === r.target.id);
      const server = db.servers.find((s) => s.id === r.server.id);
      return [
        target && {
          ...target,
          hasOldJar: undefined,
          version: undefined,
          currentHash: undefined,
          lastDeploy: undefined,
          healthState: undefined,
          currentCommit: undefined,
        },
        server && { ...server, note: undefined },
      ];
    }),
    db.jdks.filter((j) => j.name === task.service.jdk),
    db.settings.allowMavenNonzero,
  ]);
}
export function schedulePins(task: Task, pins: Record<string, Pin>) {
  return digest(
    task.targets.map((r) =>
      r.server.auth === 'alias'
        ? null
        : pins[r.server.host.toLowerCase().replace(/^\[|\]$/g, '') + ':' + r.server.port] || null,
    ),
  );
}
export function validScheduleTime(value: number, now = Date.now()) {
  if (!Number.isSafeInteger(value) || value <= now || value > now + 366 * 86400000)
    throw new Error('请选择未来一年内的发布时间');
}
/** 调度只认领一次发布任务；等待期间不占用执行器或远端锁。 */
export class ReleaseScheduler {
  private ticking = false;
  private suspended = false;
  private dispatching = false;
  isDispatching() {
    return this.dispatching;
  }
  private timer?: ReturnType<typeof setInterval>;
  private resumeTime?: number;
  private last = 0;
  private monotonic = 0;
  constructor(
    private storage: Storage,
    private controller: Controller,
    private blocked: () => boolean,
    private changed: () => void,
    private now: () => number = Date.now,
    private elapsed: () => number = () => performance.now(),
  ) {}
  start() {
    this.restore();
    this.last = this.now();
    this.monotonic = this.elapsed();
    this.timer = setInterval(() => {
      void this.tick().catch(() => {
        /* 保留持久记录，下轮重新核实。 */
      });
    }, 1000);
  }
  close() {
    this.suspended = true;
    if (this.timer) clearInterval(this.timer);
  }
  suspend() {
    this.suspended = true;
  }
  resume() {
    this.suspended = false;
    this.resumeTime = this.now();
    if (this.storage.isOpen()) {
      this.missDue('系统休眠期间错过发布时间，请重新安排', this.resumeTime);
      this.resumeTime = undefined;
    }
    this.last = this.now();
    this.monotonic = this.elapsed();
  }
  private missDue(reason: string, before = this.now()) {
    for (const plan of this.storage.schedules()) {
      if (pendingSchedule(plan) && plan.scheduledAt <= before) {
        if (plan.state === 'preparing') this.controller.cancel(plan.preparationId);
        plan.state = 'missed';
        plan.reason = reason;
        this.storage.saveSchedule(plan);
      }
    }
    this.changed();
  }
  restore() {
    for (const plan of this.storage.schedules()) {
      if (plan.state === 'executing') {
        const task = plan.taskId && this.storage.task(plan.taskId);
        plan.state = task && ['success', 'partial'].includes(task.status) ? 'completed' : 'failed';
        plan.reason = '应用曾中断，请查看关联任务并核实远端状态；不会自动重发';
      } else if (pendingSchedule(plan)) {
        if (plan.scheduledAt <= this.now()) {
          plan.state = 'missed';
          plan.reason = '应用未运行期间错过发布时间，请重新安排';
        } else if (plan.state === 'preparing') {
          plan.state = 'confirmation';
          plan.reason = '准备曾中断，请重新准备并确认';
        }
      }
      this.storage.saveSchedule(plan);
    }
    this.changed();
  }
  async tick() {
    if (this.ticking || this.suspended || !this.storage.isOpen()) return;
    if (this.resumeTime !== undefined) {
      this.missDue('系统休眠期间错过发布时间，请重新安排', this.resumeTime);
      this.resumeTime = undefined;
    }
    this.ticking = true;
    try {
      const now = this.now(),
        monotonic = this.elapsed();
      // 时间向后跳或向前跳超过一分钟时要求人工核实，避免突然补发。
      if (this.last && Math.abs(now - this.last - (monotonic - this.monotonic)) > 60000) {
        for (const plan of this.storage.schedules())
          if (pendingSchedule(plan)) {
            plan.state = 'confirmation';
            plan.reason = '系统时间已变化，请重新确认发布时间';
            this.storage.saveSchedule(plan);
          }
        this.changed();
      }
      this.last = now;
      this.monotonic = monotonic;
      for (const plan of this.storage
        .schedules()
        .sort(
          (a, b) =>
            a.scheduledAt - b.scheduledAt || a.createdAt - b.createdAt || a.id.localeCompare(b.id),
        )) {
        if (!['preparing', 'ready', 'waiting'].includes(plan.state)) continue;
        if (now > plan.scheduledAt + scheduleWindow) {
          if (plan.state === 'preparing') this.controller.cancel(plan.preparationId);
          plan.state = 'missed';
          plan.reason = '超过最晚启动时间，未自动补发';
          this.storage.saveSchedule(plan);
          this.changed();
          continue;
        }
        if (scheduleConfiguration(this.storage.database(), plan.task) !== plan.configuration) {
          if (plan.state === 'preparing') this.controller.cancel(plan.preparationId);
          plan.state = 'confirmation';
          plan.reason = '关键配置已变化，请重新准备并确认';
          this.storage.saveSchedule(plan);
          this.changed();
          continue;
        }
        if (plan.state === 'preparing' || now < plan.scheduledAt || now < (plan.nextAttemptAt || 0))
          continue;
        if (this.blocked() || this.controller.active()) {
          if (plan.state !== 'waiting') {
            plan.state = 'waiting';
            plan.reason = '等待当前任务或维护操作结束';
            this.storage.saveSchedule(plan);
            this.changed();
          }
          continue;
        }
        if (schedulePins(plan.task, this.storage.pins()) !== plan.pins) {
          plan.state = 'confirmation';
          plan.reason = '主机信任已变化，请重新准备并确认';
          this.storage.saveSchedule(plan);
          this.changed();
          continue;
        }
        try {
          this.dispatching = true;
          await this.controller.startScheduled(plan);
        } catch {
          const current = this.storage.schedules().find((p) => p.id === plan.id);
          if (current && ['ready', 'waiting'].includes(current.state)) {
            current.state = 'failed';
            current.reason = '无法启动计划，请检查已保存凭据及本地产物后重新准备';
            this.storage.saveSchedule(current);
          }
        } finally {
          this.dispatching = false;
        }
        this.changed();
        break;
      }
    } finally {
      this.ticking = false;
    }
  }
}
