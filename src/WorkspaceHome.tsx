import { useState } from 'react';
import type { Database, Preset } from './model';
import type { TaskSummary } from './platform';
import { Card, Field, Modal, Badge } from './ui';
import { MoreMenu } from './EntityActions';
import { Disclosure } from './WorkspaceLayout';
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
