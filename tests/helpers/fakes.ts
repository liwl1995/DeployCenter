import type { EngineDependencies, RemoteSession } from '../../electron/capabilities';
import type { WorkerInput } from '../../electron/contracts';
import { MemoryCredentials } from '../../electron/native-capabilities';
import { memoryChannel } from '../../electron/ssh';
export function fakeCapabilities(
  input: WorkerInput,
  options: {
    failed?: string;
    buildCode?: number;
    oldJar?: boolean;
    disconnect?: boolean;
    onUpload?: () => void;
  } = {},
) {
  let now = input.task.startedAt,
    builds = 0,
    sessionIndex = 0;
  const commands: string[] = [],
    uploads: string[] = [],
    sessions: string[] = [];
  const deps: EngineDependencies = {
    clock: {
      now: () => (now += 100),
      sleep: async (ms) => {
        now += ms;
      },
    },
    commands: {
      run: async () => ({ code: 0, stdout: '', stderr: '', successMarker: false }),
      gitInfo: async () => ({ ...input.task.service.git, dirty: false }),
      resolveBuild: async () => ({
        tool: 'mvnw.cmd',
        args: ['clean', 'package'],
        cwd: 'fixture',
        env: {},
        java: 'fake-java',
        jdkPath: 'fixture-jdk',
        run: async (opts) => {
          builds++;
          opts.onData?.('BUILD SUCCESS\nsecret=password-not-for-storage\n');
          return {
            code: options.buildCode || 0,
            stdout: 'BUILD SUCCESS',
            stderr: '',
            successMarker: true,
          };
        },
      }),
    },
    files: {
      mkdir: async () => {},
      stat: async () => ({ size: 100, mtimeMs: now + 100, isFile: () => true }),
      snapshot: async () => ({
        ...input.task.artifact,
        size: 100,
        sha256: 'a'.repeat(64),
        source: 'file',
      }),
    },
    credentials: new MemoryCredentials({ ...input.credentials }),
    remote: (server) => {
      const target = input.task.targets[Math.min(sessionIndex++, input.task.targets.length - 1)];
      const journal = () => {
        const lines: string[] = [];
        for (const step of target.steps.filter(
          (s) => !['connect', 'upload', 'mount'].includes(s.key),
        )) {
          lines.push(`${(now += 200)}\tSTEP\t${step.key}\tSTART`);
          if (step.key === 'backup' && options.oldJar !== false)
            lines.push(`${now}\tBACKUP\t99\t${'b'.repeat(64)}`);
          lines.push(
            `${(now += 200)}\tSTEP\t${step.key}\t${options.failed === target.target.id && step.key === 'start' ? 'FAIL' : 'OK'}`,
          );
          if (options.failed === target.target.id && step.key === 'start') break;
        }
        return Buffer.from(lines.join('\n') + '\n');
      };
      const session: RemoteSession = {
        connect: async () => {
          sessions.push(server.id);
        },
        channel: async () => memoryChannel(),
        upload: async (_file, remote, progress) => {
          uploads.push(remote);
          progress(100);
          options.onUpload?.();
        },
        close: () => {},
        exec: async (command, opts) => {
          commands.push(command + (opts?.input || ''));
          if (command.includes("'/state'"))
            return {
              code: 0,
              stdout: options.failed === target.target.id ? 'FAILED' : 'UNVERIFIED',
              stderr: '',
            };
          if (command.includes('/state')) {
            if (options.disconnect) throw new Error('SSH disconnected');
            return {
              code: 0,
              stdout: options.failed === target.target.id ? 'FAILED' : 'UNVERIFIED',
              stderr: '',
            };
          }
          if (command.includes('/preflight'))
            return {
              code: 0,
              stdout: `old_exists=${options.oldJar === false ? 0 : 1}\nold_size=99\nold_hash=${'b'.repeat(64)}\nalgorithm=sha256sum\n`,
              stderr: '',
            };
          return { code: 0, stdout: '检查通过\n', stderr: '' };
        },
        read: async (file, offset) =>
          file.endsWith('/journal') && offset === 0 ? journal() : Buffer.alloc(0),
      };
      return session;
    },
  };
  return {
    deps,
    commands,
    uploads,
    sessions,
    get builds() {
      return builds;
    },
  };
}
