import type { LocalPrecheck, PrecheckItem } from './features';
import { knownCommit, shortHash, validHash } from './presentation';
import type { Target } from './model';
import { Card } from './ui';
const states: Record<PrecheckItem['state'], string> = {
  pass: '通过',
  fail: '未通过',
  unchecked: '未检查',
  pending: '检查中',
};
export function deploymentBlockReason(
  check: LocalPrecheck | null,
  pending: boolean,
  selected: number,
) {
  if (!selected) return '请先选择部署目标。';
  if (pending) return '正在检查本地环境和产物，请稍候。';
  if (!check) return '尚未完成本次选择的本机预检。';
  return check.items.find((x) => x.blocking && x.state !== 'pass')?.reason || '';
}
export function PrecheckPanel({
  check,
  pending,
}: {
  check: LocalPrecheck | null;
  pending: boolean;
}) {
  return (
    <Card title="部署预检">
      <p className="note">
        {pending ? '检查当前选择中…' : '只读检查本机；未连接的远端项目如实标为未检查。'}
      </p>
      <ul className="precheck-list">
        {check?.items.map((item) => (
          <li key={item.key}>
            <div className="row spread">
              <strong>{item.label}</strong>
              <span
                className={
                  item.state === 'fail'
                    ? 'warning'
                    : item.state === 'pass'
                      ? 'accent-text'
                      : 'muted'
                }
              >
                {states[item.state]}
              </span>
            </div>
            <p className="note">{item.reason}</p>
          </li>
        ))}
      </ul>
    </Card>
  );
}
export function HashValue({
  value,
  label,
  onCopy,
}: {
  value?: string;
  label: string;
  onCopy: (value: string) => void;
}) {
  return (
    <span className="hash-value">
      <span>{label}</span>
      {validHash(value) ? (
        <>
          <code title={value}>{shortHash(value)}</code>
          <button
            className="icon-button"
            aria-label={'复制' + label}
            title={'复制完整' + label}
            onClick={() => onCopy(value!)}
          >
            复制
          </button>
        </>
      ) : (
        <em>未记录</em>
      )}
    </span>
  );
}
export function VersionFacts({
  target,
  onCopy,
}: {
  target: Pick<Target, 'version' | 'currentCommit' | 'currentHash'>;
  onCopy: (value: string) => void;
}) {
  const commit = target.currentCommit || knownCommit(target.version, target.currentHash);
  return (
    <div className="version-facts">
      {validHash(commit) && <HashValue label="Git 提交" value={commit} onCopy={onCopy} />}
      <HashValue label="JAR 指纹" value={target.currentHash} onCopy={onCopy} />
    </div>
  );
}
