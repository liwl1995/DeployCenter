import { useEffect, useRef } from 'react';
import { prototype } from './defaults';
import { desktop } from './platform';

const fixture = prototype && !desktop;

export function HistoryLogViewer({ lines, active = true }: { lines: string[]; active?: boolean }) {
  const ref = useRef<HTMLPreElement>(null);
  const follow = useRef(true);
  useEffect(() => {
    if (active && follow.current && ref.current && !window.getSelection()?.toString())
      ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines.length, active]);
  return (
    <pre
      className="terminal"
      ref={ref}
      onScroll={(e) => {
        if (!active) return;
        const el = e.currentTarget;
        follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
      }}
      aria-label="任务日志"
    >
      <span className="terminal-caption">
        {fixture ? '模拟任务日志 · 未连接服务器' : '执行日志'}
      </span>
      {lines.map((line, i) => (
        <span
          key={i}
          className={line.includes('错误') ? 'log-error' : line.includes('回滚') ? 'log-warn' : ''}
        >
          {line}
        </span>
      ))}
    </pre>
  );
}
