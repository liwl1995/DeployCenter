export type MigrationProgress = {
  state: 'idle' | 'preparing' | 'copying' | 'verifying' | 'pending' | 'cancelled' | 'failed';
  copied: number;
  total: number;
  files: number;
  totalFiles: number;
  currentFile?: string;
  bytesPerSecond?: number;
  remainingSeconds?: number;
  verified?: number;
  verifiedFiles?: number;
  message: string;
  source?: string;
  target?: string;
};
export type DirectoryInfo = {
  path: string;
  bytes: number;
  files: number;
  previous?: string;
  previousBytes?: number;
  pending?: string;
  notice?: string;
  previousKept?: boolean;
};
export type DirectoryCheck = {
  path: string;
  valid: boolean;
  errors: string[];
  available: number;
  required: number;
  empty: boolean;
  writable: boolean;
};
export type LogContext = {
  time?: number;
  step?: string;
  command?: string;
  offset?: number;
  end?: number;
};
export type PrecheckItem = {
  key: string;
  label: string;
  state: 'pass' | 'fail' | 'unchecked' | 'pending';
  reason: string;
  blocking: boolean;
};
export type LocalPrecheck = {
  items: PrecheckItem[];
  tool?: string;
  version?: string;
  javaVersion?: string;
  hash?: string;
  checkedAt: string;
};
export type DiagnosticResult = {
  kind: string;
  command: string;
  output: string;
  ok: boolean;
  time: string;
};
export type BackupEntry = {
  id: string;
  path: string;
  size: number;
  time: string;
  hash?: string;
  protectedReason?: string;
  selected: boolean;
};
export type BackupPlan = {
  token: string;
  targetId: string;
  environment: string;
  production: boolean;
  entries: BackupEntry[];
  count: number;
  bytes: number;
  effects: string[];
};
export type SearchHit = {
  taskId: string;
  targetId?: string;
  section: string;
  line?: number;
  text: string;
};

export type CleanupKind = 'policy' | 'artifacts' | 'temporary' | 'legacy-success';
export type CleanupPlan = {
  token: string;
  kind: CleanupKind;
  bytes: number;
  files: number;
  tasks: string[];
  protected: number;
  warnings: string[];
  policy?: import('./model').ArtifactPolicy;
};
export type DataUsage = {
  database: number;
  logs: number;
  artifacts: number;
  temporary: number;
  backups: number;
  other: number;
  total: number;
  legacy: { pending: boolean; bytes: number; successBytes: number; warnings: string[] };
};
export type CleanupResult = {
  bytes: number;
  files: number;
  warnings: string[];
  policy?: import('./model').ArtifactPolicy;
};
export type SnapshotAvailability = { path?: string; available: boolean; reason: string };

export type LocalPrecheckRequest = {
  serviceId: string;
  targetIds: string[];
  build: import('./model').Task['build'];
  jarPath?: string;
};
export type ToolResult = {
  serviceId: string;
  tool: string;
  version: string;
  javaVersion: string;
  workDir: string;
  available: boolean;
  reason: string;
};
export type DiagnosticKind =
  | 'directory'
  | 'disk'
  | 'container'
  | 'logs'
  | 'process'
  | 'lock'
  | 'server';

export type HistorySearchResult = { hits: SearchHit[]; total: number; warnings: string[] };

export type LogSessionSnapshot = {
  id: string;
  targetId: string;
  active: boolean;
  endsAt?: number;
  chunks: { text: string; offset: number; context: LogContext }[];
  offset: number;
};

export type RemoteBackupRecord = {
  id: string;
  connection: string;
  targetId: string;
  targetName: string;
  serverId: string;
  serverName: string;
  path: string;
  hash?: string;
  size: number;
  createdAt: number;
  taskId: string;
  seq: number;
  removed: boolean;
};
export type MaintenanceRecord = {
  connection: string;
  directory: string;
  id: string;
  targetId: string;
  targetName: string;
  serverId: string;
  serverName: string;
  taskId?: string;
  time: string;
  status: 'pending' | 'success' | 'partial' | 'failed' | 'unknown';
  requested: { id: string; path: string; size: number; hash?: string }[];
  deleted: string[];
  message: string;
};
