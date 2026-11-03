import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X, Check } from 'lucide-react';
import { type Step, seconds } from './model';
import { desktop } from './platform';
export function Badge({ children, kind = '' }: { children: ReactNode; kind?: string }) {
  return <span className={'badge ' + kind}>{children}</span>;
}
export function Card({
  title,
  action,
  children,
  className = '',
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={'card ' + className}>
      {title && (
        <div className="card-head">
          <h2>{title}</h2>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}
export function Field({
  label,
  hint,
  children,
  wide,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <label className={'field ' + (wide ? 'wide' : '')}>
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function Switch({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  description?: string;
}) {
  return (
    <label className="switch-row">
      <span>
        <strong>{label}</strong>
        {description && <small>{description}</small>}
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        aria-label={label}
      />
    </label>
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const panel = ref.current!;
    const controls = () =>
      [
        ...panel.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href]',
        ),
      ].filter((e) => !e.closest('[hidden]'));
    (
      panel.querySelector<HTMLElement>('[data-autofocus]') ||
      panel.querySelector<HTMLElement>('input,select,textarea') ||
      controls()[0]
    )?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close.current();
      }
      if (e.key === 'Tab') {
        const all = controls(),
          first = all[0],
          last = all.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    panel.addEventListener('keydown', key);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      panel.removeEventListener('keydown', key);
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <div className="overlay">
      <div
        className={'modal ' + (wide ? 'modal-wide' : '')}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        ref={ref}
      >
        <header>
          <div>
            <span className="eyebrow">DEPLOY CENTER</span>
            <h2 id={id}>{title}</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭弹窗">
            <X size={20} />
          </button>
        </header>
        <div className="modal-content">{children}</div>
      </div>
    </div>
  );
}
export function Steps({
  labels,
  details,
  current,
  failed,
  cancelled,
  finished,
}: {
  labels: string[];
  details?: Step[];
  current: number;
  failed?: boolean;
  cancelled?: boolean;
  finished?: boolean;
}) {
  return (
    <ol className="steps">
      {labels.map((name, i) => {
        const detail = details?.[i];
        const status =
          detail?.status ||
          (failed && i === current
            ? 'failed'
            : i < current || finished
              ? 'success'
              : i === current && !cancelled
                ? 'running'
                : 'pending');
        const text = {
          success: '已完成',
          failed: '失败',
          skipped: '未执行',
          pending: cancelled ? '未执行' : '等待',
          running: '进行中',
        }[status];
        return (
          <li
            key={i}
            className={
              status === 'success'
                ? 'done'
                : status === 'running'
                  ? 'active'
                  : status === 'failed'
                    ? 'failed'
                    : ''
            }
          >
            <span className="step-dot">
              {status === 'success' ? <Check size={13} /> : status === 'failed' ? '!' : i + 1}
            </span>
            <span>{name}</span>
            <small>
              {text}
              {details && ' · ' + seconds(detail?.elapsed || 0)}
            </small>
          </li>
        );
      })}
    </ol>
  );
}
export function Demo({ children }: { children: ReactNode }) {
  return (
    <div className="demo-controls" role="group" aria-label="演示控件">
      <Badge>演示</Badge>
      {children}
    </div>
  );
}
export function download(name: string, content: string, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([content], { type: type + ';charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function PathInput({
  value,
  onChange,
  kind,
  required,
  disabled,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  kind: 'directory' | 'jar' | 'key' | 'maven';
  label?: string;
  required?: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="path-input">
      <input
        aria-label={label}
        required={required}
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {desktop && (
        <button
          type="button"
          className="button"
          disabled={disabled}
          onClick={() =>
            void desktop!.choose(kind).then((path) => {
              if (path) onChange(path);
            })
          }
        >
          浏览…
        </button>
      )}
    </div>
  );
}
