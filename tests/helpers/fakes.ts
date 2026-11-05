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
    cleanupFails?: boolean;
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
      let state = 'PREPARED';
      let journalBytes: Buffer | undefined;
      const fileBytes = (name: string) =>
        name === 'journal' ? (journalBytes ??= journal()) :
        name === 'state' ? Buffer.from(state) :
        name === 'output.log' ? Buffer.from('最终 Docker 日志\n') : Buffer.from('任务标识');
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
          const script = opts?.input || '';
          if (script.includes('nohup bash "$JOB/runner.sh"'))
            state = options.failed === target.target.id ? 'FAILED' : 'UNVERIFIED';
          if (script.includes('alive=0; dc_alive') && script.includes('printf "%s\\t%s"')) {
            if (options.disconnect) throw new Error('SSH disconnected');
            return { code: 0, stdout: state + '\t1', stderr: '' };
          }
          if (script.includes('printf "%s\\t%s\\t%s\\n" "$name"')) {
            const stdout = ['task', 'state', 'journal', 'output.log']
              .map((name) => [name, fileBytes(name).length, '-'].join('\t')).join('\n');
            return { code: 0, stdout, stderr: '' };
          }
          if (script.includes('printf NOT_OURS')) {
            state = 'CANCELLED';
            return { code: 0, stdout: state, stderr: '' };
          }
          if (script.includes('printf CLEANED')) {
            return options.cleanupFails
              ? { code: 1, stdout: 'UNEXPECTED\tkeep.txt', stderr: '' }
              : { code: 0, stdout: 'CLEANED', stderr: '' };
          }
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
        read: async (file, offset, max = 262144) =>
          fileBytes(file.split('/').at(-1)!).subarray(offset, offset + max),
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
