import { useEffect, useMemo, useState } from 'react';
import type { DesktopAPI, TaskSummary } from './platform';
import type { Database, History } from './model';
import { fmtTime, seconds } from './model';
import { operationLabel, targetLabels, taskResult } from './presentation';
import type { HistorySearchResult } from './features';
import { Badge, Card, Field, Modal } from './ui';
import { DateRangeFilter } from './DateRangeFilter';
import { withinDateRange, type DateRange } from './date-range';
import { HashValue } from './DeployDetails';
import { Search, SlidersHorizontal, X } from 'lucide-react';
type HistoryFilters = {
  kind: string;
  status: string;
  service: string;
  server: string;
  environment: string;
  date: DateRange;
};
const emptyFilters: HistoryFilters = {
  kind: 'all',
  status: 'all',
  service: 'all',
  server: 'all',
  environment: 'all',
  date: { from: '', to: '' },
};
export function TaskHistory({
  rows,
  db,
  api,
  busy,
  onOpen,
  onHistory,
  onCopy,
  onMaintenance,
}: {
  rows: TaskSummary[];
  db: Database;
  api: DesktopAPI;
  busy: boolean;
  onOpen: (id: string, targetId?: string) => void;
  onHistory: (history: History) => void;
  onCopy: (text: string) => void;
  onMaintenance?: (record: import('./features').MaintenanceRecord) => void;
}) {
  const [filters, setFilters] = useState<HistoryFilters>(emptyFilters);
  const [draft, setDraft] = useState<HistoryFilters>();
  const [query, setQuery] = useState('');
  const { kind, status, service, server, environment, date } = filters;
  const changeDraft = <K extends keyof HistoryFilters>(key: K, value: HistoryFilters[K]) =>
    setDraft((old) => (old ? { ...old, [key]: value } : old));
  const [expanded, setExpanded] = useState(new Set<string>()),
    [search, setSearch] = useState<HistorySearchResult>(),
    [searching, setSearching] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    setSearch(undefined);
    setError('');
    setSearching(!!query.trim());
    const timer = setTimeout(() => {
      if (!query.trim()) {
        void api.cancelSearch();
        return;
      }
      void api
        .searchHistory(query.trim())
        .then((value) => {
          if (alive) setSearch(value);
        })
        .catch((e) => {
          if (alive) setError(String(e));
        })
        .finally(() => {
          if (alive) setSearching(false);
        });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [api, query]);
  useEffect(
    () => () => {
      void api.cancelSearch();
    },
    [api],
  );
  const matching = useMemo(
    () =>
      rows.filter((row) => {
        const targets = row.targets || [],
          type = row.maintenance
            ? 'backup-cleanup'
            : row.uncertain
              ? 'unknown'
              : row.dryRun
                ? 'dry-run'
                : row.operation;
        return (
          (kind === 'all' || kind === type) &&
          (status === 'all' || row.status === status) &&
          (service === 'all' || row.serviceId === service) &&
          (server === 'all' || targets.some((t) => t.serverId === server)) &&
          (environment === 'all' || targets.some((t) => t.name === environment)) &&
          withinDateRange(fmtTime(row.started).slice(0, 10), date) &&
          (!query.trim() ||
            [row.note, row.service, ...targets.flatMap((t) => [t.name, t.server])].some((value) =>
              value?.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
            ) ||
            search?.hits.some((h) => h.taskId === row.id))
        );
      }),
    [rows, kind, status, service, server, environment, date, query, search],
  );
  const open = (row: TaskSummary, targetId?: string) => {
    if (row.maintenance) {
      onMaintenance?.(row.maintenance);
      return;
    }
    if (!row.imported) onOpen(row.id, targetId);
    else {
      const h = db.history.find(
        (h) => h.taskId === row.id && (!targetId || h.target.id === targetId),
      );
      if (h) onHistory(h);
    }
  };
  const chips: { key: keyof HistoryFilters; label: string }[] = [];
  if (kind !== 'all')
    chips.push({
      key: 'kind',
      label:
        '类型：' +
        ({
          deploy: '部署',
          rollback: '回滚',
          'dry-run': '试运行',
          'backup-cleanup': '备份清理',
          unknown: '记录待恢复',
        }[kind] || kind),
    });
  if (status !== 'all')
    chips.push({
      key: 'status',
      label:
        '结果：' +
        ({
          success: '已完成 / 检查通过',
          partial: '部分完成',
          failed: '失败 / 检查未通过',
          cancelled: '已取消',
          interrupted: '待核实',
        }[status] || status),
    });
  if (service !== 'all')
    chips.push({
      key: 'service',
      label: '服务：' + (rows.find((row) => row.serviceId === service)?.service || service),
    });
  if (server !== 'all')
    chips.push({
      key: 'server',
      label:
        '服务器：' +
        (rows.flatMap((row) => row.targets || []).find((target) => target.serverId === server)
          ?.server || server),
    });
  if (environment !== 'all') chips.push({ key: 'environment', label: '环境：' + environment });
  if (date.from || date.to)
    chips.push({
      key: 'date',
      label: '日期：' + (date.from || '不限') + ' 至 ' + (date.to || '不限'),
    });
  return (
    <>
      <div className="history-search-bar">
        <label className="search-box">
          <Search size={16} aria-hidden="true" />
          <input
            aria-label="搜索完整历史"
            placeholder="搜索备注、服务、环境、服务器和完整日志"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            maxLength={200}
          />
        </label>
        <button
          className="button"
          aria-label="筛选部署历史"
          onClick={() => setDraft({ ...filters, date: { ...filters.date } })}
        >
          <SlidersHorizontal size={16} />
          筛选{chips.length > 0 && ' · ' + chips.length}
        </button>
      </div>
      {!!chips.length && (
        <div className="history-filter-chips" aria-label="已应用的筛选">
          {chips.map((chip) => (
            <button
              className="filter-chip"
              key={chip.key}
              aria-label={'移除' + chip.label}
              onClick={() => setFilters((old) => ({ ...old, [chip.key]: emptyFilters[chip.key] }))}
            >
              {chip.label}
              <X size={13} aria-hidden="true" />
            </button>
          ))}
          <button className="link" onClick={() => setFilters(emptyFilters)}>
            全部清除
          </button>
        </div>
      )}
      {draft && (
        <Modal
          title="筛选部署历史"
          onClose={() => setDraft(undefined)}
          footer={
            <>
              <button className="button" onClick={() => setDraft(emptyFilters)}>
                重置
              </button>
              <button className="button" onClick={() => setDraft(undefined)}>
                取消
              </button>
              <button
                className="button primary"
                data-confirm
                onClick={() => {
                  setFilters(draft);
                  setDraft(undefined);
                }}
              >
                应用
              </button>
            </>
          }
        >
          <div className="form-grid history-filter-form">
            <Field label="任务类型">
              <select value={draft.kind} onChange={(e) => changeDraft('kind', e.target.value)}>
                <option value="all">全部类型</option>
                <option value="deploy">部署</option>
                <option value="rollback">回滚</option>
                <option value="dry-run">试运行</option>
                <option value="backup-cleanup">备份清理</option>
                <option value="unknown">记录待恢复</option>
              </select>
            </Field>
            <Field label="任务结果">
              <select value={draft.status} onChange={(e) => changeDraft('status', e.target.value)}>
                <option value="all">全部结果</option>
                <option value="success">已完成 / 检查通过</option>
                <option value="partial">部分完成</option>
                <option value="failed">失败 / 检查未通过</option>
                <option value="cancelled">已取消</option>
                <option value="interrupted">待核实</option>
              </select>
            </Field>
            <Field label="服务">
              <select
                value={draft.service}
                onChange={(e) => changeDraft('service', e.target.value)}
              >
                <option value="all">全部服务</option>
                {[...new Map(rows.map((r) => [r.serviceId || r.service, r.service])).entries()].map(
                  ([id, name]) => (
                    <option key={id} value={id}>
                      {name}
                    </option>
                  ),
                )}
              </select>
            </Field>
            <Field label="服务器">
              <select value={draft.server} onChange={(e) => changeDraft('server', e.target.value)}>
                <option value="all">全部服务器</option>
                {[
                  ...new Map(
                    rows.flatMap((r) =>
                      (r.targets || []).map((t) => [t.serverId, t.server] as const),
                    ),
                  ).entries(),
                ].map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="环境">
              <select
                value={draft.environment}
                onChange={(e) => changeDraft('environment', e.target.value)}
              >
                <option value="all">全部环境</option>
                {[...new Set(rows.flatMap((r) => (r.targets || []).map((t) => t.name)))].map(
                  (name) => (
                    <option key={name}>{name}</option>
                  ),
                )}
              </select>
            </Field>
            <Field label="部署日期" wide>
              <DateRangeFilter
                value={draft.date}
                onChange={(value) => changeDraft('date', value)}
              />
            </Field>
          </div>
        </Modal>
      )}
      {searching && (
        <p className="note" role="status">
          正在后台搜索完整日志，界面可继续操作…
        </p>
      )}
      {search && (
        <p className="note" role="status">
          共 {search.total} 处命中{search.total > 200 ? '，展示前 200 处' : ''}。
          {search.warnings.join('；')}
        </p>
      )}
      {error && (
        <p className="warning" role="alert">
          {error}
        </p>
      )}
      <Card title="执行任务记录" className="history-records">
        <div className="history-task-list">
          {matching.map((row) => (
            <article key={row.id} className="history-task">
              <div className="row spread wrap">
                <div className="grow">
                  <strong>
                    {row.service} ·{' '}
                    {(row.targets || []).map((t) => t.name).join('、') || '构建阶段'}
                  </strong>
                  <p className="muted">
                    {operationLabel(row)} · {fmtTime(row.started)} · {seconds(row.elapsed)}
                  </p>
                  {row.note && (
                    <p className="history-note" title={row.note}>
                      本次内容：{row.note}
                    </p>
                  )}
                  <small className="muted">
                    {row.id}
                    {row.imported ? ' · 导入的历史快照' : ''}
                  </small>
                </div>
                <Badge
                  kind={
                    row.status === 'success'
                      ? 'good'
                      : row.status === 'failed' || row.status === 'partial'
                        ? 'warn'
                        : ''
                  }
                >
                  {taskResult(row)}
                </Badge>
                <div className="row wrap">
                  <button
                    className="button"
                    disabled={busy || row.uncertain}
                    title={row.uncertain ? row.note : undefined}
                    onClick={() => open(row)}
                  >
                    查看任务
                  </button>
                  <button
                    className="button"
                    disabled={!row.targets?.length}
                    aria-expanded={expanded.has(row.id)}
                    onClick={() =>
                      setExpanded((old) => {
                        const next = new Set(old);
                        if (next.has(row.id)) next.delete(row.id);
                        else next.add(row.id);
                        return next;
                      })
                    }
                  >
                    {expanded.has(row.id) ? '收起目标' : '展开目标'}
                  </button>
                </div>
              </div>
              {row.buildFailed && (
                <p className="warning">构建失败，所选目标未开始部署；请在任务详情查看构建日志。</p>
              )}
              {(row.commit || row.jarHash) && (
                <div className="row wrap mt">
                  {row.commit && <HashValue label="Git 提交" value={row.commit} onCopy={onCopy} />}
                  <HashValue label="JAR 指纹" value={row.jarHash} onCopy={onCopy} />
                </div>
              )}
              {expanded.has(row.id) && (
                <div className="mt">
                  {row.targets?.map((t) => (
                    <div className="list-row" key={t.id}>
                      <div className="grow">
                        <strong>{t.name}</strong>
                        <p className="muted">
                          {t.server} · {seconds(t.elapsed)}
                        </p>
                      </div>
                      <Badge>
                        {row.maintenance
                          ? taskResult(row)
                          : row.buildFailed && ['pending', 'skipped'].includes(t.status)
                            ? '构建失败，未执行'
                            : row.dryRun && t.status === 'success'
                              ? '检查通过'
                              : targetLabels[t.status]}
                      </Badge>
                      <button className="button" disabled={busy} onClick={() => open(row, t.id)}>
                        查看目标详情
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {!!search?.hits.some((h) => h.taskId === row.id) && (
                <div className="history-hits mt">
                  {search.hits
                    .filter((h) => h.taskId === row.id)
                    .map((h, i) => (
                      <button
                        key={i}
                        className="history-hit"
                        disabled={busy}
                        onClick={() => open(row, h.targetId)}
                      >
                        <strong>
                          {h.section}
                          {h.line ? ' · 第 ' + h.line + ' 行' : ''}
                        </strong>
                        <span>{h.text}</span>
                      </button>
                    ))}
                </div>
              )}
            </article>
          ))}
        </div>
        {!matching.length && (
          <p className="empty">
            {query ? '暂无匹配记录，可等待后台日志搜索完成。' : '尚无匹配任务。'}
          </p>
        )}
      </Card>
    </>
  );
}
