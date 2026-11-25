import { AlertTriangle } from 'lucide-react';
import type { Artifact, ServiceSnapshot } from './model';

export function OldArtifactWarning({ value, service }: { value: Artifact; service: ServiceSnapshot }) {
  if (!value.exists || !(new Date(value.modified) < new Date(service.git.time))) return null;
  const text = 'JAR 早于当前 Git 提交，请确认是否需要重新构建。';
  return (
    <p className="warning">
      <AlertTriangle size={15} />
      {text}
    </p>
  );
}
