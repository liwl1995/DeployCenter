// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { windowsRoot } from '../electron/system-paths';
import { detectJdks } from '../electron/files';
let dir = '';
afterEach(async () => {
  vi.unstubAllEnvs();
  if (dir) {
    if (path.dirname(dir) !== path.resolve('.test-data')) throw new Error('测试范围越界');
    await fs.rm(dir, { recursive: true, force: true });
    dir = '';
  }
});
it('Windows 系统目录使用环境提供的位置，不猜 C 盘', () => {
  expect(windowsRoot({ SystemRoot: 'F:\\Windows' })).toBe('F:\\Windows');
  expect(windowsRoot({ windir: 'G:\\系统' })).toBe('G:\\系统');
  expect(() => windowsRoot({})).toThrow('SystemRoot');
  expect(() => windowsRoot({ SystemRoot: 'relative' })).toThrow('SystemRoot');
});
it('JDK 发现从 JAVA_HOME、用户配置和 PATH 定位，不依赖开发机专用目录', async () => {
  const base = path.resolve('.test-data');
  await fs.mkdir(base, { recursive: true });
  dir = await fs.mkdtemp(path.join(base, 'jdk-paths-'));
  for (const root of ['Java Home 中文', 'path-jdk']) {
    await fs.mkdir(path.join(dir, root, 'bin'), { recursive: true });
    await fs.writeFile(path.join(dir, root, 'release'), 'JAVA_VERSION="21.0.1"');
    await fs.writeFile(path.join(dir, root, 'bin', 'javac.exe'), 'fixture');
  }
  vi.stubEnv('JAVA_HOME', path.join(dir, 'Java Home 中文'));
  vi.stubEnv('ProgramFiles', path.join(dir, 'programs'));
  vi.stubEnv('USERPROFILE', path.join(dir, 'profile'));
  vi.stubEnv('PATH', path.join(dir, 'path-jdk', 'bin'));
  const found = await detectJdks();
  expect(found.map((j) => j.path).sort()).toEqual(
    [path.join(dir, 'Java Home 中文'), path.join(dir, 'path-jdk')].sort(),
  );
});
