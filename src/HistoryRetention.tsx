import { useRef, useState } from 'react';
import { Button } from './design/ui/button';
import { storageSize } from './DataSettings';
import type { HistoryRetentionPolicy, HistoryRetentionPreview } from './features';
import type { Database } from './model';
import type { DesktopAPI } from './platform';
import { pruneHistory } from './records';
import { Field, Modal } from './ui';

/** 编辑保留规则时只改草稿，避免自动保存把中间值当作清理指令。 */
export function HistoryRetention({ api, db, disabled, onApplyLocal }: {
  api?: DesktopAPI;
  db: Database;
  disabled: boolean;
  onApplyLocal: (policy: HistoryRetentionPolicy) => void;
}) {
  const currentLimit = db.settings.historyLimit;
  const currentDays = db.settings.historyDays ?? 0;
  const [limit, setLimit] = useState(String(currentLimit));
  const [days, setDays] = useState(String(currentDays));
  const [plan, setPlan] = useState<HistoryRetentionPreview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const limitInput = useRef<HTMLInputElement>(null);
  const policy = { historyLimit: Number(limit), historyDays: Number(days) };
  const valid =
    /^[0-9]+$/.test(limit) && policy.historyLimit >= 1 && policy.historyLimit <= 10000 &&
    /^[0-9]+$/.test(days) && policy.historyDays <= 3650;
  const changed = policy.historyLimit !== currentLimit || policy.historyDays !== currentDays;
  const run = async (action: () => Promise<void>, closePreview = false) => {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (e) {
      setPlan(undefined);
      setError(String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''));
    } finally {
      setBusy(false);
      if (closePreview) setPlan(undefined);
    }
  };
  return (
    <div className="retention-history">
      <h3>部署历史</h3>
      <form className="stack" onSubmit={(event) => {
        event.preventDefault();
        if (!valid || !changed || disabled || busy) return;
        void run(async () => {
          const cutoff = policy.historyDays ? Date.now() - policy.historyDays * 86400000 : -Infinity;
          setPlan(api ? await api.previewHistoryRetention(policy) : {
            token: '',
            records: db.history.length - pruneHistory({
              ...db,
              settings: { ...db.settings, ...policy },
              history: db.history.filter((entry) => Date.parse(entry.time) >= cutoff),
            }).history.length,
            tasks: 0,
            logBytes: 0,
          });
        });
      }}>
        <div className="settings-fields">
          <Field label="历史保留条数" hint="按目标记录计数，范围为 1–10000。">
            <input ref={limitInput} type="number" min="1" max="10000" required value={limit}
              readOnly={busy} onChange={(event) => setLimit(event.target.value)} />
          </Field>
          <Field label="历史保留天数（0 为不按天清理）">
            <input type="number" min="0" max="3650" required value={days}
              readOnly={busy} onChange={(event) => setDays(event.target.value)} />
          </Field>
        </div>
        <Button type="submit" variant="neutral" size="compact" disabled={!valid || !changed || disabled || busy}>
          预览历史保留变更
        </Button>
        {error && <p className="warning" role="alert">{error}</p>}
      </form>
      {plan && (
        <Modal title="确认应用历史保留规则" onClose={() => setPlan(undefined)} closeDisabled={busy}
          returnFocus={limitInput.current ?? undefined}
          footer={<>
            <Button variant="neutral" onClick={() => setPlan(undefined)} disabled={busy}>返回</Button>
            <Button disabled={busy || disabled} onClick={() => void run(async () => {
              if (api) await api.applyHistoryRetention(plan.token, true);
              else onApplyLocal(policy);
            }, true)}>{busy ? '正在应用…' : '应用历史保留规则'}</Button>
          </>}>
          <p>保留最近 {policy.historyLimit} 条目标记录{policy.historyDays ? '，最长 ' + policy.historyDays + ' 天' : ''}。</p>
          <p>预计移除 {plan.records} 条目标记录和 {plan.tasks} 个任务的记录，释放约 {storageSize(plan.logBytes)} 日志空间。</p>
          <p>被移除的任务可能失去完整日志和本机产物重试入口。远程备份保持原样。</p>
        </Modal>
      )}
    </div>
  );
}
