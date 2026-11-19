import { Button } from './design/ui/button';
import { Box, FolderOpen, Plus } from 'lucide-react';
import { useState } from 'react';
import type { Database, Preset } from './model';
import { Card, Field, Modal } from './ui';
import { MoreMenu } from './EntityActions';
import { presetReason } from './workspace-model';

export function EmptyServiceWorkspace({ onAdd, onImport }: { onAdd: () => void; onImport: () => void }) {
  return (
    <section className="empty-service-workspace" aria-labelledby="empty-service-heading">
      <div className="empty-service-icon"><Box size={20} strokeWidth={1.5} aria-hidden /></div>
      <h2 id="empty-service-heading">还没有服务</h2>
      <p>添加要部署的 Java 服务，即可在工作台配置部署目标。</p>
      <div className="empty-service-actions">
        <Button size="regular" onClick={onAdd}><Plus size={16} />添加服务</Button>
        <Button variant="neutral" size="regular" onClick={onImport}><FolderOpen size={16} />导入配置</Button>
      </div>
    </section>
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
          <Button
            variant="link" size="compact"
            disabled={disabled || !choice.targetIds.length}
            onClick={() => setEditing({ name: '', pinned: true })}
          >
            保存当前选择
          </Button>
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
              <Button
                variant="neutral" size="compact"
                disabled={disabled || !!presetReason(db, p)}
                onClick={() => onLoad(p)}
              >
                载入
              </Button>
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
              <Button variant="neutral" size="compact" type="button" onClick={() => setEditing(undefined)}>
                取消
              </Button>
              <Button variant="default" size="compact" type="submit">
                保存预设
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {removing && (
        <Modal title="删除预设" onClose={() => setRemoving(undefined)}>
          <p>删除「{removing.name}」？服务、目标和部署历史会保留。</p>
          <div className="modal-actions">
            <Button variant="neutral" size="compact" onClick={() => setRemoving(undefined)}>
              取消
            </Button>
            <Button
              variant="danger" size="compact"
              onClick={() => {
                onChange(presets.filter((p) => p.id !== removing.id));
                setRemoving(undefined);
              }}
            >
              确认删除
            </Button>
          </div>
        </Modal>
      )}
    </Card>
  );
}
