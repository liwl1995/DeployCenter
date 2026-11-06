import { useEffect, useRef, useState } from 'react';
import type { DesktopAPI, DesktopEvent } from './platform';
import { desktop } from './platform';
import { LogAccumulator, logLevel, type LogLine } from './log-model';
import { VirtualLogs } from './LogViewer';
/** 原始日志按范围分批读取，实时追加与较早页面分开，避免重复或覆盖用户正在复制的行。 */
export function NativeLogPanel({
  active = true,
  taskId,
  targetId,
  initial,
  focusStep,
  focusError,
  api = desktop!,
}: {
  active?: boolean;
  taskId: string;
  targetId: string;
  initial: string[];
  focusStep?: ({ name: string } | { names: string[] }) & { nonce: number };
  focusError?: number;
  api?: DesktopAPI;
}) {
  const [lines, setLines] = useState<LogLine[]>([]),
    [more, setMore] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [ready, setReady] = useState(false),
    [focusLine, setFocusLine] = useState<{ id: string; nonce: number }>();
  const epoch = useRef(0);
  const loader = useRef<(() => Promise<boolean>) | undefined>(undefined),
    currentLines = useRef<LogLine[]>([]),
    hasMore = useRef(false),
    cancelled = useRef(false),
    loading = useRef(false);
  useEffect(() => {
    epoch.current++;
    setReady(false);
    setBusy(false);
    loading.current = false;
    let alive = true,
      loaded = false;
    cancelled.current = false;
    const collector = new LogAccumulator();
    collector.load('initial', initial);
    setLines([...collector.entries]);
    let olderBuild: LogLine[] = [],
      olderTarget: LogLine[] = [],
      before = { build: 0, target: 0 };
    const publish = () => {
      if (!alive) return;
      const data = [
        ...olderBuild,
        ...collector.entries.filter((l) => l.id.startsWith('build:')),
        ...olderTarget,
        ...collector.entries.filter((l) => !l.id.startsWith('build:')),
      ];
      currentLines.current = data;
      setLines(data);
      hasMore.current = before.build > 0 || before.target > 0;
      setMore(hasMore.current);
    };
    const pending: Extract<DesktopEvent, { kind: 'log' }>[] = [];
    const append = (event: (typeof pending)[number]) => {
      collector.append(
        event.targetId || 'build',
        event.text,
        event.offset === undefined
          ? undefined
          : event.offset - new TextEncoder().encode(event.text).length,
        event.context,
      );
      publish();
    };
    const off = api.onEvent((event) => {
      if (
        event.kind !== 'log' ||
        event.taskId !== taskId ||
        (event.targetId && event.targetId !== targetId)
      )
        return;
      if (loaded) append(event);
      else pending.push(event);
    });
    loader.current = async () => {
      if (!loaded || !alive || !hasMore.current) return false;
      const value = await api.readLogs(taskId, targetId, before);
      if (!alive) return false;
      const b = new LogAccumulator(),
        t = new LogAccumulator();
      b.load('build', value.build, value.buildStart, value.buildContexts);
      t.load(targetId, value.target, value.targetStart, value.targetContexts);
      olderBuild = [...b.entries, ...olderBuild];
      olderTarget = [...t.entries, ...olderTarget];
      const old = before;
      before = { build: value.buildStart || 0, target: value.targetStart || 0 };
      if (before.build >= old.build && before.target >= old.target)
        before = { build: 0, target: 0 };
      publish();
      return true;
    };
    void api
      .readLogs(taskId, targetId)
      .then((value) => {
        if (!alive) return;
        collector.entries = [];
        collector.load('build', value.build, value.buildStart, value.buildContexts);
        collector.load(targetId, value.target, value.targetStart, value.targetContexts);
        before = { build: value.buildStart || 0, target: value.targetStart || 0 };
        loaded = true;
        for (const event of pending) append(event);
        publish();
        setReady(true);
      })
      .catch((e) => {
        if (alive) {
          loaded = true;
          setError(String(e));
          for (const event of pending) append(event);
        }
      });
    return () => {
      alive = false;
      cancelled.current = true;
      loader.current = undefined;
      off();
    };
  }, [api, taskId, targetId]);
  const readEarlier = async (locate?: { steps?: string[]; error?: boolean }) => {
    if (loading.current) {
      setMessage('正在加载较早日志，请等待或取消后重试定位。');
      return;
    }
    const requestEpoch = epoch.current;
    loading.current = true;
    cancelled.current = false;
    setBusy(true);
    setError('');
    setMessage(locate ? '正在分批查找较早日志，可取消。' : '正在加载较早日志…');
    try {
      const find = () =>
        currentLines.current.find((l) =>
          locate?.steps ? locate.steps.includes(l.step || '') : logLevel(l.text) === 'error',
        );
      if (locate)
        while (
          epoch.current === requestEpoch &&
          hasMore.current &&
          !cancelled.current &&
          (locate.error || !find())
        ) {
          if (!(await loader.current?.())) break;
        }
      else await loader.current?.();
      if (epoch.current === requestEpoch && !cancelled.current) {
        const line = locate ? find() : currentLines.current[0];
        if (line) {
          setFocusLine({ id: line.id, nonce: Date.now() });
          setMessage('已定位到已加载的日志。');
        } else
          setMessage(
            locate?.steps
              ? '此步骤没有可定位日志，旧记录可能缺少步骤信息。'
              : '未找到错误行，请检查完整原始日志。',
          );
      }
    } catch (e) {
      if (epoch.current === requestEpoch && !cancelled.current) setError(String(e));
    } finally {
      if (epoch.current === requestEpoch) {
        loading.current = false;
        if (!cancelled.current) setBusy(false);
      }
    }
  };
  const lastStep = useRef<number | undefined>(undefined),
    lastError = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (ready && focusStep && lastStep.current !== focusStep.nonce) {
      lastStep.current = focusStep.nonce;
      void readEarlier({ steps: "names" in focusStep ? focusStep.names : [focusStep.name] });
    }
  }, [focusStep, ready]);
  useEffect(() => {
    if (ready && focusError && lastError.current !== focusError) {
      lastError.current = focusError;
      void readEarlier({ error: true });
    }
  }, [focusError, ready]);
  return (
    <>
      {more && (
        <p className="note">还有更早日志未加载，点击步骤会分批定位；也可导出完整原始日志。</p>
      )}
      <div className="row wrap">
        {more && (
          <button className="button" disabled={busy} onClick={() => void readEarlier()}>
            加载更早日志
          </button>
        )}
        {busy && (
          <button
            className="button"
            onClick={() => {
              cancelled.current = true;
              setBusy(false);
              setMessage('已取消定位，当前读取完成后停止；已加载日志保留。');
            }}
          >
            取消加载
          </button>
        )}
      </div>
      {message && (
        <p role="status" className="note">
          {message}
        </p>
      )}
      {error && (
        <p className="warning" role="alert">
          {error}
        </p>
      )}
      <VirtualLogs
        active={active}
        entries={lines}
        focusLine={focusLine}
        onExport={() => void api.exportLogs(taskId, targetId).catch((e) => setError(String(e)))}
      />
    </>
  );
}
