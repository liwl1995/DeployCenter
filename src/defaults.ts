import type { Database, Service, Target } from './model';
export const prototype = typeof __PROTOTYPE__ === 'undefined' || __PROTOTYPE__;
export function newService(): Service {
  return {
    id: crypto.randomUUID(),
    name: '',
    code: '',
    description: '',
    root: '',
    workDir: '.',
    tool: 'auto',
    mavenPath: '',
    jdk: '',
    args: 'clean package -DskipTests',
    profiles: '',
    jarDir: 'target',
    jarName: 'service.jar',
    git: { branch: '待检测', commit: '待检测', time: new Date(0).toISOString() },
    buildTimeout: 1800,
    logEncoding: 'auto',
  };
}
export function newTargetTemplate(serviceId: string, serverId: string): Target {
  return {
    id: crypto.randomUUID(),
    serviceId,
    serverId,
    name: '',
    production: false,
    directory: '',
    fileName: 'service.jar',
    mode: 'jar',
    stop: '',
    start: '',
    restart: '',
    chmod: true,
    stopFailure: 'warn',
    container: '',
    containerJar: '',
    mount: 'directory',
    health: {
      type: 'none',
      value: '',
      timeout: 10,
      retries: 6,
      interval: 5,
      location: 'remote',
      startDelay: 0,
      maxWait: 300,
    },
    backup: {
      enabled: true,
      directory: 'backups',
      template: '{jarName}.{yyyyMMdd-HHmmss}.{task}.bak',
      autoRollback: true,
    },
    createDirectory: false,
    hashPolicy: 'required',
    hasOldJar: false,
    version: '未记录',
    lastDeploy: '未记录',
    healthState: '未配置健康检查',
    commandTimeout: 120,
    stabilitySeconds: 5,
  };
}
export function emptyDatabase(): Database {
  return {
    schema: 3,
    services: [],
    servers: [],
    targets: [],
    jdks: [],
    settings: {
      theme: 'system',
      failurePolicy: 'stop',
      allowMavenNonzero: true,
      historyLimit: 200,
      historyDays: 90,
      staleLockMinutes: 120,
      demoMode: false,
    },
    history: [],
    taskHistory: {},
    lastService: '',
    lastTargets: [],
  };
}
