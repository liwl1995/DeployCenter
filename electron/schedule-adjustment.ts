import { credentialServers } from '../src/credentials';
import type { Approval } from '../src/platform';
import { confirmProduction } from '../src/presentation';
import type { ReleaseSchedule, ReleaseScheduleView } from '../src/schedules';
import { inspectJar } from './files';
import { scheduleConfiguration, schedulePins, validScheduleTime } from './scheduler';
import type { Storage } from './storage';

const credentialHint = '请在服务器配置中测试连接并保存凭据。';
const missingPassword = (name: string) => '「' + name + '」尚未保存登录密码。' + credentialHint;

/** 只看本机已有的状态，产物校验与凭据读取在提交改期时完成。 */
function rescheduleCheck(storage: Storage): (plan: ReleaseSchedule) => string | null {
  if (!storage.isOpen()) return () => '数据目录暂不可用，请稍后重试。';
  const db = storage.database();
  const pins = storage.pins();
  const saved = new Set(storage.credentialIds());
  return (plan) => {
    if (plan.state === 'preparing' || plan.state === 'executing')
      return '请等待当前准备或部署结束。';
    if (plan.state === 'completed') return '此计划已执行。再次发布请重新准备。';
    if (plan.taskId) {
      const task = storage.task(plan.taskId);
      if (!task || (task.status === 'interrupted' && !task.preparation))
        return '请先核实关联部署任务，再决定是否重新准备。';
      if (!task.preparation) return '此计划已执行。再次发布请重新准备。';
    }
    if (
      plan.state === 'confirmation' ||
      scheduleConfiguration(db, plan.task) !== plan.configuration ||
      schedulePins(plan.task, pins) !== plan.pins
    )
      return '配置、信任或线上基线需要重新核实，请重新准备并确认。';
    const baselines = plan.task.scheduleBaselines;
    if (
      !plan.task.artifact.sha256 ||
      !baselines ||
      !plan.task.targets.every(({ target }) => typeof baselines[target.id] === 'string')
    )
      return '缺少可复用的准备产物或线上基线，请重新准备。';
    for (const server of credentialServers(plan.task.targets.map(({ server }) => server))) {
      if (server.credentialMode !== 'windows')
        return '请将服务器凭据模式设为 Windows 加密保存，再重新准备。';
      if (server.auth === 'password' && !saved.has(server.id)) return missingPassword(server.name);
    }
    return null;
  };
}

/** 列表随当前配置和凭据变化，改期资格不写入计划快照。 */
export function scheduleViews(storage: Storage, plans: ReleaseSchedule[]): ReleaseScheduleView[] {
  if (!plans.length) return [];
  const check = rescheduleCheck(storage);
  return plans.map((plan) => ({ ...plan, rescheduleBlock: check(plan) }));
}

/** 复用已确认的准备结果，并在异步校验结束后核对计划仍是同一版本。 */
export async function reschedulePlan(
  storage: Storage,
  id: string,
  scheduledAt: number,
  approval: Approval,
  isDispatching: () => boolean = () => false,
) {
  validScheduleTime(scheduledAt);
  const plan = storage.schedules().find((entry) => entry.id === id);
  if (!plan) throw new Error('发布计划不存在。');
  const block = rescheduleCheck(storage)(plan);
  if (block) throw new Error(block);
  if (
    !confirmProduction(plan.task, approval.productionNames || {}) ||
    (plan.task.targets.some(({ target }) => target.hashPolicy === 'size-confirm') && !approval.allowWeak)
  )
    throw new Error('请重新确认正式环境及弱校验策略。');

  const artifact = await inspectJar(plan.task.artifact.path).catch((error) => {
    throw new Error('无法校验原计划产物，请重新准备。' + (error instanceof Error ? error.message : String(error)));
  });
  if (artifact.sha256 !== plan.task.artifact.sha256)
    throw new Error('固定产物校验失败，请重新准备。');
  for (const server of credentialServers(plan.task.targets.map(({ server }) => server))) {
    const readable = await storage.credential(server.id).then(Boolean).catch(() => {
      throw new Error('无法读取「' + server.name + '」的 Windows 加密凭据。' + credentialHint);
    });
    if (server.auth === 'password' && !readable) throw new Error(missingPassword(server.name));
  }

  // 校验期间调度器仍可能启动计划，最后一次确认和保存之间不能等待。
  const current = storage.schedules().find((entry) => entry.id === id);
  if (!current || JSON.stringify(current) !== JSON.stringify(plan))
    throw new Error('计划状态已变化，请刷新后重试。');
  const updatedBlock = rescheduleCheck(storage)(current);
  if (updatedBlock) throw new Error(updatedBlock);
  if (isDispatching()) throw new Error('定时发布正在启动，请稍后再改期。');
  validScheduleTime(scheduledAt);
  storage.saveSchedule({
    ...current,
    scheduledAt,
    approval,
    state: 'ready',
    reason: '已重新确认发布时间',
  });
}
