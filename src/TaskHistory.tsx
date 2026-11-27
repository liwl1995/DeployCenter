import { Button } from './design/ui/button';
import { Input } from './design/ui/input';
import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { PageTabs } from './design/ui/page-tabs';
import type { DesktopAPI, TaskSummary } from './platform';
import type { Database, History } from './model';
import { fmtTime, seconds } from './model';
import { operationLabel, targetLabels, taskResult, shortHash, validHash } from './presentation';
import type { HistorySearchResult, HistorySearchScope, SearchHit } from './features';
import { Badge, Card, Field, Modal } from './ui';
import { MoreMenu } from './EntityActions';
import { CompactStatus, historyDay, historyState, shortReason } from './compact-list';
import { DateRangeFilter } from './DateRangeFilter';
import { DeployStatsView } from './DeployStatsView';
import { matchesHistoryScope, matchesHistoryTarget, type HistoryScope } from './deploy-stats';
import { HashValue } from './DeployDetails';
import { Search, SlidersHorizontal, X, ChevronDown } from 'lucide-react';
type HistoryFilters = HistoryScope & {
  kind: string;
  status: string;
  releaseId?: string;
};
const emptyScope: HistoryScope = {
  service: 'all',
  server: 'all',
  environment: 'all',
  date: { from: '', to: '' },
};
const emptyFilters: HistoryFilters = { ...emptyScope, kind: 'all', status: 'all' };
type HistoryTab = 'records' | 'stats';
const historyTabs = [
  { value: 'records', label: '部署记录' },
  { value: 'stats', label: '统计' },
] satisfies { value: HistoryTab; label: string }[];

type SavedSearch = { query: string; scopeKey: string; result: HistorySearchResult };

export type HistoryViewState = {
  filters: HistoryFilters;
  query: string;
  expanded: Set<string>;
  search?: SavedSearch;
  openedTask?: string;
  tab?: HistoryTab;
};

export const releaseHistoryView = (releaseId: string): HistoryViewState => ({
  filters: { ...emptyFilters, releaseId },
  query: '',
  expanded: new Set(),
  tab: 'records',
});

export function TaskHistory({
  rows,
  db,
  api,
  busy,
  onOpen,
  onHistory,
  onCopy,
  onMaintenance,
  initialView,
  onViewChange,
  showStatistics = false,
}: {
  rows: TaskSummary[];
  db: Database;
  api: DesktopAPI;
  busy: boolean;
  onOpen: (id: string, targetId?: string) => void;
  onHistory: (history: History) => void;
  onCopy: (text: string) => void;
  onMaintenance?: (record: import('./features').MaintenanceRecord) => void;
  initialView?: HistoryViewState;
  onViewChange?: (view: HistoryViewState) => void;
  showStatistics?: boolean;
}) {
  const initial = useRef(initialView);
  const [filters, setFilters] = useState<HistoryFilters>(
    () => initial.current?.filters ?? emptyFilters,
  );
  const [draft, setDraft] = useState<HistoryFilters>();
  const [tab, setTab] = useState<HistoryTab>(initial.current?.tab ?? 'records');
  const activeTab = showStatistics ? tab : 'records';
  const statisticsActive = activeTab === 'stats';
  const tabId = useId();
  const [query, setQuery] = useState(() => initial.current?.query ?? '');
  const [showVersion, setShowVersion] = useState(
    () => window.matchMedia?.('(min-width: 1151px)').matches ?? true,
  );
  useEffect(() => {
    const media = window.matchMedia?.('(min-width: 1151px)');
    if (!media) return;
    const update = () => setShowVersion(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  const { kind, status, service, server, environment, date, releaseId } = filters;
  const changeDraft = <K extends keyof HistoryFilters>(key: K, value: HistoryFilters[K]) =>
    setDraft((old) => (old ? { ...old, [key]: value } : old));
  const [expanded, setExpanded] = useState(() => initial.current?.expanded ?? new Set<string>());
  const [completedSearch, setCompletedSearch] = useState(initial.current?.search);
  const [failedSearch, setFailedSearch] = useState<{ query: string; scopeKey: string; error: string }>();
  const [openedTask, setOpenedTask] = useState(initial.current?.openedTask);
  const returnRow = useRef<HTMLTableRowElement>(null);
  const eligibleRows = useMemo(
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
          (!releaseId || row.releaseId === releaseId) &&
          (kind === 'all' || kind === type) &&
          (status === 'all' || row.status === status) &&
          matchesHistoryScope(row.serviceId || row.service, row.started, filters) &&
          ((server === 'all' && environment === 'all') ||
            targets.some((target) => matchesHistoryTarget(target.serverId, target.name, filters)))
        );
      }),
    [rows, filters, kind, status, server, environment, releaseId],
  );
  const keyword = query.trim();
  const scopeKey = useMemo(() => {
    const scope: HistorySearchScope = {
      taskIds: eligibleRows.map((row) => row.id).sort(),
      serverId: server === 'all' ? undefined : server,
      environment: environment === 'all' ? undefined : environment,
    };
    return JSON.stringify(scope);
  }, [eligibleRows, server, environment]);
  // 只复用当前关键词和范围的结果，切换筛选时不会显示上一轮命中。
  const savedSearch = completedSearch?.query === keyword && completedSearch.scopeKey === scopeKey
    ? completedSearch
    : undefined;
  const search = savedSearch?.result;
  const error = failedSearch?.query === keyword && failedSearch.scopeKey === scopeKey
    ? failedSearch.error
    : undefined;
  const searching = !!keyword && !statisticsActive && !search && !error;
  const matchedIds = useMemo(() => new Set(search?.taskIds), [search]);
  const hitsByTask = useMemo(() => {
    const groups = new Map<string, SearchHit[]>();
    for (const hit of search?.hits || []) {
      const hits = groups.get(hit.taskId);
      if (hits) hits.push(hit);
      else groups.set(hit.taskId, [hit]);
    }
    return groups;
  }, [search]);
  const matching = useMemo(
    () => keyword ? eligibleRows.filter((row) => matchedIds.has(row.id)) : eligibleRows,
    [eligibleRows, keyword, matchedIds],
  );
  const viewState = (taskId = openedTask): HistoryViewState => ({
    filters,
    query,
    expanded,
    search: savedSearch,
    openedTask: taskId,
    tab,
  });
  useLayoutEffect(() => {
    onViewChange?.(viewState());
  });
  useLayoutEffect(() => {
    returnRow.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    if (!keyword || statisticsActive) return;
    let alive = true;
    let running = false;
    setFailedSearch(undefined);
    const timer = setTimeout(() => {
      running = true;
      void api
        .searchHistory(keyword, JSON.parse(scopeKey) as HistorySearchScope)
        .then((value) => {
          if (alive) setCompletedSearch({ query: keyword, scopeKey, result: value });
        })
        .catch((e) => {
          if (alive) setFailedSearch({ query: keyword, scopeKey, error: shortReason(String(e)) });
        })
        .finally(() => {
          running = false;
        });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
      if (running) void api.cancelSearch().catch(() => {});
    };
  }, [api, keyword, scopeKey, statisticsActive]);
  const open = (row: TaskSummary, targetId?: string) => {
    if (row.maintenance) {
      onMaintenance?.(row.maintenance);
      return;
    }
    const rememberRow = () => {
      setOpenedTask(row.id);
      // 快照详情直接切页，列表可能在本次 React 更新提交前就卸载。
      onViewChange?.(viewState(row.id));
    };
    if (!row.imported) {
      rememberRow();
      onOpen(row.id, targetId);
    } else {
      const h = db.history.find(
        (h) => h.taskId === row.id && (!targetId || h.target.id === targetId),
      );
      if (h) {
        rememberRow();
        onHistory(h);
      }
    }
  };
  const toggle = (id: string) =>
    setExpanded((old) => {
      const next = new Set(old);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const ordered = [...matching].sort(
    (a, b) => (Date.parse(b.started) || 0) - (Date.parse(a.started) || 0),
  );
  const chips: { key: keyof HistoryFilters; label: string }[] = [];
  if (releaseId) chips.push({ key: 'releaseId', label: '清单：' + releaseId.slice(0, 11) });
  if (!statisticsActive && kind !== 'all')
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
  if (!statisticsActive && status !== 'all')
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
      label: '服务：' + (rows.find((row) => (row.serviceId || row.service) === service)?.service ||
        db.history.find((record) => record.service.id === service)?.service.name || service),
    });
  if (server !== 'all')
    chips.push({
      key: 'server',
      label:
        '服务器：' +
        (rows.flatMap((row) => row.targets || []).find((target) => target.serverId === server)
          ?.server || db.history.find((record) => record.server.id === server)?.server.name || server),
    });
  if (environment !== 'all') chips.push({ key: 'environment', label: '环境：' + environment });
  if (date.from || date.to)
    chips.push({
      key: 'date',
      label: '日期：' + (date.from || '不限') + ' 至 ' + (date.to || '不限'),
    });
  const openFilters = () => setDraft({ ...filters, date: { ...date } });
  const clearFilters = (current: HistoryFilters) =>
    statisticsActive ? { ...current, ...emptyScope, releaseId: undefined } : emptyFilters;
  const historicalTargets = showStatistics ? db.history : [];
  const services = draft && new Map([
    ...historicalTargets.map((record) => [record.service.id, record.service.name] as const),
    ...rows.map((row) => [row.serviceId || row.service, row.service] as const),
  ]);
  const servers = draft && new Map([
    ...historicalTargets.map((record) => [record.server.id, record.server.name] as const),
    ...rows.flatMap((row) => (row.targets || []).map((target) => [target.serverId, target.server] as const)),
  ]);
  const environments = draft && new Set([
    ...historicalTargets.map((record) => record.target.name),
    ...rows.flatMap((row) => (row.targets || []).map((target) => target.name)),
  ]);
  const controls = (
    <>
      <div className={`history-search-bar${statisticsActive ? ' history-stats-toolbar' : ''}`}>
        {!statisticsActive && <label className="search-box">
          <Search size={16} aria-hidden="true" />
          <Input
            aria-label="搜索完整历史"
            placeholder="搜索部署记录和日志"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            maxLength={200}
          />
        </label>}
        <Button
          variant="neutral"
          size="compact"
          aria-label="筛选部署历史"
          onClick={openFilters}
        >
          <SlidersHorizontal size={16} />
          筛选{chips.length > 0 && ' · ' + chips.length}
        </Button>
      </div>
      {!!chips.length && (
        <div className="history-filter-chips" aria-label="已应用的筛选">
          {chips.map((chip) => (
            <button
              className="filter-chip"
              key={chip.key}
              title={chip.key === 'releaseId' ? releaseId : undefined}
              aria-label={'移除' + chip.label}
              onClick={() => setFilters((old) => ({ ...old, [chip.key]: emptyFilters[chip.key] }))}
            >
              {chip.label}
              <X size={13} aria-hidden="true" />
            </button>
          ))}
          <Button variant="link" size="compact" onClick={() => setFilters(clearFilters)}>
            全部清除
          </Button>
        </div>
      )}
      {draft && (
        <Modal
          title="筛选部署历史"
          onClose={() => setDraft(undefined)}
          footer={
            <>
              <Button variant="neutral" size="compact" onClick={() => setDraft((current) => current && clearFilters(current))}>
                重置
              </Button>
              <Button variant="neutral" size="compact" onClick={() => setDraft(undefined)}>
                取消
              </Button>
              <Button
                variant="default"
                size="compact"
                data-confirm
                onClick={() => {
                  setFilters(draft);
                  setDraft(undefined);
                }}
              >
                应用
              </Button>
            </>
          }
        >
          <div className="form-grid history-filter-form">
            {!statisticsActive && <>
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
            </>}
            <Field label="服务">
              <select
                value={draft.service}
                onChange={(e) => changeDraft('service', e.target.value)}
              >
                <option value="all">全部服务</option>
                {[...(services || [])].map(
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
                {[...(servers || [])].map(([id, name]) => (
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
                {[...(environments || [])].map(
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
    </>
  );
  const records = statisticsActive ? null : (
    <>
      {searching && (
        <p className="note" role="status">
          正在搜索当前范围的完整日志…
        </p>
      )}
      {search && (
        <p className="note" role="status">
          命中 {search.taskIds.length} 个任务，{search.total} 处匹配
          {search.total > search.hits.length ? '，展示前 ' + search.hits.length + ' 处' : ''}。
        </p>
      )}
      {!!search?.warnings.length && (
        <p className="warning" role="status">{search.warnings.join(' ')}</p>
      )}
      {error && (
        <p className="warning" role="alert">
          {error}
        </p>
      )}
      <Card className="history-records compact-records">
        <h2 className="compact-visually-hidden">执行任务记录</h2>
        <table className="compact-table history-table" aria-label="部署历史列表">
          <colgroup>
            <col className="history-state-col" />
            <col />
            <col className="history-service-col" />
            <col className="history-time-col" />
            <col className="history-elapsed-col" />
            {showVersion && <col className="history-version-col" />}
            <col className="history-menu-col" />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">状态</th>
              <th scope="col">本次内容</th>
              <th scope="col">服务 · 环境</th>
              <th scope="col">开始</th>
              <th scope="col">耗时</th>
              {showVersion && (
                <th scope="col" className="history-version-cell">
                  Git · JAR
                </th>
              )}
              <th scope="col">
                <span className="compact-visually-hidden">操作</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {ordered.map((row, index) => {
              const day = historyDay(row.started),
                state = historyState(row),
                isExpanded = expanded.has(row.id),
                hits = hitsByTask.get(row.id);
              const environments = (row.targets || []).map((t) => t.name).join('、') || '构建阶段';
              const note = row.note || operationLabel(row) + row.service;
              const blocked = busy || !!row.uncertain;
              return (
                <Fragment key={row.id}>
                  {(index === 0 || historyDay(ordered[index - 1].started).key !== day.key) && (
                    <tr className="history-day">
                      <th scope="rowgroup" colSpan={showVersion ? 7 : 6}>
                        {day.label}
                      </th>
                    </tr>
                  )}
                  <tr
                    className="history-task compact-data-row"
                    ref={row.id === initial.current?.openedTask ? returnRow : undefined}
                    tabIndex={blocked ? -1 : 0}
                    aria-label={'查看任务：' + note}
                    aria-disabled={blocked}
                    onClick={(event) => {
                      if (
                        !blocked &&
                        !(event.target as HTMLElement).closest('button,a,[role="menu"]')
                      )
                        open(row);
                    }}
                    onKeyDown={(event) => {
                      if (
                        event.target === event.currentTarget &&
                        ['Enter', ' '].includes(event.key)
                      ) {
                        event.preventDefault();
                        if (!blocked) open(row);
                      }
                    }}
                  >
                    <td>
                      <CompactStatus {...state} />
                    </td>
                    <td>
                      <div className="history-content">
                        <span className="history-operation" title={row.releaseId}>
                          {row.releaseId ? '批量部署' : operationLabel(row)}
                        </span>
                        <strong className="compact-ellipsis" title={note}>
                          {note}
                        </strong>
                      </div>
                    </td>
                    <td>
                      <div className="history-environment">
                        <span
                          className="compact-ellipsis"
                          title={row.service + ' · ' + environments}
                        >
                          {row.service} ·{' '}
                          {row.targets && row.targets.length > 1
                            ? row.targets.length + ' 个目标'
                            : environments}
                        </span>
                        {!!row.targets?.length && (
                          <button
                            className="compact-expand"
                            aria-label={isExpanded ? '收起目标' : '展开目标'}
                            aria-expanded={isExpanded}
                            onClick={() => toggle(row.id)}
                          >
                            <ChevronDown size={14} />
                          </button>
                        )}
                      </div>
                    </td>
                    <td title={fmtTime(row.started)}>
                      <time dateTime={row.started}>
                        {Number.isFinite(Date.parse(row.started))
                          ? fmtTime(row.started).slice(11, 16)
                          : '—'}
                      </time>
                    </td>
                    <td className="compact-mono" title={seconds(row.elapsed)}>
                      <span className="compact-ellipsis">
                        {seconds(row.elapsed).replace(/\s+/g, '')}
                      </span>
                    </td>
                    {showVersion && (
                      <td className="history-version-cell">
                        <span className="history-hashes">
                          <code title={'Git：' + (row.commit || '未记录')}>
                            {validHash(row.commit) ? shortHash(row.commit) : '—'}
                          </code>
                          <code title={'JAR：' + (row.jarHash || '未记录')}>
                            {validHash(row.jarHash) ? shortHash(row.jarHash) : '—'}
                          </code>
                        </span>
                      </td>
                    )}
                    <td>
                      <MoreMenu
                        label={'更多任务 ' + row.id + '操作'}
                        actions={[
                          {
                            label: '查看任务',
                            disabled: blocked,
                            reason: row.uncertain ? row.note : undefined,
                            onClick: () => open(row),
                          },
                          {
                            label: isExpanded ? '收起任务信息' : '展开任务信息',
                            onClick: () => toggle(row.id),
                          },
                          { label: '复制任务编号', onClick: () => onCopy(row.id) },
                          ...(row.releaseId ? [{
                            label: '筛选同清单',
                            onClick: () => {
                              setQuery('');
                              setFilters({ ...emptyFilters, releaseId: row.releaseId });
                            },
                          }] : []),
                          ...(validHash(row.commit)
                            ? [{ label: '复制 Git 提交', onClick: () => onCopy(row.commit!) }]
                            : []),
                          ...(validHash(row.jarHash)
                            ? [{ label: '复制 JAR 指纹', onClick: () => onCopy(row.jarHash!) }]
                            : []),
                        ]}
                      />
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr className="compact-detail-row">
                      <td colSpan={showVersion ? 7 : 6}>
                        <div className="history-expanded-info">
                          <span>
                            任务编号：<code>{row.id}</code>
                            {row.imported && ' · 导入的历史快照'}
                          </span>
                          <HashValue label="Git 提交" value={row.commit} onCopy={onCopy} />
                          <HashValue label="JAR 指纹" value={row.jarHash} onCopy={onCopy} />
                        </div>
                        {row.buildFailed && (
                          <p className="warning">
                            构建失败，所选目标未开始部署；请在任务详情查看构建日志。
                          </p>
                        )}
                        {row.targets?.map((target) => (
                          <div className="history-target-line" key={target.id}>
                            <strong>{target.name}</strong>
                            <span className="compact-ellipsis" title={target.server}>
                              {target.server}
                            </span>
                            <span>{seconds(target.elapsed)}</span>
                            <Badge>
                              {row.maintenance
                                ? taskResult(row)
                                : row.buildFailed && ['pending', 'skipped'].includes(target.status)
                                  ? '构建失败，未执行'
                                  : row.dryRun && target.status === 'success'
                                    ? '检查通过'
                                    : targetLabels[target.status]}
                            </Badge>
                            <Button
                              variant="link"
                              size="compact"
                              disabled={blocked}
                              onClick={() => open(row, target.id)}
                            >
                              查看目标详情
                            </Button>
                          </div>
                        ))}
                      </td>
                    </tr>
                  )}
                  {!!hits?.length && (
                    <tr className="compact-detail-row">
                      <td colSpan={showVersion ? 7 : 6}>
                        <div className="history-hits">
                          {hits.map((hit, i) => (
                            <button
                              key={i}
                              className="history-hit"
                              disabled={blocked}
                              onClick={() => open(row, hit.targetId)}
                            >
                              <strong>
                                {hit.section}
                                {hit.line ? ' · 第 ' + hit.line + ' 行' : ''}
                              </strong>
                              <span>{hit.text}</span>
                            </button>
                          ))}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {!matching.length && !searching && (
          <p className="empty">
            {error
              ? '搜索未完成，请调整关键词或筛选后重试。'
              : keyword
                ? '无匹配记录，试试调整筛选或关键词。'
                : '尚无匹配任务。'}
          </p>
        )}
      </Card>
    </>
  );
  if (!showStatistics) return <>{controls}{records}</>;
  return (
    <>
      <PageTabs
        aria-label="部署历史视图"
        idPrefix={tabId}
        controls={(value) => `${tabId}-panel-${value}`}
        items={historyTabs}
        value={activeTab}
        onValueChange={setTab}
      />
      {historyTabs.map(({ value }) => (
        <div
          key={value}
          className="history-tab-panel"
          role="tabpanel"
          id={`${tabId}-panel-${value}`}
          aria-labelledby={`${tabId}-${value}`}
          hidden={activeTab !== value}
        >
          {activeTab === value && <>
            {controls}
            {value === 'records' ? records : (
              <DeployStatsView
                history={releaseId ? db.history.filter((record) => record.releaseId === releaseId) : db.history}
                tasks={releaseId ? rows.filter((row) => row.releaseId === releaseId) : rows}
                scope={filters}
                onAdjust={openFilters}
                onService={(id) => setFilters((old) => old.service === id ? old : { ...old, service: id })}
              />
            )}
          </>}
        </div>
      ))}
    </>
  );
}
