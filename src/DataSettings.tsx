import { useEffect, useState, type ReactNode } from 'react';
import type { ArtifactPolicy } from './model';
import type { CleanupKind, CleanupPlan, DataUsage } from './features';
import type { DesktopAPI } from './platform';
import { Card, Field, Modal } from './ui';

export const storageSize = (bytes: number) =>
  bytes < 1024 ** 2
    ? (bytes / 1024).toFixed(1) + ' KB'
    : bytes < 1024 ** 3
      ? (bytes / 1024 ** 2).toFixed(1) + ' MB'
      : (bytes / 1024 ** 3).toFixed(2) + ' GB';
const defaults: ArtifactPolicy = { mode: 'success', maxCount: 5, maxGB: 1, failedDays: 7 };
export function DataSettings({
  api,
  section = 'all',
  historyFields,
  policy,
  onPolicy,
}: {
  api: DesktopAPI;
  section?: 'all' | 'usage' | 'retention';
  historyFields?: ReactNode;
  policy?: ArtifactPolicy;
  onPolicy: (policy: ArtifactPolicy) => void;
}) {
  const [usage, setUsage] = useState<DataUsage>();
  const [value, setValue] = useState({ ...defaults, ...policy });
  const [plan, setPlan] = useState<CleanupPlan>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  const refresh = async () => setUsage(await api.dataUsage());
  useEffect(() => {
    if (section !== 'retention') void refresh().catch((e) => setError(String(e)));
  }, [api, section]);
  useEffect(() => setValue({ ...defaults, ...policy }), [policy]);
  const preview = async (kind: CleanupKind) => {
    setBusy(true);
    setError('');
    setResult('');
    try {
      setPlan(await api.previewCleanup(kind, kind === 'policy' ? value : undefined));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    if (!plan) return;
    setBusy(true);
    setError('');
    try {
      const r = await api.applyCleanup(plan.token, true);
      if (r.policy) onPolicy(r.policy);
      setPlan(undefined);
      setResult(
        '已清理 ' +
          r.files +
          ' 个文件，释放 ' +
          storageSize(r.bytes) +
          (r.warnings.length ? '。部分文件已保留：' + r.warnings.join('；') : '。'),
      );
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card
      title={
        section === 'usage'
          ? '存储占用与清理'
          : section === 'retention'
            ? '保留规则'
            : '数据占用与产物保留'
      }
      className="mt"
      action={
        section !== 'retention' && (
          <button
            className="link"
            disabled={busy}
            onClick={() => void refresh().catch((e) => setError(String(e)))}
          >
            刷新占用
          </button>
        )
      }
    >
      <p className="muted">
        {section === 'usage'
          ? '本机文件按类别统计。清理前会显示释放空间及影响，活动和待核实任务受到保护。'
          : section === 'retention'
            ? '配置历史与产物的保留范围；远程备份独立管理，不随本机保留策略删除。'
            : '相同内容的 JAR 只保存一份。远程备份与本机产物相互独立，清理本机产物不会影响手动回滚。'}
      </p>
      {section !== 'retention' && usage && (
        <>
          <dl className="storage-usage">
            {(
              [
                ['数据库', usage.database],
                ['完整日志', usage.logs],
                ['产物快照', usage.artifacts],
                ['临时文件', usage.temporary],
                ['迁移与数据库备份', usage.backups],
                ['其他文件', usage.other],
                ['总计', usage.total],
              ] as const
            ).map(([label, bytes]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{storageSize(bytes)}</dd>
              </div>
            ))}
          </dl>
          {usage.legacy.pending && (
            <div className="notice" role="status">
              <strong>发现旧版产物，需要你确认后清理</strong>
              <p>
                已识别旧产物 {storageSize(usage.legacy.bytes)}，其中成功任务占{' '}
                {storageSize(usage.legacy.successBytes)}
                。建议先清理成功任务的产物；失败和中断任务默认保留。
              </p>
              <button
                className="button"
                disabled={busy}
                onClick={() => void preview('legacy-success')}
              >
                查看旧版成功产物清理范围
              </button>
            </div>
          )}
          {!!usage.legacy.warnings.length && (
            <div className="notice mt">
              <strong>有 {usage.legacy.warnings.length} 项内容已保留，请检查</strong>
              {usage.legacy.warnings.map((w, i) => (
                <p className="note" key={i}>
                  {w}
                </p>
              ))}
            </div>
          )}
        </>
      )}
      {section !== 'usage' && (
        <section className="retention-policy">
          {historyFields}
          <h3>产物快照</h3>{' '}
          <div className="form-grid mt">
            <Field label="产物保留方式">
              <select
                value={value.mode}
                onChange={(e) =>
                  setValue({ ...value, mode: e.target.value as ArtifactPolicy['mode'] })
                }
              >
                <option value="success">任务成功后删除（默认）</option>
                <option value="count">保留最近 N 个不同的 JAR</option>
                <option value="size">按总占用上限</option>
              </select>
            </Field>
            {value.mode === 'count' && (
              <Field label="保留不同 JAR 的数量">
                <input
                  type="number"
                  min="1"
                  max="10000"
                  value={value.maxCount}
                  onChange={(e) => setValue({ ...value, maxCount: Number(e.target.value) })}
                />
              </Field>
            )}
            {value.mode === 'size' && (
              <Field label="产物占用上限（GB）">
                <input
                  type="number"
                  min="0.01"
                  max="1024"
                  step="0.1"
                  value={value.maxGB}
                  onChange={(e) => setValue({ ...value, maxGB: Number(e.target.value) })}
                />
              </Field>
            )}
            <Field
              label="失败或取消任务产物保留天数"
              hint="运行中、取消中和中断待核实的任务始终保留；受保护产物可能使占用超过设置上限。"
            >
              <input
                type="number"
                min="1"
                max="3650"
                value={value.failedDays}
                onChange={(e) => setValue({ ...value, failedDays: Number(e.target.value) })}
              />
            </Field>
          </div>
          <div className="row wrap mt">
            <button
              className="button primary"
              disabled={busy}
              onClick={() => void preview('policy')}
            >
              预览并应用保留策略
            </button>
          </div>
        </section>
      )}
      {section !== 'retention' && (
        <div className="maintenance-area">
          <h3>手动清理</h3>
          <p className="note">
            只清理本机文件。确认前会显示释放空间与受影响任务，正在执行或待核实的任务受到保护。
          </p>
          <div className="row wrap">
            <button className="button" disabled={busy} onClick={() => void preview('artifacts')}>
              清理产物快照
            </button>
            <button className="button" disabled={busy} onClick={() => void preview('temporary')}>
              清理临时文件
            </button>
          </div>
        </div>
      )}
      {error && (
        <p className="warning" role="alert">
          {error}
        </p>
      )}
      {result && (
        <p className="note" role="status">
          {result}
        </p>
      )}
      {plan && (
        <Modal
          title={plan.kind === 'policy' ? '确认应用产物保留策略' : '确认清理本机文件'}
          onClose={() => {
            if (!busy) setPlan(undefined);
          }}
        >
          <p>
            将删除 {plan.files} 个文件，预计释放 <strong>{storageSize(plan.bytes)}</strong>。
            {plan.protected > 0 &&
              '有 ' + plan.protected + ' 项正在受任务或保留期限保护，不会删除。'}
          </p>
          {!!plan.tasks.length && (
            <>
              <p className="warning">
                以下任务将不能再使用原固定产物重试。需要重新构建或选择现有
                JAR；历史元数据和远程备份保留。
              </p>
              <ul>
                {plan.tasks.map((id) => (
                  <li key={id}>{id}</li>
                ))}
              </ul>
            </>
          )}
          {plan.kind === 'temporary' && (
            <p>仅清理本工具临时目录中的文件。运行中、取消中或中断任务的文件不会删除。</p>
          )}
          {plan.warnings.map((w, i) => (
            <p key={i} className="note">
              {w}
            </p>
          ))}
          <div className="row end mt">
            <button className="button" disabled={busy} onClick={() => setPlan(undefined)}>
              取消
            </button>
            <button
              data-autofocus
              className="button primary"
              disabled={busy}
              onClick={() => void apply()}
            >
              {busy ? '处理中…' : '确认应用'}
            </button>
          </div>
        </Modal>
      )}
    </Card>
  );
}

export function LegacyArtifactReview({
  api,
  usage,
  onClose,
}: {
  api: DesktopAPI;
  usage: DataUsage;
  onClose: () => void;
}) {
  const [plan, setPlan] = useState<CleanupPlan>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <Modal
      title="升级后首次检查本地产物"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <p>
        已识别旧版产物 {storageSize(usage.legacy.bytes)}，其中成功任务占{' '}
        {storageSize(usage.legacy.successBytes)}。建议清理成功任务的产物，减少数据目录占用。
      </p>
      <p>
        失败、中断或无法确认来源的内容会保留。历史信息和远程备份不受影响；未经确认不会删除旧产物。
      </p>
      {usage.legacy.warnings.map((w, i) => (
        <p className="note" key={i}>
          {w}
        </p>
      ))}
      {plan && (
        <p>
          本次将删除 {plan.files} 个文件，预计释放 <strong>{storageSize(plan.bytes)}</strong>
          。受影响任务：{plan.tasks.join('、') || '无'}。
        </p>
      )}
      {error && (
        <p role="alert" className="warning">
          {error}
        </p>
      )}
      <div className="row end mt">
        <button className="button" disabled={busy} onClick={onClose}>
          暂不清理
        </button>
        <button
          className="button primary"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError('');
            void (async () => {
              try {
                if (!plan) setPlan(await api.previewCleanup('legacy-success'));
                else {
                  await api.applyCleanup(plan.token, true);
                  onClose();
                }
              } catch (e) {
                setError(String(e));
              } finally {
                setBusy(false);
              }
            })();
          }}
        >
          {plan ? '确认清理成功任务产物' : '查看建议清理范围'}
        </button>
      </div>
    </Modal>
  );
}
