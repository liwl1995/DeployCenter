import { useEffect, useRef, useState } from 'react';
const iso = (year: number, month: number, day: number) =>
  year + '-' + String(month + 1).padStart(2, '0') + '-' + String(day).padStart(2, '0');
/** 使用应用自己的日历面板，避免原生日期弹层与主题和缩放表现不一致。 */
export function DateFilter({
  id,
  value,
  onChange,
}: {
  id?: string;
  value: string;
  onChange: (date: string) => void;
}) {
  const [open, setOpen] = useState(false),
    [month, setMonth] = useState(() => {
      const d = value ? new Date(value + 'T12:00:00') : new Date();
      return new Date(d.getFullYear(), d.getMonth(), 1);
    });
  const root = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  const first = new Date(month.getFullYear(), month.getMonth(), 1).getDay(),
    count = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  return (
    <div
      className="date-control"
      ref={root}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          close();
        }
      }}
    >
      <button
        ref={trigger}
        id={id}
        className="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {value || '全部日期'}
      </button>
      {open && (
        <div className="date-calendar" role="group" aria-label="选择部署日期">
          <div className="row spread">
            <button
              className="button"
              aria-label="上个月"
              onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
            >
              ‹
            </button>
            <strong>
              {month.getFullYear()} 年 {month.getMonth() + 1} 月
            </strong>
            <button
              className="button"
              aria-label="下个月"
              onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
            >
              ›
            </button>
          </div>
          <div className="date-days">
            {['日', '一', '二', '三', '四', '五', '六'].map((d) => (
              <span key={d}>{d}</span>
            ))}
            {Array.from({ length: first }, (_, i) => (
              <span key={'empty-' + i} />
            ))}
            {Array.from({ length: count }, (_, i) => (
              <button
                className={
                  value === iso(month.getFullYear(), month.getMonth(), i + 1) ? 'selected' : ''
                }
                key={i}
                aria-label={iso(month.getFullYear(), month.getMonth(), i + 1)}
                aria-pressed={value === iso(month.getFullYear(), month.getMonth(), i + 1)}
                onClick={() => {
                  onChange(iso(month.getFullYear(), month.getMonth(), i + 1));
                  close();
                }}
              >
                {i + 1}
              </button>
            ))}
          </div>
          <button
            className="button block"
            onClick={() => {
              onChange('');
              close();
            }}
          >
            清除日期筛选
          </button>
        </div>
      )}
    </div>
  );
}
