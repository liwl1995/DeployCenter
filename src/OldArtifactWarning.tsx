import { AlertTriangle } from 'lucide-react';
import { ConfirmWarning } from './ConfirmWarning';
import type { Artifact, ServiceSnapshot } from './model';

export function OldArtifactWarning({ value, service, compact }: { value: Artifact; service: ServiceSnapshot; compact?: boolean }) {
  if (!value.exists || !(new Date(value.modified) < new Date(service.git.time))) return null;
  const text = 'JAR 早于当前 Git 提交，请确认是否需要重新构建。';
  if (compact) return <ConfirmWarning label="产物版本提示" text={text} />;
  return (
    <p className="warning">
      <AlertTriangle size={15} />
      {text}
    </p>
  );
}
