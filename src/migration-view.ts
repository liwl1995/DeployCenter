import type { MigrationProgress } from './features';
/** 这里只展示路径预览，主进程仍负责绝对路径、链接及目标范围检查。 */
export function migrationDestinationPreview(parent: string) {
  if (!parent) return '';
  return parent.replace(/[\\/]+$/, '') + '\\DeployCenter';
}
export function migrationPhase(state?: MigrationProgress['state']) {
  return (
    {
      idle: '准备',
      preparing: '准备',
      copying: '复制',
      verifying: '校验',
      pending: '完成待重启',
      failed: '迁移失败',
      cancelled: '已取消',
    } as const
  )[state || 'idle'];
}
/** 复制占八成、校验占两成；全部校验完成并等待重启时才显示 100%。 */
export function migrationPercent(progress?: MigrationProgress) {
  if (!progress) return 0;
  if (progress.state === 'pending') return 100;
  const copy = progress.total
    ? Math.min(1, progress.copied / progress.total)
    : progress.state === 'verifying'
      ? 1
      : 0;
  const verify = progress.totalFiles
    ? Math.min(1, (progress.verifiedFiles || 0) / progress.totalFiles)
    : 0;
  return Math.max(0, Math.min(99, Math.round(copy * 80 + verify * 20)));
}
