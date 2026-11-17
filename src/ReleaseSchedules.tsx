import type { ReleaseSchedule } from './schedules';
import { scheduleLabels, pendingSchedule, scheduleWindow } from './schedules';
import { Card } from './ui';
import { fmtTime } from './model';

/** 计划详情只展示准备结果，真实发布结果由关联任务承载。 */
export function ReleaseSchedules({
  plans,
  busy,
  onOpen,
  onCancel,
  onChange,
  onPrepare,
}: {
  plans: ReleaseSchedule[];
  busy: boolean;
  onOpen: (id: string) => void;
  onCancel: (id: string) => void;
  onChange: (plan: ReleaseSchedule) => void;
  onPrepare: (plan: ReleaseSchedule) => void;
}) {
  return (
    <>
      <h1>发布计划</h1>
      <p className="note">
        准备阶段只构建、校验和保存产物。到点上传部署；电脑须保持开机、应用运行、网络可用。休眠或退出错过时间不补发。
      </p>
      {!plans.length && (
        <Card title="暂无发布计划">
          <p>在一键部署页选择服务和目标后，点击“定时发布”。</p>
        </Card>
      )}
      {[...plans]
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((plan) => (
          <Card key={plan.id} title={plan.task.service.name}>
            <div className="row wrap">
              <strong>{scheduleLabels[plan.state]}</strong>
              <span>{plan.task.targets.map((r) => r.target.name).join('、')}</span>
            </div>
            <p>
              计划时间：{fmtTime(new Date(plan.scheduledAt).toISOString())} · 最晚启动：
              {fmtTime(new Date(plan.scheduledAt + scheduleWindow).toISOString())}
            </p>
            <p className="note">
              {Intl.DateTimeFormat().resolvedOptions().timeZone} · {plan.reason}
            </p>
            <p className="code">
              {plan.task.artifact.name} · {plan.task.artifact.sha256 || '产物准备中'}
            </p>
            <div className="row wrap">
              <button className="button" onClick={() => onOpen(plan.preparationId)}>
                准备日志
              </button>
              {plan.taskId && (
                <button className="button" onClick={() => onOpen(plan.taskId!)}>
                  部署任务
                </button>
              )}
              {plan.state !== 'executing' && plan.state !== 'preparing' && (
                <>
                  {!['completed', 'confirmation'].includes(plan.state) && (
                    <button className="button" disabled={busy} onClick={() => onChange(plan)}>
                      调整时间
                    </button>
                  )}
                  <button className="button" disabled={busy} onClick={() => onPrepare(plan)}>
                    重新构建
                  </button>
                </>
              )}
              {pendingSchedule(plan) && (
                <button className="button danger" onClick={() => onCancel(plan.id)}>
                  取消计划
                </button>
              )}
            </div>
          </Card>
        ))}
    </>
  );
}
