import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Search, ChevronRight } from 'lucide-react';

/** 保留详情的操作入口，将长配置清单变成可搜索的主从工作区。 */
export function EntityWorkspace<T extends { id: string }>({
  label,
  items,
  title,
  subtitle,
  children,
}: {
  label: string;
  items: T[];
  title: (item: T) => string;
  subtitle: (item: T) => string;
  children: (item: T) => ReactNode;
}) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(items[0]?.id);
  const previous = useRef(new Set(items.map((item) => item.id)));
  const searchId = useId();
  useEffect(() => {
    const added = items.find((item) => !previous.current.has(item.id));
    previous.current = new Set(items.map((item) => item.id));
    if (added) {
      setSelected(added.id);
      setQuery('');
    }
  }, [items]);
  const visible = items.filter((item) =>
    (title(item) + ' ' + subtitle(item))
      .toLocaleLowerCase()
      .includes(query.toLocaleLowerCase().trim()),
  );
  const current = visible.find((item) => item.id === selected) || visible[0];
  return (
    <div className="entity-workspace">
      <aside className="entity-list" aria-label={label + '列表'}>
        <div className="entity-list-head">
          <strong>
            {label} <span className="muted">{items.length}</span>
          </strong>
          <label htmlFor={searchId} className="search-box">
            <Search size={16} aria-hidden="true" />
            <input
              id={searchId}
              aria-label={'搜索' + label}
              placeholder={'搜索' + label}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
        </div>
        <div className="entity-options">
          {visible.map((item, index) => (
            <button
              key={item.id}
              className="entity-option"
              aria-pressed={current?.id === item.id}
              onClick={() => setSelected(item.id)}
              onKeyDown={(e) => {
                const next =
                  e.key === 'ArrowDown'
                    ? index + 1
                    : e.key === 'ArrowUp'
                      ? index - 1
                      : e.key === 'Home'
                        ? 0
                        : e.key === 'End'
                          ? visible.length - 1
                          : -1;
                if (next < 0 || next >= visible.length) return;
                e.preventDefault();
                setSelected(visible[next].id);
                const buttons =
                  e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                    '.entity-option',
                  );
                buttons?.[next].focus();
              }}
            >
              <span>
                <strong>{title(item)}</strong>
                <small>{subtitle(item)}</small>
              </span>
              <ChevronRight size={16} aria-hidden="true" />
            </button>
          ))}
          {!visible.length && (
            <p className="empty">
              {items.length ? '没有匹配项，请调整搜索内容。' : '暂无配置，点击右上角添加。'}
            </p>
          )}
        </div>
      </aside>
      <div className="entity-detail" aria-label={label + '详情'}>
        {current ? (
          children(current)
        ) : (
          <div className="workspace-placeholder">
            {items.length ? '搜索不到匹配的配置。' : '添加配置后，在这里查看详情和执行操作。'}
          </div>
        )}
      </div>
    </div>
  );
}

/** 面板保留挂载，切换分类不会清空表单、日志选区或迁移进度。 */
export function WorkspaceTabs({
  label,
  sections,
  value,
  onChange,
}: {
  label: string;
  sections: { id: string; label: string; description?: string; content: ReactNode }[];
  value?: string;
  onChange?: (id: string) => void;
}) {
  const [local, setLocal] = useState(sections[0]?.id);
  const active = value ?? local;
  const id = useId();
  const choose = (next: string) => {
    setLocal(next);
    onChange?.(next);
  };
  return (
    <div className="workspace-tabs">
      <div className="workspace-tab-list" role="tablist" aria-label={label}>
        {sections.map((section, index) => (
          <button
            key={section.id}
            role="tab"
            id={id + '-tab-' + section.id}
            aria-controls={id + '-panel-' + section.id}
            aria-selected={active === section.id}
            tabIndex={active === section.id ? 0 : -1}
            onClick={() => choose(section.id)}
            onKeyDown={(e) => {
              const next =
                e.key === 'ArrowRight'
                  ? (index + 1) % sections.length
                  : e.key === 'ArrowLeft'
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
            {section.label}
          </button>
        ))}
      </div>
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
