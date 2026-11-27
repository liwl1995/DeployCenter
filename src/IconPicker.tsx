import { useMemo, useRef, useState } from 'react';
import { Check, RotateCcw } from 'lucide-react';
import { Modal } from './ui';
import { Button } from './design/ui/button';
import { Input } from './design/ui/input';
import { DEFAULT_ENTITY_ICON, ENTITY_ICON_LIST, ICON_COLORS, type EntityIconKind } from './entity-icons';
import type { EntityIcon } from './model';

/** 图标选择器：搜索 + 预设颜色 + 图标平铺网格，选中即应用。 */
export function IconPicker({
  kind,
  current,
  onPick,
  onClose,
}: {
  kind: EntityIconKind;
  current?: EntityIcon;
  onPick: (icon: EntityIcon | undefined) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState<string | undefined>(current?.name);
  const [color, setColor] = useState<string>(current?.color ?? '');
  const [query, setQuery] = useState('');
  const [focusedName, setFocusedName] = useState(current?.name);
  const searchRef = useRef<HTMLInputElement>(null);

  const apply = (nextName: string | undefined, nextColor: string) => {
    const iconName = nextName ?? (nextColor ? DEFAULT_ENTITY_ICON[kind] : undefined);
    setName(iconName);
    setColor(nextColor);
    if (!iconName) {
      onPick(undefined);
      return;
    }
    onPick(nextColor ? { name: iconName, color: nextColor } : { name: iconName });
  };

  const reset = () => {
    apply(undefined, '');
    // 「恢复默认」按钮会随 hasCustom 变 false 而从界面移除，把焦点移回搜索框，避免焦点丢失。
    searchRef.current?.focus();
  };

  const icons = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return ENTITY_ICON_LIST;
    return ENTITY_ICON_LIST.filter((icon) => (icon.name + ' ' + icon.label).toLowerCase().includes(q));
  }, [query]);

  const hasCustom = !!name;
  const gridFocus = icons.some((icon) => icon.name === focusedName)
    ? focusedName
    : icons.some((icon) => icon.name === name) ? name : icons[0]?.name;
  const kindLabel = kind === 'service' ? '服务' : kind === 'server' ? '服务器' : '部署目标';

  return (
    <Modal title={'更换' + kindLabel + '图标'} onClose={onClose} wide>
      <div className="icon-picker">
        <div className="icon-picker-toolbar">
          <Input
            ref={searchRef}
            className="icon-picker-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索图标"
            aria-label="搜索图标"
            data-autofocus
          />
          {hasCustom && (
            <Button variant="ghost" size="compact" onClick={reset}>
              <RotateCcw size={14} />
              恢复默认
            </Button>
          )}
        </div>

        <div className="icon-picker-colors" role="radiogroup" aria-label="图标颜色">
          {ICON_COLORS.map((c) => {
            const selected = color === c.value;
            return (
              <label
                key={c.label}
                className={'icon-color' + (selected ? ' selected' : '') + (c.value ? '' : ' icon-color-none')}
                style={c.value ? { background: c.value } : undefined}
                title={c.label}
              >
                <input
                  type="radio"
                  name="icon-picker-color"
                  value={c.value}
                  checked={selected}
                  aria-label={c.label}
                  onChange={() => apply(name, c.value)}
                />
              </label>
            );
          })}
        </div>

        <div className="icon-picker-grid-wrap">
          <div className="icon-picker-grid" role="group" aria-label="图标列表"
            onKeyDown={(event) => {
              const key = event.key;
              if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(key)) return;
              const grid = event.currentTarget;
              const cells = Array.from(grid.querySelectorAll('button'));
              const index = cells.indexOf(event.target as HTMLButtonElement);
              if (index < 0) return;
              const columns = getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).length;
              const offsets = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns };
              const next = key === 'Home' ? 0 : key === 'End' ? cells.length - 1
                : index + offsets[key as keyof typeof offsets];
              event.preventDefault();
              cells[Math.max(0, Math.min(cells.length - 1, next))]?.focus();
            }}>
            {icons.map((icon) => {
              const active = name === icon.name;
              return (
                <button
                  key={icon.name}
                  type="button"
                  className={'icon-cell' + (active ? ' selected' : '')}
                  aria-pressed={active}
                  title={icon.label}
                  aria-label={icon.label}
                  tabIndex={icon.name === gridFocus ? 0 : -1}
                  onFocus={() => setFocusedName(icon.name)}
                  onClick={() => active ? apply(undefined, '') : apply(icon.name, color)}
                >
                  <icon.Icon size={20} strokeWidth={1.75} color={color || undefined} />
                  <span>{icon.label}</span>
                  {active && <Check className="icon-cell-check" size={13} strokeWidth={2.5} aria-hidden="true" />}
                </button>
              );
            })}
          </div>
          {!icons.length && <p className="muted">没有匹配的图标，换个关键词试试。</p>}
        </div>
      </div>
    </Modal>
  );
}
