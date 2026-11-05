// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Storage } from '../electron/storage';
const roots: { dir: string; store: Storage }[] = [];
afterEach(async () => {
  for (const { dir, store } of roots.splice(0)) {
    await store.settle();
    store.close();
    if (!dir.startsWith(path.resolve('.test-data') + path.sep)) throw new Error('测试目录越界');
    await fs.rm(dir, { recursive: true, force: true });
  }
});
it('日志原文保持字节不变，接收时间和步骤独立保存；旧日志不补造上下文', async () => {
  const base = path.resolve('.test-data');
  await fs.mkdir(base, { recursive: true });
  const dir = await fs.mkdtemp(path.join(base, 'log-context-'));
  const store = new Storage(dir, {
    encrypt: async (s) => Buffer.from(s),
    decrypt: async (b) => b.toString(),
  });
  roots.push({ dir, store });
  const a = '信息一\r\n',
    b = '[ERROR] 错误二\n';
  store.appendLog('DC-context', a, undefined, { time: 1000, step: '检查环境' });
  store.appendLog('DC-context', b, undefined, {
    time: 2000,
    step: '构建',
    command: 'mvn clean package',
  });
  store.appendLog('DC-context', '旧日志\n', 'target');
  expect(await fs.readFile(store.logPath('DC-context'), 'utf8')).toBe(a + b);
  const log = store.readLogs('DC-context', 'target');
  expect(log.buildContexts).toHaveLength(2);
  expect(log.targetContexts).toHaveLength(0);
  expect(log.buildContexts[1]).toMatchObject({
    offset: Buffer.byteLength(a),
    end: Buffer.byteLength(a + b),
    time: 2000,
    step: '构建',
  });
  await fs.appendFile(
    store.logPath('DC-context') + '.context.jsonl',
    JSON.stringify({ offset: 0, end: 1, time: '无效时间' }) + '\n',
  );
  expect(store.readLogs('DC-context', 'target').buildContexts.at(-1)?.time).toBeUndefined();
});
it('日志目录被联接到其他位置时拒绝读取和写入，外部文件保持原样', async () => {
  const base = path.resolve('.test-data');
  await fs.mkdir(base, { recursive: true });
  const dir = await fs.mkdtemp(path.join(base, 'log-link-'));
  const store = new Storage(dir, {
    encrypt: async (s) => Buffer.from(s),
    decrypt: async (b) => b.toString(),
  });
  roots.push({ dir, store });
  const outside = path.join(dir, 'outside');
  await fs.mkdir(outside);
  await fs.mkdir(path.join(dir, 'logs'));
  await fs.writeFile(path.join(outside, 'build.log'), 'keep');
  await fs.symlink(
    outside,
    path.join(dir, 'logs', 'DC-linked'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  expect(() => store.appendLog('DC-linked', 'unexpected')).toThrow('链接');
  expect(() => store.readLogs('DC-linked', 'target')).toThrow('链接');
  expect(await fs.readFile(path.join(outside, 'build.log'), 'utf8')).toBe('keep');
});

it('超过2MB的完整中文日志分批读取无缺行、重复或字节断裂', async () => {
  const base = path.resolve('.test-data');
  await fs.mkdir(base, { recursive: true });
  const dir = await fs.mkdtemp(path.join(base, 'log-paging-'));
  const store = new Storage(dir, {
    encrypt: async (s) => Buffer.from(s),
    decrypt: async (b) => b.toString(),
  });
  roots.push({ dir, store });
  const raw =
    Array.from(
      { length: 50000 },
      (_, i) => '中文构建日志内容 第' + i + '行 ' + 'x'.repeat(30),
    ).join('\n') + '\n';
  store.appendLog('DC-paging', raw);
  const tail = store.readLogs('DC-paging', 'target');
  expect(tail.truncated).toBe(true);
  const previous = store.readLogs('DC-paging', 'target', { build: tail.buildStart, target: 0 });
  expect(previous.buildStart).toBe(0);
  expect(previous.buildOffset).toBe(tail.buildStart);
  expect([...previous.build.slice(0, -1), ...tail.build].join('\n')).toBe(raw);
});
