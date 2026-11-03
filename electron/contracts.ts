import type { Task, Database } from '../src/model';
import type { TrustRequest } from '../src/platform';
export type RemoteJob = {
  jobDir: string;
  lockDir: string;
  stagePath: string;
  journalOffset: number;
  logOffset: number;
  phase: 'prepared' | 'launching' | 'running' | 'complete';
};
export type Pin = { key: string; fingerprint: string };
export type WorkerInput = {
  kind: 'deploy' | 'recover';
  task: Task;
  dataDir: string;
  jdks: Database['jdks'];
  allowMavenNonzero: boolean;
  credentials: Record<string, string>;
  pins: Record<string, Pin>;
  allowWeak: boolean;
};
export type WorkerMessage =
  | { kind: 'snapshot'; task: Task }
  | { kind: 'log'; taskId: string; targetId?: string; text: string }
  | { kind: 'trust'; request: TrustRequest; key: string }
  | { kind: 'done'; task: Task }
  | { kind: 'fatal'; error: string };
export type ControlMessage =
  | { kind: 'begin'; value: WorkerInput }
  | { kind: 'cancel' }
  | { kind: 'trust-result'; id: string; accepted: boolean };
export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
