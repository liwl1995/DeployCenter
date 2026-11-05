import type {
  DirectoryInfo,
  DirectoryCheck,
  MigrationProgress,
  CleanupKind,
  CleanupPlan,
  CleanupResult,
  DataUsage,
  SnapshotAvailability,
  LocalPrecheckRequest,
  LocalPrecheck,
  ToolResult,
  DiagnosticKind,
  DiagnosticResult,
} from './features';
import type { Artifact, Backup, Database, History, Recovery, Task } from './model';

export type ServiceInfo = {
  artifact: Artifact;
  artifactError?: string;
  git: Database['services'][number]['git'];
  checkedAt: string;
};
export type Approval = {
  productionWord: string;
  productionNames?: Record<string, string>;
  allowWeak: boolean;
  protectCurrent: boolean;
};
export type PrepareRequest = {
  serviceId: string;
  targetIds: string[];
  build: Task['build'];
  jarPath?: string;
  overrides: Record<string, Backup>;
  failurePolicy: Database['settings']['failurePolicy'];
  historyId?: string;
  dryRun?: boolean;
  retryOf?: string;
  note?: string;
  observationOverrides?: Record<string, { enabled: boolean; duration: number }>;
};
export type TrustRequest = {
  id: string;
  server: string;
  endpoint: string;
  fingerprint: string;
  previousFingerprint?: string;
  changed: boolean;
};
export type TaskSummary = {
  id: string;
  service: string;
  operation: Task['operation'];
  status: Task['status'];
  started: string;
  elapsed: number;
  serviceId?: string;
  dryRun?: boolean;
  note?: string;
  jarHash?: string;
  commit?: string;
  buildFailed?: boolean;
  imported?: boolean;
  maintenance?: import('./features').MaintenanceRecord;
  uncertain?: boolean;
  targets?: {
    id: string;
    name: string;
    serverId: string;
    server: string;
    status: import('./model').TargetStatus;
    elapsed: number;
  }[];
};
export type Startup = {
  version?: string;
  database: Database;
  recovery?: Recovery;
  task?: Task;
  unfinished: Task[];
  dataDir: string;
  savedCredentials: string[];
  encryptionAvailable: boolean;
  pendingTrust?: TrustRequest;
  dataNotice?: string;
  dataUsage?: DataUsage;
  taskIssues?: { id: string; message: string }[];
  dataLocation?: { previous?: string; pending?: string; previousKept?: boolean };
};
export type DesktopEvent =
  | {
      kind: 'log';
      taskId: string;
      targetId?: string;
      text: string;
      offset?: number;
      context?: import('./features').LogContext;
    }
  | { kind: 'task'; task: Task }
  | { kind: 'database'; database: Database }
  | { kind: 'trust'; request: TrustRequest }
  | { kind: 'trust-closed'; id: string }
  | {
      kind: 'container-log';
      id: string;
      text: string;
      offset?: number;
      active?: boolean;
      context?: import('./features').LogContext;
    }
  | {
      kind: 'observation';
      taskId: string;
      targetId: string;
      label: string;
      sessionId: string;
      duration: number;
    }
  | { kind: 'observation-error'; targetId: string; message: string }
  | { kind: 'migration'; progress: MigrationProgress }
  | { kind: 'maintenance'; record: import('./features').MaintenanceRecord }
  | { kind: 'open-task'; taskId: string };
export interface DesktopAPI {
  load(): Promise<Startup>;
  save(database: Database): Promise<void>;
  confirmRecovery(): Promise<void>;
  prepare(request: PrepareRequest): Promise<{ task: Task; token: string }>;
  start(token: string, credentials: Record<string, string>, approval: Approval): Promise<Task>;
  cancel(taskId: string): Promise<void>;
  recover(taskId: string, credentials: Record<string, string>): Promise<Task>;
  choose(kind: 'directory' | 'jar' | 'key' | 'maven'): Promise<string | null>;
  inspectJar(path: string): Promise<Artifact>;
  localDifferences(): Promise<Record<string, string>>;
  serviceInfo(serviceId: string, jarPath?: string): Promise<ServiceInfo>;
  precheck(request: LocalPrecheckRequest): Promise<LocalPrecheck>;
  toolInfo(serviceId: string): Promise<ToolResult>;
  sshAliases(configFile?: string): Promise<{ hosts: string[]; warnings: string[] }>;
  testDraft(server: import('./model').Server, credential?: string): Promise<DiagnosticResult>;
  diagnose(
    targetId: string,
    kind: Exclude<DiagnosticKind, 'server'>,
    credential?: string,
  ): Promise<DiagnosticResult>;
  serverHealth(serverId: string, credential?: string): Promise<DiagnosticResult>;
  acceptDrop(file: File): Promise<Artifact>;
  detectJdks(): Promise<{ name: string; path: string }[]>;
  checkTool(kind: 'jdk' | 'maven', value: string): Promise<string>;
  resolveAlias(serverId: string): Promise<{ host: string; user: string; port: number }>;
  inspectWorkbench(targetId: string, credential?: string): Promise<import('./features').WorkbenchReview>;
  resolveWorkbench(token: string, confirmation: string): Promise<string>;
  cancelWorkbenchReview(token: string): Promise<void>;
  inspectLock(
    targetId: string,
    credential?: string,
  ): Promise<{ token: string; owner: string; created: number; stale: boolean; message: string }>;
  takeoverLock(token: string, word: string): Promise<void>;
  testConnection(serverId: string, credential?: string): Promise<string>;
  trust(id: string, accepted: boolean, confirmation?: string): Promise<void>;
  saveCredential(serverId: string, value: string): Promise<void>;
  deleteCredential(serverId: string): Promise<void>;
  exportConfig(): Promise<boolean>;
  importConfig(): Promise<Database | null>;
  readLogs(
    taskId: string,
    targetId: string,
    before?: { build: number; target: number },
  ): Promise<{
    build: string[];
    target: string[];
    truncated: boolean;
    buildOffset?: number;
    targetOffset?: number;
    buildStart?: number;
    targetStart?: number;
    buildContexts?: import('./features').LogContext[];
    targetContexts?: import('./features').LogContext[];
  }>;
  exportLogs(taskId: string, targetId?: string): Promise<boolean>;
  followLogs(targetId: string, credential?: string): Promise<string>;
  stopLogs(id: string): Promise<void>;
  readLogSession(id: string): Promise<import('./features').LogSessionSnapshot>;
  searchHistory(query: string): Promise<import('./features').HistorySearchResult>;
  cancelSearch(): Promise<void>;
  exportReport(taskId: string): Promise<boolean>;
  previewBackups(targetId: string, credential?: string): Promise<import('./features').BackupPlan>;
  applyBackups(
    token: string,
    ids: string[],
    confirmation: string,
  ): Promise<import('./features').MaintenanceRecord>;
  cancelBackupPlan(token: string): Promise<void>;
  backupAudits(targetId?: string): Promise<import('./features').MaintenanceRecord[]>;
  reconcileBackup(id: string, credential?: string): Promise<import('./features').MaintenanceRecord>;
  listTasks(): Promise<TaskSummary[]>;
  readTask(id: string): Promise<Task>;
  openDataDir(): Promise<void>;
  dataUsage(): Promise<DataUsage>;
  previewCleanup(
    kind: CleanupKind,
    policy?: import('./model').ArtifactPolicy,
  ): Promise<CleanupPlan>;
  applyCleanup(token: string, confirmed: boolean): Promise<CleanupResult>;
  snapshotAvailability(taskId: string): Promise<SnapshotAvailability>;
  directoryInfo(): Promise<DirectoryInfo>;
  inspectDirectory(path: string): Promise<DirectoryCheck>;
  migrateDirectory(path: string): Promise<MigrationProgress>;
  cancelMigration(): Promise<void>;
  migrationState(): Promise<MigrationProgress>;
  restart(): Promise<void>;
  keepOldData(): Promise<void>;
  removeOldData(path: string): Promise<void>;
  help(): Promise<void>;
  about(): Promise<void>;
  onEvent(callback: (event: DesktopEvent) => void): () => void;
}
declare global {
  interface Window {
    deployCenter?: DesktopAPI;
  }
}
export const desktop = typeof window !== 'undefined' ? window.deployCenter : undefined;
export function initialArtifact(service: Database['services'][number]): Artifact {
  return {
    name: service.jarName,
    path: '',
    size: 0,
    modified: new Date(0).toISOString(),
    exists: false,
    source: 'unknown',
  };
}
export function mergedDatabase(current: Database, incoming: Database): Database {
  return {
    ...current,
    history: incoming.history,
    taskHistory: incoming.taskHistory,
    targets: current.targets.map((t) => {
      const updated = incoming.targets.find((x) => x.id === t.id);
      return updated
        ? {
            ...t,
            version: updated.version,
            lastDeploy: updated.lastDeploy,
            healthState: updated.healthState,
            currentHash: updated.currentHash,
            currentCommit: updated.currentCommit,
          }
        : t;
    }),
  };
}
export const rollbackVersion = (h: History) => h.backupVersion || h.target.version;
