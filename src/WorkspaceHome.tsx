import { useEffect, useState } from 'react';
import type { Database, Preset } from './model';
import { fmtTime } from './model';
import type { DesktopAPI, TaskSummary } from './platform';
import { Card, Field, Modal, Badge } from './ui';
import { VersionFacts } from './DeployDetails';
import { MoreMenu } from './EntityActions';
import { Disclosure } from './WorkspaceLayout';
import { taskResult } from './presentation';
import { guideSteps, presetReason, type WorkspacePage } from './workspace-model';
export function FirstGuide({
  db,
  tasks,
  onPage,
  onImport,
}: {
  db: Database;
  tasks: TaskSummary[];
  onPage: (page: WorkspacePage) => void;
  onImport: () => void;
}) {
  const steps = guideSteps(db, tasks);
  if (steps.every((s) => s.done)) return null;
  return (
    <Disclosure
      title={'开始使用 · ' + steps.filter((s) => s.done).length + '/' + steps.length}
      description="配置清单与首次试运行"
      open={!db.services.length}
    >
      <Card
        title="开始使用"
        action={
          <button className="link" onClick={onImport}>
            导入配置
          </button>
        }
      >
        <p className="note">先配置本机构建环境和目标，再执行只读试运行。不会自动连接服务器。</p>
        <div className="guide-steps">
          {steps.map((s, i) => (
            <button className="guide-step" key={s.key} onClick={() => onPage(s.page)}>
              <span>{i + 1}</span>
              <strong>{s.name}</strong>
              <Badge kind={s.done ? 'good' : ''}>{s.done ? '已完成' : '待完成'}</Badge>
            </button>
          ))}
        </div>
      </Card>
    </Disclosure>
  );
}
export function Overview({
  db,
  tasks,
  api,
  onDeploy,
  onPage,
  onCopy,
  onImport,
  presetShelf,
  onTargets,
}: {
  onTargets?: (serviceId: string) => void;
  db: Database;
  tasks: TaskSummary[];
  api?: DesktopAPI;
  onDeploy: (service: string, target: string) => void;
  onPage: (page: WorkspacePage) => void;
  onCopy: (text: string) => void;
  onImport: () => void;
  presetShelf?: React.ReactNode;
}) {
  const [differences, setDifferences] = useState<Record<string, string>>({}),
    [refresh, setRefresh] = useState(0),
    [checking, setChecking] = useState(false);
  const key = JSON.stringify([
    db.services,
    db.targets.map((t) => [t.id, t.currentHash, t.currentCommit, t.lastDeploy]),
  ]);
  useEffect(() => {
    let alive = true;
    setDifferences({});
    if (!api) return;
    setChecking(true);
    void api
      .localDifferences()
      .then((v) => {
        if (alive) setDifferences(v);
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setChecking(false);
      });
    return () => {
      alive = false;
    };
  }, [api, key, refresh]);
  return (
    <div className="stack">
      <FirstGuide db={db} tasks={tasks} onPage={onPage} onImport={onImport} />
      {!!db.presets?.some((p) => p.pinned) && presetShelf}
      <Card
        title="服务与环境"
        action={
          <button className="link" disabled={checking} onClick={() => setRefresh((n) => n + 1)}>
            {checking ? '正在读取本地差异…' : '刷新本地差异'}
          </button>
        }
      >
        <p className="note">线上信息来自最近任务记录，未实时连接服务器。健康状态为上次结果。</p>
        <div className="overview-grid">
          {db.services.map((s) => {
            const targets = db.targets.filter((t) => t.serviceId === s.id);
            return targets.length ? (
              targets.map((t) => {
                const recent = tasks.find(
                  (r) =>
                    r.serviceId === s.id &&
                    !r.dryRun &&
                    !r.maintenance &&
                    r.targets?.some((x) => x.id === t.id),
                );
                return (
                  <article className="overview-target" key={t.id}>
                    <div className="row spread wrap">
                      <h3>
                        {s.name} · {t.name}
                      </h3>
                      <Badge kind={t.production ? 'warn' : ''}>
                        {t.production ? '正式环境' : '非正式环境'}
                      </Badge>
                    </div>
                    <VersionFacts target={t} onCopy={onCopy} />
                    <dl className="detail-list">
                      <dt>上次部署</dt>
                      <dd>{fmtTime(t.lastDeploy)}</dd>
                      <dt>最近结果</dt>
                      <dd>{recent ? taskResult(recent) : '尚未部署'}</dd>
                      <dt>健康状态</dt>
                      <dd>{t.healthState}</dd>
                      <dt>本地差异</dt>
                      <dd>{differences[t.id] || (checking ? '正在比较…' : '无法判断')}</dd>
                    </dl>
                    <button className="button" onClick={() => onDeploy(s.id, t.id)}>
                      部署到{t.name}
                    </button>
                  </article>
                );
              })
            ) : (
              <article className="overview-target" key={s.id}>
                <h3>{s.name}</h3>
                <p className="muted">尚未配置部署目标。</p>
                <button
                  className="button"
                  onClick={() => (onTargets ? onTargets(s.id) : onPage('targets'))}
                >
                  配置部署目标
                </button>
              </article>
            );
          })}
        </div>
        {!db.services.length && <p className="empty">尚未配置服务，按照上面的清单开始。</p>}
      </Card>
    </div>
  );
}
export function PresetShelf({
  db,
  choice,
  onChange,
  onLoad,
  disabled = false,
  pinnedOnly = false,
}: {
  db: Database;
  choice?: Omit<Preset, 'id' | 'name' | 'pinned'>;
  onChange: (presets: Preset[]) => void;
  onLoad: (p: Preset) => void;
  disabled?: boolean;
  pinnedOnly?: boolean;
}) {
  const [editing, setEditing] = useState<{ id?: string; name: string; pinned: boolean }>(),
    [removing, setRemoving] = useState<Preset>();
  const presets = db.presets || [],
    visible = pinnedOnly ? presets.filter((p) => p.pinned) : presets;
  return (
    <Card
      title="部署预设"
      action={
        choice && (
          <button
            className="link"
            disabled={disabled || !choice.targetIds.length}
            onClick={() => setEditing({ name: '', pinned: true })}
          >
            保存当前选择
          </button>
        )
      }
    >
      <p className="note">载入后重新检查并进入确认页，正式环境仍需逐项确认名称。</p>
      <div className="preset-list">
        {visible.map((p) => (
          <div className="list-row" key={p.id}>
            <div className="grow">
              <strong>{p.name}</strong>
              <p className="muted">
                {db.services.find((s) => s.id === p.serviceId)?.name || '服务已删除'} ·{' '}
                {p.targetIds
                  .map((id) => db.targets.find((t) => t.id === id)?.name || '目标已删除')
                  .join('、')}{' '}
                · {p.build === 'rebuild' ? '重新构建' : '使用现有 JAR'}
              </p>
            </div>
            <span title={presetReason(db, p)}>
              <button
                className="button"
                disabled={disabled || !!presetReason(db, p)}
                onClick={() => onLoad(p)}
              >
                载入
              </button>
            </span>
            <MoreMenu
              label={p.name + '预设操作'}
              actions={[
                {
                  label: p.pinned ? '取消固定' : '固定到首页',
                  onClick: () =>
                    onChange(presets.map((v) => (v.id === p.id ? { ...v, pinned: !v.pinned } : v))),
                },
                {
                  label: '重命名',
                  onClick: () => setEditing({ id: p.id, name: p.name, pinned: p.pinned }),
                },
                { label: '删除预设', destructive: true, onClick: () => setRemoving(p) },
              ]}
            />
          </div>
        ))}
      </div>
      {!visible.length && (
        <p className="empty">
          {pinnedOnly
            ? '尚无固定预设，在一键部署页保存常用选择。'
            : '尚无预设，可保存当前服务和目标选择。'}
        </p>
      )}
      {editing && (
        <Modal
          title={editing.id ? '重命名预设' : '保存部署预设'}
          onClose={() => setEditing(undefined)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const name = editing.name.trim();
              if (!name || presets.some((p) => p.id !== editing.id && p.name === name)) return;
              if (editing.id)
                onChange(presets.map((p) => (p.id === editing.id ? { ...p, name } : p)));
              else if (choice)
                onChange([
                  ...presets,
                  {
                    ...structuredClone(choice),
                    id: crypto.randomUUID(),
                    name,
                    pinned: editing.pinned,
                  },
                ]);
              setEditing(undefined);
            }}
          >
            <Field label="预设名称">
              <input
                required
                maxLength={100}
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                data-autofocus
              />
            </Field>
            {presets.some((p) => p.id !== editing.id && p.name === editing.name.trim()) && (
              <p className="warning">名称已存在。</p>
            )}
            <p className="note">
              仅保存服务、目标、构建方式、备份选择和失败策略，不保存认证口令或本地快照。
            </p>
            <div className="modal-actions">
              <button className="button" type="button" onClick={() => setEditing(undefined)}>
                取消
              </button>
              <button className="button primary" type="submit">
                保存预设
              </button>
            </div>
          </form>
        </Modal>
      )}
      {removing && (
        <Modal title="删除预设" onClose={() => setRemoving(undefined)}>
          <p>删除「{removing.name}」？服务、目标和部署历史会保留。</p>
          <div className="modal-actions">
            <button className="button" onClick={() => setRemoving(undefined)}>
              取消
            </button>
            <button
              className="button danger"
              onClick={() => {
                onChange(presets.filter((p) => p.id !== removing.id));
                setRemoving(undefined);
              }}
            >
              确认删除
            </button>
          </div>
        </Modal>
      )}
    </Card>
  );
}
export function ShortcutHelp() {
  return (
    <Card title="快捷键">
      <div className="table-wrap">
        <table>
          <tbody>
            <tr>
              <td>Alt + 1 / 2 / 3 / 4</td>
              <td>首页总览 / 一键部署 / 当前任务 / 部署历史</td>
            </tr>
            <tr>
              <td>Ctrl + Enter</td>
              <td>在部署确认页确认（所有安全条件满足后）</td>
            </tr>
            <tr>
              <td>Esc</td>
              <td>先关闭帮助说明，再关闭最上层弹窗</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="note">在输入框中编辑时，页面切换快捷键不生效。</p>
    </Card>
  );
}
