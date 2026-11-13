/** 更新状态只在内存中流转；配置数据库和认证凭据不参与更新。 */
export type AppUpdate = {
  currentVersion: string;
  stage:
    | 'idle'
    | 'checking'
    | 'current'
    | 'available'
    | 'downloading'
    | 'verifying'
    | 'ready'
    | 'installing'
    | 'error';
  release?: { version: string; notes: string; publishedAt: string; size: number };
  checkedAt?: string;
  received: number;
  speed: number;
  message?: string;
};
