import type { Artifact, Backup, Database, History, Recovery, Task } from './model';

export type Approval = { productionWord: string; allowWeak: boolean; protectCurrent: boolean };
export type PrepareRequest = {
  serviceId: string;
  targetIds: string[];
  build: Task['build'];
  jarPath?: string;
  overrides: Record<string, Backup>;
  failurePolicy: Database['settings']['failurePolicy'];
  historyId?: string;
  dryRun?: boolean;
};
export type TrustRequest = {
  id: string;
  server: string;
  endpoint: string;
  fingerprint: string;
  changed: boolean;
};
export type TaskSummary = {
  id: string;
  service: string;
  operation: Task['operation'];
  status: Task['status'];
  started: string;
  elapsed: number;
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
};
export type DesktopEvent =
  | { kind: 'log'; taskId: string; targetId?: string; text: string; offset?: number }
  | { kind: 'task'; task: Task }
  | { kind: 'database'; database: Database }
  | { kind: 'trust'; request: TrustRequest }
  | { kind: 'trust-closed'; id: string }
  | { kind: 'container-log'; id: string; text: string };
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
  detectJdks(): Promise<{ name: string; path: string }[]>;
  checkTool(kind: 'jdk' | 'maven', value: string): Promise<string>;
  resolveAlias(serverId: string): Promise<{ host: string; user: string; port: number }>;
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
  ): Promise<{
    build: string[];
    target: string[];
    truncated: boolean;
    buildOffset?: number;
    targetOffset?: number;
  }>;
  exportLogs(taskId: string, targetId?: string): Promise<boolean>;
  followLogs(targetId: string, credential?: string): Promise<string>;
  stopLogs(id: string): Promise<void>;
  listTasks(): Promise<TaskSummary[]>;
  readTask(id: string): Promise<Task>;
  openDataDir(): Promise<void>;
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
          }
        : t;
    }),
  };
}
export const rollbackVersion = (h: History) => h.backupVersion || h.target.version;
