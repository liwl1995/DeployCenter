import { AlertTriangle } from 'lucide-react';
import { Button } from './design/ui/button';
import { HoverTip } from './design/ui/hover-tip';
import type { Task } from './model';

export function confirmationWarnings(task: Task, identifyService = false) {
  if (task.dryRun || task.operation !== 'deploy') return [];
  const service = identifyService ? task.service.name + ' · ' : '';
  const stale = task.build === 'existing' && task.artifact.exists &&
    new Date(task.artifact.modified) < new Date(task.service.git.time);
  return [
    ...(stale ? [service + '所选 JAR 早于当前 Git 提交，请确认是否需要重新构建。'] : []),
    ...task.targets.filter(({ backup, target }) => !backup.enabled && (target.hasOldJar || target.currentHash))
      .map(({ target }) => service + target.name + '：本次不备份旧版本，无法从本次部署的备份回滚。'),
  ];
}

export function ConfirmWarning({ warnings }: { warnings: readonly string[] }) {
  if (!warnings.length) return null;
  return (
    <HoverTip disableHoverableContent contentClassName="confirm-warning-tooltip" content={<ul className="confirm-warning-list">{warnings.map((warning, index) =>
      <li key={index}>{warning}</li>
    )}</ul>}>
      <Button type="button" size="icon-compact" className="confirm-warning-icon" aria-label={`部署告警，共 ${warnings.length} 条`}>
        <AlertTriangle size={15} aria-hidden="true" />
      </Button>
    </HoverTip>
  );
}
