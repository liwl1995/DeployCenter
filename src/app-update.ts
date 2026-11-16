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
