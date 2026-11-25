import { useId } from 'react';
import { Button } from './design/ui/button';
import { FieldHelp } from './ui';
import type { Database } from './model';

type Policy = Database['settings']['failurePolicy'];

export function DeployFailurePolicy({ value, fallback, onChange, manifest = false }: {
  value: Policy | null;
  fallback: Policy;
  onChange: (value: Policy | null) => void;
  manifest?: boolean;
}) {
  const id = useId();
  const label = manifest ? '某个服务失败后' : '某个目标失败后';
  return (
    <div className="failure-policy">
      <Button variant="link" size="compact" className="failure-policy-reset" hidden={value === null}
        onClick={() => onChange(null)}>恢复默认</Button>
      <label className="sr-only" htmlFor={id}>{label}</label>
      <select id={id} value={value ?? fallback}
        onChange={(event) => onChange(event.target.value as Policy)}>
        <option value="stop">{manifest ? '失败后停止后续服务' : '失败后停止后续目标'}</option>
        <option value="continue">{manifest ? '失败后继续其他服务' : '失败后继续其他目标'}</option>
      </select>
      <FieldHelp label={label} text={
        (manifest ? '此处的选择只作用于本次清单。' : '此处的选择只作用于本次部署。') +
        '可在「设置 → 部署与构建」修改默认策略。'
      } />
    </div>
  );
}
