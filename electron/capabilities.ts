import type { Database, Service, Artifact } from '../src/model';
import type { Transport, ConnectOptions } from './ssh';
import type { ProcessOptions, ProcessResult } from './process';
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}
export interface CommandRunner {
  run(file: string, args: string[], options?: ProcessOptions): Promise<ProcessResult>;
  resolveBuild(
    service: Service,
    jdks: Database['jdks'],
    temp: string,
    options?: ProcessOptions,
  ): Promise<ResolvedBuild>;
  gitInfo(root: string): Promise<Service['git'] & { dirty: boolean }>;
}
export type ResolvedBuild = {
  tool: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  java: string;
  jdkPath: string;
  run(options: ProcessOptions): Promise<ProcessResult>;
};
export interface RemoteSession extends Transport {}
export interface FileSystem {
  mkdir(dir: string): Promise<void>;
  stat(file: string): Promise<{ size: number; mtimeMs: number; isFile(): boolean } | undefined>;
  snapshot(file: string, taskId: string, dataDir: string, signal?: AbortSignal): Promise<Artifact>;
}
export interface CredentialProvider {
  get(serverId: string): string | undefined;
  clear(): void;
  redact(text: string): string;
}
export interface EngineDependencies {
  clock: Clock;
  commands: CommandRunner;
  files: FileSystem;
  credentials: CredentialProvider;
  remote(server: Database['servers'][number], options: ConnectOptions): RemoteSession;
}
