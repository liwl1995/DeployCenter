import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Field, Modal } from './ui';
export type MenuAction = {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  reason?: string;
  destructive?: boolean;
};
export function MoreMenu({ label, actions }: { label: string; actions: MenuAction[] }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number }>();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const close = (restore = false) => {
    setOpen(false);
    if (restore) trigger.current?.focus();
  };
  useLayoutEffect(() => {
    if (!open || !menu.current || !trigger.current) return;
    const anchor = trigger.current.getBoundingClientRect(),
      box = menu.current.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(anchor.right - box.width, window.innerWidth - box.width - 8)),
      top:
        anchor.bottom + box.height + 8 <= window.innerHeight
          ? anchor.bottom + 5
          : Math.max(8, anchor.top - box.height - 5),
    });
    const first = menu.current.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])');
    (first || menu.current).focus();
    const outside = (e: PointerEvent) => {
      if (!menu.current?.contains(e.target as Node) && !trigger.current?.contains(e.target as Node))
        close();
    };
    const dismiss = () => close();
    const scroll = (e: Event) => {
      if (!(e.target instanceof Node) || !menu.current?.contains(e.target)) close();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', dismiss);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', dismiss);
    };
  }, [open]);
  return (
    <div className="more-menu">
      <button
        ref={trigger}
        className="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        更多
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            role="menu"
            tabIndex={-1}
            aria-label={label}
            className="entity-action-menu"
            style={{ left: position?.left ?? 8, top: position?.top ?? 8 }}
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) close();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                close(true);
              }
              if (e.key === 'Tab') {
                e.preventDefault();
                close(true);
              }
              if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
                e.preventDefault();
                const items = [
                  ...menu.current!.querySelectorAll<HTMLButtonElement>(
                    '[role="menuitem"]:not([disabled])',
                  ),
                ];
                const index = items.indexOf(document.activeElement as HTMLButtonElement);
                const next =
                  e.key === 'Home'
                    ? 0
                    : e.key === 'End'
                      ? items.length - 1
                      : (index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
                items[next]?.focus();
              }
            }}
          >
            {actions.map((action) => (
              <span title={action.reason} key={action.label}>
                <button
                  role="menuitem"
                  className={action.destructive ? 'destructive-menu-item' : ''}
                  disabled={action.disabled}
                  aria-description={action.reason}
                  onClick={() => {
                    close(true);
                    action.onClick();
                  }}
                >
                  {action.label}
                </button>
              </span>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}

export function DeleteEntity({
  name,
  kind,
  hasHistory,
  reason,
  description,
  onClose,
  onDelete,
}: {
  name: string;
  kind: string;
  hasHistory: boolean;
  reason: string;
  description: string;
  onClose: () => void;
  onDelete: () => Promise<void>;
}) {
  const [value, setValue] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <Modal
      title={'删除' + kind + '配置？'}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <p>
        将删除 {name}。{description}
      </p>
      <p className="note">不会停止或删除服务器上的应用，也不会删除远程备份。</p>
      {hasHistory && (
        <>
          <p className="warning">
            存在历史记录，历史快照和日志会按原保留策略保留。删除目标配置后，直接回滚需要先恢复原目标配置。
          </p>
          <Field label="输入名称确认删除">
            <input
              data-autofocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={name}
              autoComplete="off"
            />
          </Field>
        </>
      )}
      {reason && <p className="warning">{reason}</p>}
      {error && (
        <p className="warning" role="alert">
          {error}
        </p>
      )}
      <footer className="modal-actions">
        <button
          className="button"
          data-autofocus={!hasHistory || undefined}
          disabled={busy}
          onClick={onClose}
        >
          取消
        </button>
        <button
          className="button"
          disabled={busy || !!reason || (hasHistory && value !== name)}
          onClick={() => {
            setBusy(true);
            setError('');
            void onDelete()
              .catch((e) => setError(String(e)))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? '删除中…' : '删除配置'}
        </button>
      </footer>
    </Modal>
  );
}
