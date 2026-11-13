import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { fmtTime } from './model';
import { logLevel, type LogLine } from './log-model';
import { download } from './ui';
const height = 28;
type Row = { id: string; kind: 'group' | 'command' | 'line'; step: string; line: LogLine };
export function VirtualLogs({
  active = true,
  compact = false,
  entries,
  focusStep,
  focusError,
  focusLine,
  onExport,
}: {
  entries: LogLine[];
  active?: boolean;
  compact?: boolean;
  focusLine?: { id: string; nonce: number };
  focusStep?: { name: string; nonce: number };
  focusError?: number;
  onExport?: () => void;
}) {
  const root = useRef<HTMLDivElement>(null),
    viewport = useRef<HTMLDivElement>(null),
    frozen = useRef(entries);
  const focusedError = useRef<number>(undefined);
  const automaticTop = useRef<number | undefined>(undefined);
  const [selected, setSelected] = useState(false),
    [top, setTop] = useState(0),
    [follow, setFollow] = useState(true);
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
  }, [filtered, collapsed]);
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
  useLayoutEffect(() => {
    const el = viewport.current;
    // 隐藏区域和选中的文字需要保留原滚动位置。
    if (!active || !el || selected) return;
    const scrollTo = (next: number) => {
      if (el.scrollTop !== next) el.scrollTop = next;
      automaticTop.current = el.scrollTop;
      setTop(el.scrollTop);
    };
    const end = () => Math.max(0, rows.length * height - (el.clientHeight || 420));
    if (jump) {
      const index = rows.findIndex((r) => r.id === jump);
      if (index >= 0) {
        scrollTo(Math.min(index * height, end()));
        setJump(undefined);
      }
    } else if (follow) {
      scrollTo(end());
      // 横向滚动条随可见长行出现或消失时，实际视口高度也会变化。
      if (typeof ResizeObserver !== 'undefined') {
        const observer = new ResizeObserver(() => scrollTo(end()));
        observer.observe(el);
        return () => observer.disconnect();
      }
    } else {
      setTop(el.scrollTop);
    }
  }, [rows, follow, jump, selected, active]);
  const copy = async () => {
    const text = entries.map((r) => r.text).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setMessage('已复制全部已加载日志。');
    } catch {
      download('任务日志.log', text);
      setMessage('剪贴板不可用，已下载已加载日志。');
    }
  };
  const [frozenTop, setFrozenTop] = useState(0);
  useEffect(() => {
    if (!selected) setFrozenTop(top);
  }, [top, selected]);
  const start = Math.min(
      Math.max(0, rows.length - 40),
      Math.max(0, Math.floor((selected ? frozenTop : top) / height) - 8),
    ),
    end = Math.min(rows.length, start + 40);
  return (
    <div className="log-viewer" ref={root}>
      {compact ? (
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
            <button className="button" disabled={!hits.length} onClick={() => move(-1)}>
              上一处
            </button>
            <button className="button" disabled={!hits.length} onClick={() => move(1)}>
              下一处
            </button>
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
                checked={follow}
                onChange={(e) => setFollow(e.target.checked)}
              />
              跟随最新
            </label>
            {!follow && (
              <button
                className="button"
                onClick={() => {
                  setQuery('');
                  setHit(-1);
                  setLevel('all');
                  setCollapsed(new Set());
                  setFollow(true);
                }}
              >
                跳到最新
              </button>
            )}
            <button className="button" onClick={() => void copy()}>
              复制已加载日志
            </button>
            {onExport && (
              <button className="button" onClick={onExport}>
                导出完整日志
              </button>
            )}
          </div>
          <p className="note">
            显示接收时间与接收时的步骤上下文；旧日志缺失的信息标为未记录。共 {entries.length}{' '}
            行，当前筛选 {filtered.length} 行。{selected && '正在选择文字，暂停刷新和虚拟滚动。'}
          </p>
        </>
      )}
      {compact && selected && (
        <p className="note" role="status">
          正在选择文字，暂停刷新。
        </p>
      )}
      {!compact && message && (
        <p className="note" role="status">
          {message}
        </p>
      )}
      <div
        className="log-viewport"
        aria-label="任务日志"
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
        <div style={{ height: rows.length * height, position: 'relative', minWidth: '100%' }}>
          <div style={{ position: 'absolute', top: start * height, minWidth: '100%' }}>
            {rows.slice(start, end).map((row) =>
              row.kind === 'group' ? (
                <div key={row.id} className="log-group">
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
                <div key={row.id} className="log-command" title={row.line.command}>
                  命令上下文：{row.line.command}
                </div>
              ) : (
                <div
                  data-log-line
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
      </div>
    </div>
  );
}
