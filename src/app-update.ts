/** 更新状态与已下载文件分开保存，缓存恢复不依赖配置数据库或服务器凭据。 */
export type AppUpdate = {
  currentVersion: string;
  stage:
    | 'idle'
    | 'checking'
    | 'cached'
    | 'current'
    | 'available'
    | 'downloading'
    | 'verifying'
    | 'ready'
    | 'installing'
    | 'error';
  release?: { version: string; notes: string; publishedAt: string; size: number };
  cacheDirectory?: string;
  installerPath?: string;
  checkedAt?: string;
  received: number;
  speed: number;
  message?: string;
};

/** 仅比较正式版本，避免按字符串排序把 1.10 判为旧于 1.9。 */
export function versionParts(value: string): number[] {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) throw new Error('版本号不是受支持的正式版本');
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) throw new Error('版本号超出范围');
  return parts;
}

export function newerVersion(next: string, current: string): boolean {
  const a = versionParts(next),
    b = versionParts(current);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
