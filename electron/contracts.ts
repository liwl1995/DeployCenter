import type { Task, Database } from '../src/model';
import type { TrustRequest } from '../src/platform';
import type { Receipt } from './workbench';
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
  workbenchReceipts?: Receipt[];
  artifactSources?: import('./files').SnapshotSource[];
};
export type WorkerMessage =
  | { kind: 'snapshot'; task: Task }
  | {
      kind: 'log';
      taskId: string;
      targetId?: string;
      text: string;
      context?: import('../src/features').LogContext;
    }
  | { kind: 'handoff'; task: Task; targetId: string; receipt: Receipt }
  | { kind: 'workbench-cleaned'; receipt: Receipt }
  | { kind: 'trust'; request: TrustRequest; key: string }
  | { kind: 'done'; task: Task }
  | { kind: 'fatal'; error: string };
export type ControlMessage =
  | { kind: 'begin'; value: WorkerInput }
  | { kind: 'cancel' }
  | { kind: 'handoff-result'; owner: string; error?: string }
  | { kind: 'trust-result'; id: string; accepted: boolean };
export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
