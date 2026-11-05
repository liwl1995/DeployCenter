import { mkdir, stat } from 'node:fs/promises';
import { snapshotJar, resolveBuild, gitInfo } from './files';
import { runProcess } from './process';
import { createTransport } from './ssh';
import type { EngineDependencies, CredentialProvider } from './capabilities';
export class MemoryCredentials implements CredentialProvider {
  constructor(private values: Record<string, string>) {}
  get(id: string) {
    return this.values[id];
  }
  clear() {
    this.values = {};
  }
  redact(text: string) {
    for (const value of Object.values(this.values)
      .filter(Boolean)
      .sort((a, b) => b.length - a.length))
      text = text.split(value).join('[已隐藏凭据]');
    return text
      .replace(/((?:password|passwd|token|secret)\s*[:=]\s*)[^\s]+/gi, '$1[已隐藏]')
      .replace(/(Authorization:\s*)[^\r\n]+/gi, '$1[已隐藏]');
  }
}
export function nativeCapabilities(
  values: Record<string, string>,
  sources: import('./files').SnapshotSource[] = [],
): EngineDependencies {
  return {
    clock: { now: Date.now, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
    commands: { run: runProcess, resolveBuild, gitInfo },
    files: {
      mkdir: (dir) => mkdir(dir, { recursive: true }).then(() => undefined),
      stat: (file) => stat(file).catch(() => undefined),
      snapshot: (file, id, dir, signal) => snapshotJar(file, id, dir, signal, sources),
    },
    credentials: new MemoryCredentials(values),
    remote: createTransport,
  };
}
