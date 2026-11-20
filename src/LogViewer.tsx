import { Button } from './design/ui/button';
import type { ReactNode } from 'react';
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { fmtTime } from './model';
import { logLevel, type LogLine } from './log-model';
import { copyText } from './clipboard';
import { LogWrapContext } from './log-wrap';
const height = 28;
type Row = { id: string; kind: 'group' | 'command' | 'line'; step: string; line: LogLine };
function rowAt(offsets: number[] | undefined, position: number) {
  if (!offsets) return Math.floor(position / height);
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (offsets[middle] <= position) low = middle;
    else high = middle - 1;
  }
  return low;
}

export function VirtualLogs({
  active = true,
  compact = false,
  initialFollow = true,
  following,
  onFollowingChange,
  latest,
  showToolbar = true,
  grouped = true,
  label = '任务日志',
  trailing,
  entries,
  focusStep,
  focusError,
  focusLine,
  onExport,
}: {
  entries: LogLine[];
  active?: boolean;
  compact?: boolean;
  initialFollow?: boolean;
  following?: boolean;
  onFollowingChange?: (follow: boolean) => void;
  latest?: number;
  showToolbar?: boolean;
  grouped?: boolean;
  label?: string;
  trailing?: ReactNode;
  focusLine?: { id: string; nonce: number };
  focusStep?: { name: string; nonce: number };
  focusError?: number;
  onExport?: () => void;
}) {
  const root = useRef<HTMLDivElement>(null),
    viewport = useRef<HTMLDivElement>(null),
    content = useRef<HTMLDivElement>(null),
    batch = useRef<HTMLDivElement>(null),
    frozen = useRef(entries);
  const wrap = useContext(LogWrapContext);
  const [measured, setMeasured] = useState({ width: 0, heights: new Map<string, number>() });
  const focusedError = useRef<number>(undefined);
  const automaticTop = useRef<number | undefined>(undefined);
  const [selected, setSelected] = useState(false),
    [top, setTop] = useState(0),
    [internalFollow, setInternalFollow] = useState(initialFollow);
  const follow = following ?? internalFollow;
  const setFollow = onFollowingChange ?? setInternalFollow;
  const [level, setLevel] = useState('all'),
    [query, setQuery] = useState(''),
    [hit, setHit] = useState(-1);
  const [located, setLocated] = useState<string>(),
    [collapsed, setCollapsed] = useState(new Set<string>()),
    [jump, setJump] = useState<string>(),
    [message, setMessage] = useState('');
  const visibleEntries = selected ? frozen.current : entries;
  if (!selected) frozen.current = entries;
  useEffect(() => {
    const change = () => {
      const selection = window.getSelection();
      const inside =
        !!selection?.toString() &&
        !!selection.rangeCount &&
        !!root.current?.contains(selection.getRangeAt(0).commonAncestorContainer);
      setSelected(inside);
    };
    document.addEventListener('selectionchange', change);
    return () => document.removeEventListener('selectionchange', change);
  }, []);
  const filtered = useMemo(
    () =>
      visibleEntries.filter(
        (line) =>
          level === 'all' ||
          (level === 'error' ? logLevel(line.text) === 'error' : logLevel(line.text) !== 'info'),
      ),
    [visibleEntries, level],
  );
  const hits = useMemo(
    () =>
      query
        ? filtered.filter((line) =>
            line.text.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
          )
        : [],
    [filtered, query],
  );
  const rows = useMemo(() => {
    const result: Row[] = [];
    if (!grouped) return filtered.map((line) => ({ id: line.id, kind: 'line' as const, line, step: '' }));
    let previous = '',
      command = '';
    for (const line of filtered) {
      const step = line.step || '未记录步骤';
      if (step !== previous) {
        result.push({ id: 'group:' + line.id, kind: 'group', step, line });
        previous = step;
        command = '';
      }
      if (collapsed.has(step)) continue;
      if (line.command && line.command !== command) {
        result.push({ id: 'command:' + line.id, kind: 'command', step, line });
        command = line.command;
      }
      result.push({ id: line.id, kind: 'line', step, line });
    }
    return result;
  }, [filtered, collapsed, grouped]);
  const offsets = useMemo(() => {
    if (!wrap) return undefined;
    // 只测量已进入虚拟窗口的行，其他行以单行高度估算。
    const result = [0];
    for (const row of rows)
      result.push(result[result.length - 1] + (measured.heights.get(row.id) ?? height));
    return result;
  }, [rows, wrap, measured]);
  const rowOffset = (index: number) => offsets?.[index] ?? index * height;
  const jumpTo = (line: LogLine) => {
    setLocated(line.id);
    setFollow(false);
    setCollapsed((old) => {
      const next = new Set(old);
      next.delete(line.step || '未记录步骤');
      return next;
    });
    setJump(line.id);
  };
  useEffect(() => {
    if (focusLine) {
      const line = entries.find((l) => l.id === focusLine.id);
      if (line) {
        setQuery('');
        setLevel('all');
        jumpTo(line);
      }
    }
  }, [focusLine]);
  const move = (direction: number) => {
    if (!hits.length) return;
    const next =
      hit < 0
        ? direction > 0
          ? 0
          : hits.length - 1
        : (hit + direction + hits.length) % hits.length;
    setHit(next);
    jumpTo(hits[next]);
  };
  useEffect(() => {
    if (focusStep) {
      const line = entries.find((x) => x.step === focusStep.name);
      if (line) {
        setLevel('all');
        jumpTo(line);
      } else setMessage('此步骤没有可定位日志，旧记录可能缺少步骤信息。');
    }
  }, [focusStep]);
  useEffect(() => {
    if (!focusError || focusedError.current === focusError) return;
    const line = entries.find((x) => logLevel(x.text) === 'error');
    if (line) {
      focusedError.current = focusError;
      setLevel('all');
      jumpTo(line);
    }
  }, [focusError, entries]);
  const lastJump = useRef(latest);
  const previousLayout = useRef({ rows, offsets });
  useLayoutEffect(() => {
    const el = viewport.current;
    // 隐藏区域和选中的文字需要保留原滚动位置。
    if (!active || !el || selected) return;
    const previous = previousLayout.current;
    previousLayout.current = { rows, offsets };
    const scrollTo = (next: number) => {
      if (el.scrollTop !== next) el.scrollTop = next;
      automaticTop.current = el.scrollTop;
      setTop(el.scrollTop);
    };
    // 以真实滚动内容为准，包含上传区换行、底部留白和横向滚动条占用。
    const end = () => Math.max(0, (el.scrollHeight || rowOffset(rows.length)) - el.clientHeight);
    if (jump) {
      const index = rows.findIndex((r) => r.id === jump);
      if (index >= 0) {
        scrollTo(Math.min(rowOffset(index), end()));
        setJump(undefined);
      }
    } else if (follow || latest !== lastJump.current) {
      lastJump.current = latest;
      scrollTo(end());
      // 横向滚动条随可见长行出现或消失时，实际视口高度也会变化。
      if (follow && typeof ResizeObserver !== 'undefined') {
        const observer = new ResizeObserver(() => scrollTo(end()));
        observer.observe(el);
        if (content.current) observer.observe(content.current);
        return () => observer.disconnect();
      }
    } else if (previous.rows === rows && previous.offsets !== offsets) {
      // 改变宽度或折行模式时，暂停跟随的读者继续看原来的日志行。
      const index = Math.min(rowAt(previous.offsets, top), rows.length - 1);
      if (index >= 0) {
        const previousTop = previous.offsets?.[index] ?? index * height;
        const inset = Math.min(top - previousTop, rowOffset(index + 1) - rowOffset(index) - 1);
        scrollTo(Math.min(rowOffset(index) + inset, end()));
      }
    } else {
      setTop(el.scrollTop);
    }
  }, [rows, offsets, follow, jump, selected, active, !!trailing, level, latest]);
  const copy = async () => {
    const text = entries.map((r) => r.text).join('\n');
    try {
      await copyText(text);
      setMessage('已复制全部已加载日志。');
    } catch {
      setMessage('复制失败，请稍后重试。可先选中文字后按 Ctrl+C 复制。');
    }
  };
  const [frozenTop, setFrozenTop] = useState(0);
  useEffect(() => {
    if (!selected) setFrozenTop(top);
  }, [top, selected]);
  const start = Math.min(
      Math.max(0, rows.length - 40),
      Math.max(0, rowAt(offsets, selected ? frozenTop : top) - 8),
    ),
    end = Math.min(rows.length, start + 40);
  useLayoutEffect(() => {
    const el = viewport.current;
    const visible = batch.current;
    if (!wrap || !active || selected || !el || !visible) return;
    const measure = () => {
      const width = el.clientWidth;
      if (!width) return;
      const sizes = Array.from(visible.children, (child) => {
        const element = child as HTMLElement;
        return [element.dataset.logRow!, element.offsetHeight] as const;
      });
      setMeasured((previous) => {
        const sameWidth = width === previous.width;
        if (sameWidth && sizes.every(([id, size]) => (previous.heights.get(id) ?? height) === size))
          return previous;
        const heights = new Map(sameWidth ? previous.heights : []);
        for (const [id, size] of sizes) heights.set(id, size || height);
        return { width, heights };
      });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    observer.observe(visible);
    return () => observer.disconnect();
  }, [wrap, active, selected, rows, start, end]);
  return (
    <div className="log-viewer" ref={root}>
      {showToolbar && (compact ? (
        <div className="log-toolbar log-toolbar-compact">
          <h2 className="log-heading">执行日志</h2>
          <select
            aria-label="日志级别"
            value={level}
            onChange={(event) => setLevel(event.target.value)}
          >
            <option value="all">全部级别</option>
            <option value="warning">警告及错误</option>
            <option value="error">只看错误</option>
          </select>
          <label className="check-row">
            <input
              type="checkbox"
              className="ui-checkbox"
              checked={follow}
              onChange={(event) => {
                setFollow(event.target.checked);
                if (event.target.checked) setJump(undefined);
              }}
            />
            跟随最新
          </label>
        </div>
      ) : (
        <>
          <div className="log-toolbar">
            <input
              aria-label="搜索日志"
              placeholder="搜索当前日志"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setHit(-1);
              }}
            />
            <span role="status">
              {hits.length} 处命中{hit >= 0 && hits.length ? ' · 第 ' + (hit + 1) + ' 处' : ''}
            </span>
            <Button variant="neutral" size="compact" disabled={!hits.length} onClick={() => move(-1)}>
              上一处
            </Button>
            <Button variant="neutral" size="compact" disabled={!hits.length} onClick={() => move(1)}>
              下一处
            </Button>
            <select aria-label="日志级别" value={level} onChange={(e) => setLevel(e.target.value)}>
              <option value="all">全部级别</option>
              <option value="warning">警告及错误</option>
              <option value="error">只看错误</option>
            </select>
          </div>
          <div className="row wrap mt">
            <label className="check-row">
              <input
                type="checkbox"
                className="ui-checkbox"
                checked={follow}
                onChange={(e) => setFollow(e.target.checked)}
              />
              跟随最新
            </label>
            {!follow && (
              <Button
                variant="neutral" size="compact"
                onClick={() => {
                  setQuery('');
                  setHit(-1);
                  setLevel('all');
                  setCollapsed(new Set());
                  setFollow(true);
                }}
              >
                跳到最新
              </Button>
            )}
            <Button variant="neutral" size="compact" onClick={() => void copy()}>
              复制已加载日志
            </Button>
            {onExport && (
              <Button variant="neutral" size="compact" onClick={onExport}>
                导出完整日志
              </Button>
            )}
          </div>
          <p className="note">
            显示接收时间与接收时的步骤上下文；旧日志缺失的信息标为未记录。共 {entries.length}{' '}
            行，当前筛选 {filtered.length} 行。
          </p>
        </>
      ))}
      {showToolbar && !compact && message && (
        <p className="note" role="status">
          {message}
        </p>
      )}
      <div
        className="log-viewport"
        data-wrap={wrap}
        aria-label={label}
        role="log"
        ref={viewport}
        onScroll={(e) => {
          if (!active) return;
          const el = e.currentTarget;
          if (selected) return;
          const next = el.scrollTop;
          setTop(next);
          // 程序跟随和横向滚动都会触发 scroll。只有纵向位置实际离开末尾才暂停跟随。
          if (next !== automaticTop.current && el.scrollHeight - next - el.clientHeight > 40) {
            automaticTop.current = undefined;
            setFollow(false);
          }
        }}
      >
        <div ref={content} className="log-content">
          <div style={{ height: rowOffset(rows.length), position: 'relative', minWidth: '100%' }}>
            <div ref={batch} style={{ position: 'absolute', top: rowOffset(start), minWidth: '100%', width: wrap ? '100%' : undefined }}>
              {rows.slice(start, end).map((row) =>
                row.kind === 'group' ? (
                  <div key={row.id} className="log-group" data-log-row={row.id}>
                    <button
                      aria-expanded={!collapsed.has(row.step)}
                      onClick={() =>
                        setCollapsed((old) => {
                          const next = new Set(old);
                          if (next.has(row.step)) next.delete(row.step);
                          else next.add(row.step);
                          return next;
                        })
                      }
                    >
                      {collapsed.has(row.step) ? '展开' : '收起'} · {row.step}
                    </button>
                  </div>
                ) : row.kind === 'command' ? (
                  <div key={row.id} className="log-command" title={row.line.command} data-log-row={row.id}>
                    命令上下文：{row.line.command}
                  </div>
                ) : (
                  <div
                    data-log-line
                    data-log-row={row.id}
                    key={row.id}
                    className={
                      'log-line ' +
                      logLevel(row.line.text) +
                      (row.line.id === located ? ' log-match' : '')
                    }
                  >
                    <time>
                      {row.line.time !== undefined
                        ? fmtTime(new Date(row.line.time).toISOString())
                        : '时间未记录'}
                    </time>
                    <span className="log-level">
                      {{ error: '错误', warning: '警告', info: '信息' }[logLevel(row.line.text)]}
                    </span>
                    <span className="log-text">{row.line.text || ' '}</span>
                  </div>
                ),
              )}
            </div>
          </div>
          {trailing}
        </div>
      </div>
    </div>
  );
}
