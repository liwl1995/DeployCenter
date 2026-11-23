export const operationLabels = { start: '启动', stop: '停止', restart: '重启' } as const;
export type ServiceOperation = keyof typeof operationLabels;
export type OperationStatus = {
  state: 'running' | 'stopped' | 'matched' | 'not-found' | 'unknown';
  locked: boolean;
  checkedAt: string;
  uptime?: string;
  pid?: string;
  restarts?: number;
  health?: string;
  message?: string;
};
export const operationStateLabels: Record<OperationStatus['state'], string> = {
  running: '运行中', stopped: '已停止', matched: '发现匹配进程',
  'not-found': '未发现匹配进程', unknown: '状态未知',
};
export type OperationPlan = {
  token: string;
  targetId: string;
  target: string;
  service: string;
  server: string;
  address: string;
  production: boolean;
  action: ServiceOperation;
  commands: string[];
  nextRelease?: number;
};
export type OperationRecord = {
  id: string;
  targetId: string;
  target: string;
  server: string;
  scope: string;
  action: ServiceOperation;
  actor: string;
  started: number;
  elapsed?: number;
  result: 'running' | 'success' | 'unverified' | 'failed' | 'blocked' | 'unknown';
  message: string;
  logs: string;
  settled?: boolean;
};
export const operationResultLabels: Record<OperationRecord['result'], string> = {
  running: '执行中', success: '操作完成', unverified: '健康未验证',
  failed: '执行失败', blocked: '未执行', unknown: '待核实',
};
