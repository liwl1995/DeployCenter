import type { Task } from './model';
import type { Approval } from './platform';

export type ScheduleState =
  | 'preparing'
  | 'ready'
  | 'waiting'
  | 'confirmation'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'missed';
/** 计划只保存确认快照及凭据引用，不保存口令。 */
export type ReleaseSchedule = {
  id: string;
  createdAt: number;
  scheduledAt: number;
  state: ScheduleState;
  reason: string;
  preparationId: string;
  taskId?: string;
  nextAttemptAt?: number;
  task: Task;
  approval: Approval;
  configuration: string;
  pins: string;
};

/** 主进程提供的改期资格。null 表示可改期，未提供时列表等待资格结果。 */
export type ReleaseScheduleView = ReleaseSchedule & { rescheduleBlock?: string | null };

export const scheduleLabels: Record<ScheduleState, string> = {
  preparing: '准备中',
  ready: '就绪',
  waiting: '等待执行',
  confirmation: '待重新确认',
  executing: '执行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  missed: '已错过',
};
export const pendingSchedule = (s: ReleaseSchedule) =>
  ['preparing', 'ready', 'waiting', 'confirmation'].includes(s.state);
export const scheduleWindow = 15 * 60 * 1000;
