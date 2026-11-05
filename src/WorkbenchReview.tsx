import { useEffect, useState } from 'react';
import type { WorkbenchAction, WorkbenchReview } from './features';
import { desktop } from './platform';
import { Field } from './ui';

const actionLabel: Record<WorkbenchAction, string> = {
  import: '保存结果并清理',
  cleanup: '补清理远程工作文件',
  discard: '核实并丢弃现场',
  archive: '归档旧版工作文件',
};
const stateLabel: Record<string, string> = {
  PREPARED: '已预检，未启动',
  LAUNCHING: '正在启动远端任务',
  RUNNING: '执行中',
  AWAITING_LOCAL: '等待本机健康检查',
  SUCCESS: '部署成功',
  UNVERIFIED: '启动完成，健康未验证',
  FAILED: '执行失败',
  ROLLEDBACK: '执行失败，已回滚',
  ROLLBACK_FAILED: '执行失败，回滚也失败',
  CANCELLED: '已取消',
};

export function WorkbenchReviewPanel({
  review,
  onDone,
}: {
  review: WorkbenchReview;
  onDone: (message: string) => void;
}) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(
    () => () => {
      if (review.token) void desktop?.cancelWorkbenchReview(review.token).catch(() => {});
    },
    [review.token],
  );
  return (
    <>
      <p className="notice">{review.message}</p>
      <dl className="detail-list mt">
        <dt>部署目标</dt>
        <dd>{review.target}</dd>
        <dt>远程目录</dt>
        <dd className="path">{review.directory}</dd>
        {review.owner && (
          <>
            <dt>远程任务标识</dt>
            <dd className="path">{review.owner}</dd>
          </>
        )}
        {review.state && (
          <>
            <dt>远端状态</dt>
            <dd>{stateLabel[review.state] || '待核实'}</dd>
          </>
        )}
      </dl>
      <h3>核实证据</h3>
      <ul>
        {review.evidence.map((item) => (
          <li className="path" key={item}>
            {item}
          </li>
        ))}
      </ul>
      {review.unknown.length > 0 && (
        <>
          <h3>已保留的非预期文件</h3>
          <ul>
            {review.unknown.map((name) => (
              <li className="path" key={name}>
                {name}
              </li>
            ))}
          </ul>
        </>
      )}
      {review.legacy.length > 0 && (
        <details className="mt">
          <summary>旧版工作文件（{review.legacy.length} 项）</summary>
          <ul>
            {review.legacy.map((name) => (
              <li className="path" key={name}>
                {name}
              </li>
            ))}
          </ul>
        </details>
      )}
      {review.action && (
        <form
          className="mt"
          onSubmit={async (event) => {
            event.preventDefault();
            if (busy || error || typed !== review.target) return;
            setBusy(true);
            try {
              onDone(await desktop!.resolveWorkbench(review.token, typed));
            } catch (e) {
              setError(String(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="输入目标的完整环境名称确认" hint={review.target}>
            <input
              value={typed}
              disabled={busy}
              onChange={(event) => setTyped(event.target.value)}
            />
          </Field>
          {error && (
            <p className="warning" role="alert">
              {error}。请关闭后重新核实。
            </p>
          )}
          <footer className="modal-actions">
            <button
              className="button primary"
              disabled={busy || !!error || typed !== review.target}
            >
              {busy ? '正在处理…' : actionLabel[review.action]}
            </button>
          </footer>
        </form>
      )}
    </>
  );
}
