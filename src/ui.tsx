import {
  useEffect,
  useLayoutEffect,
  useState,
  useId,
  useRef,
  cloneElement,
  isValidElement,
  type ReactNode,
  type ReactElement,
} from 'react';
import { createPortal } from 'react-dom';
import { helpFor } from './field-help';
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
/** 提示放到页面浮层，避免在矮窗口或弹窗滚动区域内被裁掉。 */
function FieldHelp({ label, text }: { label: string; text: string }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const tooltip = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number }>();
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
  };
  const show = () => {
    clear();
    setOpen(true);
  };
  const leave = () => {
    clear();
    if (document.activeElement !== trigger.current)
      timer.current = setTimeout(() => setOpen(false), 150);
  };
  useEffect(() => () => clear(), []);
  useLayoutEffect(() => {
    if (!open || !trigger.current || !tooltip.current) return;
    const anchor = trigger.current.getBoundingClientRect();
    const tip = tooltip.current.getBoundingClientRect();
    const left = Math.max(12, Math.min(anchor.left, window.innerWidth - tip.width - 12));
    const below = anchor.bottom + 8;
    const top =
      below + tip.height <= window.innerHeight - 12
        ? below
        : Math.max(12, anchor.top - tip.height - 8);
    setPosition({ left, top });
    const close = () => setOpen(false);
    window.addEventListener('resize', close);
    document.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('resize', close);
      document.removeEventListener('scroll', close, true);
    };
  }, [open]);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="help-trigger"
        aria-label={label + '说明'}
        aria-describedby={open ? id : undefined}
        onMouseEnter={show}
        onMouseLeave={leave}
        onFocus={show}
        onBlur={() => setOpen(false)}
        onKeyDownCapture={(event) => {
          if (event.key === 'Escape' && open) {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
          }
        }}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="1" y="1" width="14" height="14" rx="3.5" />
          <path d="M6 6a2.2 2.2 0 0 1 4.3.7c0 1.7-2.3 1.8-2.3 3.2M8 12.7h.01" />
        </svg>
      </button>
      {open &&
        createPortal(
          <span
            ref={tooltip}
            className="field-tooltip"
            role="tooltip"
            id={id}
            style={{
              left: position?.left ?? 0,
              top: position?.top ?? 0,
              visibility: position ? 'visible' : 'hidden',
            }}
            onMouseEnter={show}
            onMouseLeave={leave}
          >
            {text}
          </span>,
          document.body,
        )}
    </>
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
  const id = useId();
  const help = helpFor(label);
  return (
    <div className={'field ' + (wide ? 'wide' : '')}>
      <div className="field-label">
        <label htmlFor={id}>{label}</label>
        {help && <FieldHelp label={label} text={help} />}
      </div>
      {isValidElement(children)
        ? cloneElement(children as ReactElement<{ id?: string }>, { id })
        : children}
      {hint && <small>{hint}</small>}
    </div>
  );
}
export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
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
        disabled={disabled}
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
  footer,
  returnFocus,
  onClose,
  wide = false,
  closeDisabled = false,
}: {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  returnFocus?: HTMLElement;
  onClose: () => void;
  wide?: boolean;
  closeDisabled?: boolean;
}) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const cannotClose = useRef(closeDisabled);
  cannotClose.current = closeDisabled;
  useEffect(() => {
    const previous = returnFocus ?? (document.activeElement as HTMLElement | null);
    const panel = ref.current!;
    const controls = () =>
      [
        ...panel.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], summary',
        ),
      ].filter((e) => {
        if (e.closest('[hidden]')) return false;
        const collapsed = e.closest('details:not([open])');
        return (
          !collapsed ||
          (e.matches('summary') &&
            e.parentElement === collapsed &&
            !collapsed.parentElement?.closest('details:not([open])'))
        );
      });
    if ([...document.querySelectorAll('[role="dialog"]')].at(-1) === panel) {
      const items = controls();
      (
        items.find((e) => e.hasAttribute('data-autofocus')) ||
        items.find((e) => e.matches('input,select,textarea')) ||
        items[0]
      )?.focus();
    }
    const key = (e: KeyboardEvent) => {
      if ([...document.querySelectorAll('[role="dialog"]')].at(-1) !== panel) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        if (!cannotClose.current) close.current();
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
    document.addEventListener('keydown', key);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', key);
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
            <h2 id={id}>{title}</h2>
          </div>
          <button
            className="icon-button"
            disabled={closeDisabled}
            onClick={onClose}
            aria-label="关闭弹窗"
          >
            <X size={20} />
          </button>
        </header>
        <div className="modal-content">{children}</div>
        {footer && <footer className="modal-footer">{footer}</footer>}
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
  onSelect,
}: {
  labels: string[];
  details?: Step[];
  current: number;
  failed?: boolean;
  cancelled?: boolean;
  finished?: boolean;
  onSelect?: (name: string) => void;
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
            {onSelect ? (
              <button className="step-jump" onClick={() => onSelect(name)} title="定位此步骤的日志">
                {name}
              </button>
            ) : (
              <span>{name}</span>
            )}
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
  id,
}: {
  id?: string;
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
        id={id}
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
