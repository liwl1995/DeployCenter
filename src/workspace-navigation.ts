import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { WorkspacePage } from './workspace-model';

type View = { page: WorkspacePage; returnPage: WorkspacePage };

/** 任务是从工作区打开的详情。切换任务时保留原来的返回位置。 */
export function useWorkspaceNavigation(initialPage: WorkspacePage = 'deploy') {
  const [view, setView] = useState<View>({ page: initialPage, returnPage: 'deploy' });
  const current = useRef(view);
  const mainRef = useRef<HTMLElement>(null);
  const serviceScrollRef = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<WorkspacePage, { main: number; service: number }>());

  const navigate = useCallback((page: WorkspacePage, taskSource?: WorkspacePage) => {
    const previous = current.current;
    if (previous.page === page) return;
    positions.current.set(previous.page, {
      main: mainRef.current?.scrollTop ?? 0,
      service: serviceScrollRef.current?.scrollTop ?? 0,
    });
    const returnPage = page === 'task' ? (taskSource ?? previous.page) : previous.returnPage;
    current.current = { page, returnPage };
    setView(current.current);
  }, []);

  const openTask = useCallback((source?: WorkspacePage) => navigate('task', source), [navigate]);
  const returnFromTask = () => navigate(current.current.returnPage);

  useLayoutEffect(() => {
    const saved = view.page === 'task' ? undefined : positions.current.get(view.page);
    if (mainRef.current) mainRef.current.scrollTop = saved?.main ?? 0;
    if (serviceScrollRef.current) serviceScrollRef.current.scrollTop = saved?.service ?? 0;
  }, [view.page]);

  return { ...view, navigate, openTask, returnFromTask, mainRef, serviceScrollRef };
}
