import type { Task } from './model';
import type { PrepareRequest } from './platform';

export type ReleaseRequest = Pick<PrepareRequest, 'serviceId' | 'targetIds' | 'build' | 'jarPath' | 'overrides' | 'failurePolicy' | 'note' | 'observationOverrides'>;
type RowState = 'queued' | 'starting' | 'running' | 'success' | 'partial' | 'failed' | 'cancelled' | 'unknown' | 'skipped';
export type ReleaseRow = {
  request: ReleaseRequest;
  name: string;
  targets: string[];
  state: RowState;
  taskId?: string;
  elapsed?: number;
  detail?: string;
  unverifiedTargets?: number;
};
export type ReleaseRun = {
  id?: string;
  state: 'running' | 'cancelling' | 'paused' | 'done';
  rows: ReleaseRow[];
  message: string;
  failurePolicy: PrepareRequest['failurePolicy'];
  cancelRequested?: true;
};
export type ReleasePreview = { request: ReleaseRequest; task: Task };
export type ReleaseReview = { token: string; previews: ReleasePreview[] };
