import { Button } from './design/ui/button';
import { useEffect, useLayoutEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Search, ArrowLeft, Box, Settings, Rocket, HardDrive, CircleHelp, RefreshCw } from 'lucide-react';
import { createPortal } from 'react-dom';
import { Input } from './design/ui/input';

/** 卡片入口和单项详情共用状态，返回时恢复列表位置与键盘焦点。 */
export function EntityWorkspace<T extends { id: string }>({
  label,
  items,
  title,
  subtitle,
  searchText,
  summary,
  cardActions,
  cardState,
  cardMeta,
  actions,
  filters,
  children,
}: {
  label: string;
  items: T[];
  title: (item: T) => string;
  subtitle: (item: T) => string;
  searchText?: (item: T) => string;
  summary?: (item: T) => ReactNode;
  cardActions?: (item: T) => ReactNode;
  cardState?: (item: T) => { good: boolean; label: string };
  cardMeta?: (item: T) => ReactNode;
  actions?: ReactNode;
  filters?: ReactNode;
  children: (item: T) => ReactNode;
}) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string>();
  const previous = useRef(new Set(items.map((item) => item.id)));
  const root = useRef<HTMLDivElement>(null);
  const origin = useRef<string | undefined>(undefined);
  const position = useRef(0);
  const returning = useRef(false);
  const searchId = useId();
  const current = items.find((item) => item.id === selected);
  useEffect(() => {
    const added = items.find((item) => !previous.current.has(item.id));
    previous.current = new Set(items.map((item) => item.id));
    if (added) {
      setSelected(added.id);
      setQuery('');
    } else if (selected && !items.some((item) => item.id === selected)) {
      returning.current = true;
      setSelected(undefined);
    }
  }, [items, selected]);
  useLayoutEffect(() => {
    const main = root.current?.closest('main');
    if (current) {
      if (main) main.scrollTop = 0;
      root.current?.querySelector<HTMLElement>('.entity-detail')?.focus({ preventScroll: true });
    } else if (returning.current) {
      returning.current = false;
      const cards = [
        ...(root.current?.querySelectorAll<HTMLButtonElement>('[data-entity-id]') || []),
      ];
      const button = cards.find((card) => card.dataset.entityId === origin.current) || cards[0];
      (button || root.current?.querySelector<HTMLInputElement>('.search-box input'))?.focus({
        preventScroll: true,
      });
      if (main) main.scrollTop = position.current;
    }
  }, [current?.id, selected]);
  const visible = items.filter((item) =>
    (title(item) + ' ' + subtitle(item) + ' ' + (searchText?.(item) || ''))
      .toLocaleLowerCase()
      .includes(query.toLocaleLowerCase().trim()),
  );
  const enter = (id: string) => {
    position.current = root.current?.closest('main')?.scrollTop || 0;
    origin.current = id;
    setSelected(id);
  };
  return (
    <div className="entity-workspace" ref={root}>
      {current ? (
        <>
          <Button
            variant="neutral" size="compact" className="entity-back"
            onClick={() => {
              returning.current = true;
              setSelected(undefined);
            }}
          >
            <ArrowLeft size={16} />
            返回列表
          </Button>
          <div className="entity-detail" aria-label={label + '详情'} tabIndex={-1}>
            {children(current)}
          </div>
        </>
      ) : (
        <>
          <div className="entity-toolbar">
            <label htmlFor={searchId} className="search-box">
              <Search size={16} aria-hidden="true" />
              <Input
                id={searchId}
                aria-label={'搜索' + label}
                placeholder={'搜索' + label}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            {filters}
            {actions}
          </div>
          <div className="entity-list" aria-label={label + '列表'}>
            {visible.map((item) => (
              <article key={item.id} className="entity-record">
                <div className="entity-record-main">
                  <span className="record-icon">
                    <Box size={18} strokeWidth={1.5} />
                  </span>
                  <div className="entity-record-identity">
                    <button
                      className="entity-name"
                      data-entity-id={item.id}
                      aria-label={'查看' + label + title(item) + '详情'}
                      onClick={() => enter(item.id)}
                    >
                      {title(item)}
                    </button>
                    {subtitle(item) && (
                      <p className="entity-card-subtitle" title={subtitle(item)}>
                        {subtitle(item)}
                      </p>
                    )}
                    <div className="entity-card-summary">{summary?.(item)}</div>
                  </div>
                </div>
                {cardState && (
                  <span className={'entity-state' + (cardState(item).good ? ' good' : '')}>
                    <span aria-hidden="true" />
                    {cardState(item).label}
                  </span>
                )}
                {cardMeta && <div className="entity-card-meta">{cardMeta(item)}</div>}
                {cardActions?.(item)}
              </article>
            ))}
          </div>
          {!visible.length && (
            <p className="empty">
              {items.length ? '没有匹配项，请调整搜索内容。' : '暂无配置，点击上方添加。'}
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** 面板保留挂载，切换分类不会清空表单、日志选区或迁移进度。 */
export function WorkspaceTabs({
  label,
  sections,
  value,
  onChange,
  navigationTarget,
}: {
  label: string;
  sections: { id: string; label: string; description?: string; content: ReactNode }[];
  value?: string;
  onChange?: (id: string) => void;
  navigationTarget?: string;
}) {
  const [directory, setDirectory] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    setDirectory(navigationTarget ? document.getElementById(navigationTarget) : null);
  }, [navigationTarget]);
  const [local, setLocal] = useState(sections[0]?.id);
  const active = value ?? local;
  const id = useId();
  const choose = (next: string) => {
    setLocal(next);
    onChange?.(next);
  };
  const icons = { general: Settings, deploy: Rocket, data: HardDrive, update: RefreshCw, help: CircleHelp };
  const navigation = (
    <div
      className={directory ? 'sidebar-settings-tabs' : 'workspace-tab-list'}
      role="tablist"
      aria-label={label}
      aria-orientation={directory ? 'vertical' : 'horizontal'}
    >
      {sections.map((section, index) => {
        const Icon = icons[section.id as keyof typeof icons] || Settings;
        return (
          <button
            key={section.id}
            role="tab"
            className={directory ? 'sidebar-link' : undefined}
            aria-label={section.label}
            title={directory ? section.label : undefined}
            id={id + '-tab-' + section.id}
            aria-controls={id + '-panel-' + section.id}
            aria-selected={active === section.id}
            tabIndex={active === section.id ? 0 : -1}
            onClick={() => choose(section.id)}
            onKeyDown={(e) => {
              const next =
                e.key === (directory ? 'ArrowDown' : 'ArrowRight')
                  ? (index + 1) % sections.length
                  : e.key === (directory ? 'ArrowUp' : 'ArrowLeft')
                    ? (index + sections.length - 1) % sections.length
                    : e.key === 'Home'
                      ? 0
                      : e.key === 'End'
                        ? sections.length - 1
                        : -1;
              if (next < 0) return;
              e.preventDefault();
              choose(sections[next].id);
              document.getElementById(id + '-tab-' + sections[next].id)?.focus();
            }}
          >
            {directory && <Icon size={16} strokeWidth={1.6} />}
            <span>{section.label}</span>
          </button>
        );
      })}
    </div>
  );
  return (
    <div className="workspace-tabs">
      {directory ? createPortal(navigation, directory) : navigation}
      {sections.map((section) => (
        <section
          key={section.id}
          role="tabpanel"
          tabIndex={0}
          id={id + '-panel-' + section.id}
          aria-labelledby={id + '-tab-' + section.id}
          hidden={active !== section.id}
        >
          {section.description && <p className="workspace-description">{section.description}</p>}
          {section.content}
        </section>
      ))}
    </div>
  );
}

export function Disclosure({
  title,
  description,
  children,
  open = false,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  open?: boolean;
}) {
  return (
    <details className="workspace-disclosure" open={open || undefined}>
      <summary>
        <strong>{title}</strong>
        {description && <span>{description}</span>}
      </summary>
      <div className="disclosure-body">{children}</div>
    </details>
  );
}

/** 详情直接使用内容区，不重复嵌套带边框的大卡片。 */
export function EntityDetail({
  title,
  action,
  children,
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="entity-flat-detail">
      <header className="card-head">
        <h2>{title}</h2>
        {action}
      </header>
      {children}
    </section>
  );
}
