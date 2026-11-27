import { useLayoutEffect, useRef, useState } from 'react';
import { Button } from './design/ui/button';
import { SegmentedControl, type SegmentedItem } from './design/ui/segmented-control';
import type { ReleaseSchedule } from './schedules';
import { scheduleLabels, pendingSchedule, scheduleWindow } from './schedules';
import { CalendarClock } from 'lucide-react';
import { Badge } from './ui';
import { MoreMenu, type MenuAction } from './EntityActions';
import { fmtTime, type Service } from './model';
import { EntityIcon } from './entity-icons';

type ScheduleFilter = 'pending' | 'executing' | 'finished' | 'all';
export type ScheduleViewState = {
  filter: ScheduleFilter;
  expanded: Set<string>;
  openedPlan?: string;
};
const scheduleFilters: SegmentedItem<ScheduleFilter>[] = [
  { value: 'pending', label: '未执行' },
  { value: 'executing', label: '执行中' },
  { value: 'finished', label: '已结束' },
  { value: 'all', label: '全部' },
];

/** 计划详情只展示准备结果，真实发布结果由关联任务承载。 */
export function ReleaseSchedules({
  plans,
  services,
  busy,
  initialView,
  onViewChange,
  onOpen,
  onCancel,
  onChange,
  onPrepare,
}: {
  plans: ReleaseSchedule[];
  services: Service[];
  busy: boolean;
  initialView?: ScheduleViewState;
  onViewChange?: (view: ScheduleViewState) => void;
  onOpen: (id: string, planId: string) => void;
  onCancel: (id: string) => void;
  onChange: (plan: ReleaseSchedule) => void;
  onPrepare: (plan: ReleaseSchedule) => void;
}) {
  const initial = useRef(initialView);
  const [filter, setFilter] = useState<ScheduleFilter>(initial.current?.filter ?? 'pending');
  const [expanded, setExpanded] = useState(() => initial.current?.expanded ?? new Set<string>());
  const returnCard = useRef<HTMLElement>(null);
  const filterGroup = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    onViewChange?.({ filter, expanded });
  }, [filter, expanded, onViewChange]);
  useLayoutEffect(() => {
    if (!initial.current?.openedPlan) return;
    // 主区恢复滚动位置后，再把焦点交回原计划或当前筛选。
    const frame = requestAnimationFrame(() => {
      const trigger = returnCard.current?.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]');
      const focus = trigger ?? filterGroup.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]');
      focus?.focus({ preventScroll: true });
      focus?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  const visible = plans.filter((plan) => {
    if (filter === 'all') return true;
    if (filter === 'pending') return pendingSchedule(plan);
    if (filter === 'executing') return plan.state === 'executing';
    return !pendingSchedule(plan) && plan.state !== 'executing';
  });

  return (
    <>
      <p className="notice">
        准备阶段只构建、校验和保存产物。到点上传部署；电脑须保持开机、应用运行、网络可用。休眠或退出错过时间不补发。
      </p>
      <div className="schedule-filter" ref={filterGroup}>
        <SegmentedControl
          aria-label="发布计划状态筛选"
          size="sm"
          items={scheduleFilters}
          value={filter}
          onValueChange={setFilter}
        />
      </div>
      {!visible.length && (
        <div className="empty service-empty">
          <CalendarClock size={25} strokeWidth={1.4} />
          <strong>{plans.length ? '当前状态下暂无发布计划' : '暂无发布计划'}</strong>
          {plans.length ? (
            <Button variant="link" size="compact" onClick={() => setFilter('all')}>查看全部计划</Button>
          ) : (
            <span>选择服务和目标，在部署栏打开“发布选项”并选择“定时发布”。</span>
          )}
        </div>
      )}
      <div className="schedule-list">
        {visible
          .sort((a, b) => b.createdAt - a.createdAt)
          .map((plan) => {
            const service = services.find((s) => s.id === plan.task.service.id);
            const canPrepare = !['executing', 'preparing'].includes(plan.state);
            const canReschedule = canPrepare && !['completed', 'confirmation'].includes(plan.state);
            const actions: MenuAction[] = [
              { label: '准备日志', onClick: () => onOpen(plan.preparationId, plan.id) },
            ];
            const taskId = plan.taskId;
            if (taskId) actions.push({ label: '部署任务', onClick: () => onOpen(taskId, plan.id) });
            if (canPrepare)
              actions.push({ label: '重新构建', disabled: busy, onClick: () => onPrepare(plan) });
            if (pendingSchedule(plan))
              actions.push({
                label: '取消计划',
                destructive: true,
                onClick: () => onCancel(plan.id),
              });
            return (
              <article
                className="schedule-record"
                key={plan.id}
                ref={plan.id === initial.current?.openedPlan ? returnCard : undefined}
              >
                <span className="record-icon">
                  <EntityIcon kind="service" icon={service ? service.icon : plan.task.service.icon} size={18} strokeWidth={1.5} />
                </span>
                <div className="schedule-identity">
                  <div className="row wrap">
                    <h2>{plan.task.service.name}</h2>
                    <Badge>{scheduleLabels[plan.state]}</Badge>
                  </div>
                  <p className="muted">
                    {plan.task.targets.map((r) => r.target.name).join('、')} ·{' '}
                    {fmtTime(new Date(plan.scheduledAt).toISOString())}
                  </p>
                  <details
                    open={expanded.has(plan.id)}
                    onToggle={(event) => {
                      const open = event.currentTarget.open;
                      setExpanded((previous) => {
                        if (previous.has(plan.id) === open) return previous;
                        const next = new Set(previous);
                        if (open) next.add(plan.id);
                        else next.delete(plan.id);
                        return next;
                      });
                    }}
                  >
                    <summary>产物与计划详情</summary>
                    <p>
                      最晚启动：{fmtTime(new Date(plan.scheduledAt + scheduleWindow).toISOString())}
                    </p>
                    <p className="note">
                      {Intl.DateTimeFormat().resolvedOptions().timeZone} · {plan.reason}
                    </p>
                    <p className="path">
                      {plan.task.artifact.name} · {plan.task.artifact.sha256 || '产物准备中'}
                    </p>
                  </details>
                </div>
                {canReschedule && (
                  <Button variant="neutral" size="compact" disabled={busy} onClick={() => onChange(plan)}>
                    调整时间
                  </Button>
                )}
                <MoreMenu label={plan.task.service.name + '发布计划操作'} actions={actions} />
              </article>
            );
          })}
      </div>
    </>
  );
}
