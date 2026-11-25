import { FileArchive, FolderOpen } from 'lucide-react';
import { Button } from './design/ui/button';
import { SegmentedControl } from './design/ui/segmented-control';
import type { Task } from './model';

export function BuildModeChoice({ mode, onMode }: {
  mode: Task['build'];
  onMode: (mode: Task['build']) => void;
}) {
  return <SegmentedControl aria-label="构建方式" size="sm" value={mode} onValueChange={onMode}
    items={[{ value: 'rebuild', label: '重新构建' }, { value: 'existing', label: '使用现有 JAR' }]} />;
}

export function BuildArtifactChoice({
  name,
  summary,
  mode,
  onMode,
  onPick,
}: {
  name: string;
  summary: string;
  mode: 'rebuild' | 'existing';
  onMode: (mode: 'rebuild' | 'existing') => void;
  onPick: () => void;
}) {
  return (
    <div className="artifact-summary">
      <span className="record-icon">
        <FileArchive size={18} strokeWidth={1.5} />
      </span>
      <div className="grow artifact-caption">
        <strong title={name}>{name}</strong>
        <small title={summary}>{summary}</small>
      </div>
      {mode === 'existing' && (
        <Button type="button" variant="neutral" size="compact" onClick={onPick}>
          <FolderOpen size={14} />
          选择本地 JAR
        </Button>
      )}
      <BuildModeChoice mode={mode} onMode={onMode} />
    </div>
  );
}
