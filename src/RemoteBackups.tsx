import { useEffect, useRef, useState } from 'react';
import type { DesktopAPI } from './platform';
import type { BackupPlan, MaintenanceRecord } from './features';
import type { Target, Server } from './model';
import { fmtTime } from './model';
import { Badge, Field, Modal } from './ui';
const size = (n: number) => (n / 1048576).toFixed(1) + ' MB';
const labels = {
  pending: '执行结果待返回',
  success: '清理完成',
  partial: '部分清理',
  failed: '未清理',
  unknown: '清理结果待核实',
};
export function BackupAudit({ value }: { value: MaintenanceRecord }) {
  return (
    <div className="stack">
      <Badge>{labels[value.status]}</Badge>
      <p>
        {value.targetName} · {value.serverName} · {fmtTime(value.time)}
      </p>
      <p className="note">
        备份清理是独立操作，不改变原部署结果。
        {['pending', 'unknown'].includes(value.status)
          ? '结果不确定时请先只读核实，避免重复操作。'
          : ''}
      </p>
      <pre className="terminal">{value.message}</pre>
      <h3>确认的文件</h3>
      {value.requested.map((f) => (
        <div className="list-row" key={f.id}>
          <code className="grow path">{f.path}</code>
          <span>{size(f.size)}</span>
          <Badge>{value.deleted.includes(f.path) ? '已不存在' : '保留 / 待核实'}</Badge>
        </div>
      ))}
    </div>
  );
}
/** 凭据仅存在本弹窗内存与主进程短期预览中；卸载和关闭清单立即清除。 */
export function RemoteBackups({
  api,
  target,
  server,
  onClose,
}: {
  api: DesktopAPI;
  target: Target;
  server: Server;
  onClose: () => void;
}) {
  const [credential, setCredential] = useState(''),
    [plan, setPlan] = useState<BackupPlan>(),
    [selected, setSelected] = useState<string[]>([]),
    [confirm, setConfirm] = useState(false),
    [word, setWord] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [audits, setAudits] = useState<MaintenanceRecord[]>([]),
    [detail, setDetail] = useState<MaintenanceRecord>();
  const token = useRef<string | undefined>(undefined);
  const refresh = () => api.backupAudits(target.id).then(setAudits);
  useEffect(() => {
    void refresh().catch((e) => setError(String(e)));
    return () => {
      if (token.current) void api.cancelBackupPlan(token.current);
    };
  }, [api, target.id]);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const close = () => {
    if (!busy) {
      setCredential('');
      onClose();
    }
  };
  const chosen = plan?.entries.filter((e) => selected.includes(e.id)) || [];
  return (
    <Modal title={target.name + ' · 远程备份管理'} onClose={close} wide>
      <p className="note">
        读取列表不会删除文件。只清理本工具真实任务创建、且可校验完整指纹的备份；最新备份和任务引用的备份受保护。
      </p>
      {server.auth !== 'alias' && (
        <Field label={server.auth === 'password' ? '服务器密码' : '私钥口令（如有）'}>
          <input
            type="password"
            autoComplete="off"
            value={credential}
            onChange={(e) => setCredential(e.target.value)}
            placeholder={
              server.credentialMode === 'windows' ? '留空使用已保存凭据' : '仅本次使用，不保存'
            }
          />
        </Field>
      )}
      <button
        className="button"
        disabled={busy}
        onClick={() =>
          void run(async () => {
            if (token.current) await api.cancelBackupPlan(token.current);
            const p = await api.previewBackups(target.id, credential);
            token.current = p.token;
            setPlan(p);
            setSelected(p.entries.filter((e) => e.selected).map((e) => e.id));
          })
        }
      >
        {busy ? '正在处理…' : '读取备份列表（只读）'}
      </button>
      {error && (
        <p role="alert" className="warning">
          {error}
        </p>
      )}
      {plan && (
        <>
          <p>
            可读取 {plan.count} 个备份，占用 {size(plan.bytes)}。
          </p>
          {plan.effects.map((e) => (
            <p className="note" key={e}>
              {e}
            </p>
          ))}
          <div className="stack mt">
            {plan.entries.map((e) => (
              <label className="list-row" key={e.id}>
                <input
                  type="checkbox"
                  checked={selected.includes(e.id)}
                  disabled={busy || !!e.protectedReason}
                  onChange={(event) =>
                    setSelected((old) =>
                      event.target.checked ? [...old, e.id] : old.filter((id) => id !== e.id),
                    )
                  }
                />
                <div className="grow">
                  <code className="path">{e.path}</code>
                  <p className="muted">
                    {size(e.size)} · {fmtTime(e.time)}
                  </p>
                  {e.protectedReason && <p className="note">{e.protectedReason}</p>}
                </div>
              </label>
            ))}
          </div>
          {!plan.entries.length && (
            <p className="empty">暂无本工具确认创建的备份。导入历史不作为删除依据。</p>
          )}
          <button
            className="button danger mt"
            disabled={busy || !chosen.length || chosen.length > 100}
            onClick={() => {
              setWord('');
              setConfirm(true);
            }}
          >
            预览清理 {chosen.length} 个文件 · {size(chosen.reduce((n, f) => n + f.size, 0))}
          </button>
        </>
      )}
      {audits.length > 0 && (
        <div className="stack mt">
          <h3>清理记录</h3>
          {audits.map((a) => (
            <div className="list-row" key={a.id}>
              <div className="grow">
                <strong>{labels[a.status]}</strong>
                <p>
                  {fmtTime(a.time)} · {a.requested.length} 个文件
                </p>
              </div>
              <button className="button" onClick={() => setDetail(a)}>
                查看记录
              </button>
              {['pending', 'unknown'].includes(a.status) && (
                <button
                  className="button"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const result = await api.reconcileBackup(a.id, credential);
                      setDetail(result);
                      setCredential('');
                      await refresh();
                    })
                  }
                >
                  只读核实结果
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="modal-actions">
        <button className="button" disabled={busy} onClick={close}>
          返回
        </button>
      </div>
      {confirm && plan && (
        <Modal
          title="确认清理远程备份"
          onClose={() => {
            if (!busy) setConfirm(false);
          }}
        >
          <p className="warning">
            将删除下列 {chosen.length} 个文件，释放约 {size(chosen.reduce((n, f) => n + f.size, 0))}
            。这些备份将不能用于历史回滚，当前运行版本不受影响。
          </p>
          {chosen.map((e) => (
            <p key={e.id} className="path">
              {e.path}
            </p>
          ))}
          {plan.production && (
            <Field label={'输入正式环境名称：' + plan.environment}>
              <input autoFocus value={word} onChange={(e) => setWord(e.target.value)} />
            </Field>
          )}
          <div className="modal-actions">
            <button className="button" disabled={busy} onClick={() => setConfirm(false)}>
              返回列表
            </button>
            <button
              className="button danger"
              disabled={busy || (plan.production && word !== plan.environment)}
              onClick={() =>
                void run(async () => {
                  const result = await api.applyBackups(plan.token, selected, word);
                  setDetail(result);
                  setConfirm(false);
                  setPlan(undefined);
                  token.current = undefined;
                  setCredential('');
                  await refresh();
                })
              }
            >
              {busy ? '清理中，请等待结果' : '确认清理'}
            </button>
          </div>
        </Modal>
      )}
      {detail && (
        <Modal title="备份清理详情" onClose={() => setDetail(undefined)} wide>
          <BackupAudit value={detail} />
          <div className="modal-actions">
            <button className="button" onClick={() => setDetail(undefined)}>
              返回
            </button>
          </div>
        </Modal>
      )}
    </Modal>
  );
}
