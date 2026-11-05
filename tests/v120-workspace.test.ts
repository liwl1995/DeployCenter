// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  aliases,
  diagnosticCommand,
  diagnose,
  localPrecheck,
  sameServer,
} from '../electron/workspace';
import { parseServer } from '../electron/validate';
import { seed, shellQuote } from '../src/model';
import type { ToolResult } from '../src/features';
import type { Transport } from '../electron/ssh';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (!root.startsWith(path.resolve('.test-data') + path.sep)) throw new Error('测试路径越界');
    await fs.rm(root, { recursive: true, force: true });
  }
});
const tool = async (): Promise<ToolResult> => ({
  serviceId: 'crm',
  tool: '测试构建工具',
  version: 'Maven 测试版本',
  javaVersion: 'Java 测试版本',
  workDir: 'fixture',
  available: true,
  reason: '',
});
describe('1.2.0 动态预检与只读操作', () => {
  it('重新构建缺少 JDK 时不可通过；现有 JAR 不依赖 JDK，并提示同线上指纹', async () => {
    const db = seed(),
      service = db.services[0],
      target = db.targets[0];
    db.jdks = [];
    const request = { serviceId: service.id, targetIds: [target.id], build: 'rebuild' as const };
    const check = await localPrecheck(db, request, [], 'fixture', tool);
    expect(check.items.find((x) => x.key === 'jdk')).toMatchObject({
      state: 'fail',
      blocking: true,
    });
    target.currentHash = 'a'.repeat(64);
    const existing = await localPrecheck(
      db,
      { ...request, build: 'existing' },
      [],
      'fixture',
      tool,
      async () => ({
        name: 'app.jar',
        path: 'fixture',
        exists: true,
        size: 10,
        modified: new Date().toISOString(),
        source: 'file',
        sha256: target.currentHash,
      }),
    );
    expect(existing.items.find((x) => x.key === 'jdk')?.state).toBe('pass');
    expect(existing.items.find((x) => x.key === 'same')?.reason).toContain('仍可部署');
    expect(existing.items.find((x) => x.key.startsWith('lock-'))?.state).toBe('unchecked');
  });
  it('无目标、无效产物与失效工具的阻断原因独立，外服务目标拒绝', async () => {
    const db = seed(),
      request = { serviceId: db.services[0].id, targetIds: [], build: 'existing' as const };
    const check = await localPrecheck(db, request, [], 'fixture', tool, async () => {
      throw new Error('JAR 损坏');
    });
    expect(check.items.filter((x) => x.state === 'fail').map((x) => x.key)).toEqual([
      'targets',
      'jar',
    ]);
    const badTool = await localPrecheck(
      db,
      { ...request, build: 'rebuild' },
      [],
      'fixture',
      async () => ({ ...(await tool()), available: false, reason: 'Maven 不存在' }),
    );
    expect(badTool.items.find((x) => x.key === 'tool')).toMatchObject({
      state: 'fail',
      reason: 'Maven 不存在',
    });
    await expect(
      localPrecheck(db, { ...request, targetIds: ['missing'] }, [], 'fixture', tool),
    ).rejects.toThrow('不属于');
  });
  it('只读模板不运行启停命令，名称和路径统一转义，日志路径未配置时说明原因', async () => {
    const target = seed().targets[0];
    target.start = 'DANGEROUS_START';
    target.stop = 'DANGEROUS_STOP';
    target.container = "容器 ' 名";
    target.directory = "/opt/带'引号";
    for (const kind of [
      'directory',
      'disk',
      'container',
      'logs',
      'process',
      'lock',
      'server',
    ] as const) {
      const command = diagnosticCommand(kind, target);
      expect(command).not.toContain('DANGEROUS');
      if (kind === 'container' || kind === 'logs')
        expect(command).toContain(shellQuote(target.container));
    }
    expect(diagnosticCommand('directory', target)).toContain(shellQuote(target.directory));
    target.mode = 'jar';
    target.appLogPath = '';
    expect(() => diagnosticCommand('logs', target)).toThrow('绝对路径');
    target.appLogPath = "/var/log/应用 ' 日志.log";
    expect(diagnosticCommand('logs', target)).toContain(shellQuote(target.appLogPath));
    expect(() => diagnosticCommand('arbitrary' as never, target)).toThrow('不支持');
  });
  it('诊断结果包含命令、状态与时间，已知口令不进入输出', async () => {
    const target = seed().targets[0],
      command = diagnosticCommand('disk', target);
    const transport = {
      exec: async (received: string) => {
        expect(received).toBe(command);
        return { code: 1, stdout: 'fixture-password', stderr: 'password=also-hidden' };
      },
    } as unknown as Transport;
    const result = await diagnose(transport, 'disk', target, 'fixture-password');
    expect(result.ok).toBe(false);
    expect(result.output).not.toContain('fixture-password');
    expect(result.output).not.toContain('also-hidden');
    expect(Number.isFinite(Date.parse(result.time))).toBe(true);
  });
  it('未保存服务器严格校验且不带额外敏感字段，身份变化不能复用旧凭据', () => {
    const original = seed().servers[0],
      parsed = parseServer({ ...original, password: 'never-persist' });
    expect(JSON.stringify(parsed)).not.toContain('never-persist');
    expect(sameServer(original, parsed)).toBe(true);
    expect(sameServer(original, { ...parsed, port: 1234 })).toBe(false);
    expect(() => parseServer({ ...original, auth: 'alias', alias: 'bad\ncommand' })).toThrow();
  });
  it('SSH 候选排除通配符，读取失败或 Include 时提示可手输，不干预系统解析', async () => {
    const base = path.resolve('.test-data');
    await fs.mkdir(base, { recursive: true });
    const root = await fs.mkdtemp(path.join(base, 'ssh-config-'));
    roots.push(root);
    const file = path.join(root, 'config');
    await fs.writeFile(
      file,
      'Host campus crm # 常用\nHost * !excluded prod-*\nInclude private/*.conf\nHost campus\n',
    );
    const result = await aliases(file);
    expect(result.hosts).toEqual(['campus', 'crm']);
    expect(result.warnings.join()).toContain('系统 SSH 完整解析');
    expect((await aliases(path.join(root, 'missing'))).warnings.join()).toContain('手动输入');
  });
});
