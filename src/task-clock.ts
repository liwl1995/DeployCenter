import { useEffect, useState } from 'react';
import type { Task } from './model';

/** 远端快照之间按本机单调时钟补齐展示耗时，避免服务器时钟差或系统时间调整造成跳动。 */
export function useTaskClock(task: Task): Task {
  const active = task.status === 'running' || task.status === 'cancelling';
  const [clock, setClock] = useState(() => ({
    snapshot: task,
    display: task,
    anchor: performance.now(),
    now: performance.now(),
  }));
  const current =
    clock.snapshot === task
      ? clock
      : {
          snapshot: task,
          display:
            active &&
            clock.snapshot.id === task.id &&
            ['running', 'cancelling'].includes(clock.snapshot.status)
              ? rebaseClock(
                  task,
                  advanceClock(clock.display, Math.max(0, performance.now() - clock.anchor) / 1000),
                )
              : task,
          anchor: performance.now(),
          now: performance.now(),
        };
  if (clock.snapshot !== task) setClock(current);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(
      () => setClock((old) => ({ ...old, now: performance.now() })),
      250,
    );
    return () => window.clearInterval(timer);
  }, [task.id, active]);
  if (!active) return task;
  const delta = Math.max(0, current.now - current.anchor) / 1000;
  return advanceClock(current.display, delta);
}

function advanceClock(task: Task, delta: number): Task {
  const steps = (items: Task['buildSteps']) =>
    items.map((step) =>
      step.status === 'running' ? { ...step, elapsed: (step.elapsed || 0) + delta } : step,
    );
  return {
    ...task,
    elapsed: task.elapsed + delta,
    buildSteps: steps(task.buildSteps),
    targets: task.targets.map((run) =>
      ['running', 'rollingback'].includes(run.status)
        ? { ...run, elapsed: run.elapsed + delta, steps: steps(run.steps) }
        : run,
    ),
  };
}

/** 新快照可能晚于页面到达，或远端与本机存在时钟差；同一步骤的展示耗时不能倒退。 */
function rebaseClock(task: Task, previous: Task): Task {
  const merge = (steps: Task['buildSteps'], old: Task['buildSteps']) =>
    steps.map((step) => {
      const before = old.find((s) => s.key === step.key);
      return step.status === 'running' &&
        before?.status === 'running' &&
        step.startedAt === before.startedAt
        ? { ...step, elapsed: Math.max(step.elapsed || 0, before.elapsed || 0) }
        : step;
    });
  return {
    ...task,
    elapsed: Math.max(task.elapsed, previous.elapsed),
    buildSteps: merge(task.buildSteps, previous.buildSteps),
    targets: task.targets.map((run) => {
      const before = previous.targets.find((r) => r.target.id === run.target.id);
      return before &&
        ['running', 'rollingback'].includes(run.status) &&
        ['running', 'rollingback'].includes(before.status)
        ? {
            ...run,
            elapsed: Math.max(run.elapsed, before.elapsed),
            steps: merge(run.steps, before.steps),
          }
        : run;
    }),
  };
}
