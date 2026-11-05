import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  deploymentBlockReason,
  HashValue,
  PrecheckPanel,
  VersionFacts,
} from '../src/DeployDetails';
import type { LocalPrecheck } from '../src/features';
afterEach(cleanup);
it('预检清单展示真实三态，部署不可用只选择最优先的一条原因', () => {
  const check: LocalPrecheck = {
    checkedAt: new Date().toISOString(),
    items: [
      { key: 'jdk', label: '构建 JDK', state: 'fail', blocking: true, reason: 'JDK 不可用' },
      { key: 'tool', label: '构建工具', state: 'unchecked', blocking: true, reason: '先配置 JDK' },
      { key: 'lock', label: '远端锁', state: 'unchecked', blocking: false, reason: '试运行后检查' },
    ],
  };
  expect(deploymentBlockReason(check, false, 0)).toContain('选择部署目标');
  expect(deploymentBlockReason(check, false, 1)).toBe('JDK 不可用');
  expect(deploymentBlockReason(null, true, 1)).toContain('正在检查');
  render(<PrecheckPanel check={check} pending={false} />);
  expect(screen.getByText('未通过')).toBeTruthy();
  expect(screen.getAllByText('未检查')).toHaveLength(2);
  expect(screen.getByText('试运行后检查')).toBeTruthy();
});
it('所有指纹只显示七位、悬停保留完整值、复制完整值；未知 Git 不冒充提交', async () => {
  const copy = vi.fn(),
    user = userEvent.setup(),
    hash = 'a'.repeat(64);
  render(
    <>
      <HashValue label="Git 提交" value={'b'.repeat(40)} onCopy={copy} />
      <VersionFacts target={{ version: hash.slice(0, 12), currentHash: hash }} onCopy={copy} />
    </>,
  );
  expect(screen.getByText('aaaaaaa').getAttribute('title')).toBe(hash);
  expect(screen.queryByText(hash)).toBeNull();
  expect(screen.getAllByText('Git 提交')).toHaveLength(1);
  await user.click(screen.getByRole('button', { name: '复制JAR 指纹' }));
  expect(copy).toHaveBeenCalledWith(hash);
});
