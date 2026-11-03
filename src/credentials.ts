import { type Server } from './model';
/** 只存活于当前页面内存，不进入任务、配置、日志或序列化对象。 */
export class CredentialSession {
  private values = new Map<string, string>();
  set(values: Record<string, string>) {
    this.clear();
    for (const [id, value] of Object.entries(values)) this.values.set(id, value);
  }
  get(id: string) {
    return this.values.get(id);
  }
  clear() {
    this.values.clear();
  }
}
export function credentialServers(servers: Server[]): Server[] {
  return [...new Map(servers.filter((s) => s.auth !== 'alias').map((s) => [s.id, s])).values()];
}
