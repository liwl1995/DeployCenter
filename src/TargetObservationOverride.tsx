import type { Target } from './model';
import { Button } from './design/ui/button';
import { Field, Switch } from './ui';

export function TargetObservationOverride({ target, override, onChange }: {
  target: Target;
  override?: NonNullable<Target['observation']>;
  onChange: (value: Target['observation']) => void;
}) {
  const value = override ?? target.observation;
  const unavailable = target.mode === 'jar' && !target.appLogPath;
  return <>
    <Switch label="本次成功后观察日志" disabled={unavailable} checked={value?.enabled || false}
      onChange={(enabled) => onChange({ duration: value?.duration || 60, enabled })}
      description={unavailable ? '启用前需在目标配置中填写应用日志路径。' :
        '健康未验证且部署完成时，自动打开只读日志观察。'} />
    <Field label="本次观察时间（秒）">
      <input type="number" min="10" max="3600" value={value?.duration ?? 60}
        onChange={(event) => onChange({ enabled: value?.enabled || false, duration: Number(event.target.value) })} />
    </Field>
    {override && <Button variant="link" size="compact" onClick={() => onChange(undefined)}>恢复目标默认观察设置</Button>}
  </>;
}
