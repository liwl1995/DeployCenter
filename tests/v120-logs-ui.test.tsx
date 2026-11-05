import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LogAccumulator, logLevel, type LogLine } from '../src/log-model';
import { VirtualLogs } from '../src/LogViewer';
afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
});
it('分片和重叠实时数据只合并一次，中文字节偏移与旧行引用保持稳定', () => {
  const c = new LogAccumulator();
  c.append('build', '中', 0, { time: 1, step: '构建' });
  const old = c.entries[0];
  c.append('build', '中文\n', 0, { time: 2, step: '构建' });
  expect(c.entries.map((l) => l.text)).toEqual(['中文']);
  expect(old.text).toBe('中');
  c.append('build', '[ERROR] 失败\n', 7, { time: 3, step: '检查' });
  expect(c.entries).toHaveLength(2);
  expect(c.entries[1]).toMatchObject({ id: 'build:7', time: 3 });
  expect(logLevel('[WARNING] test')).toBe('warning');
  expect(logLevel('普通信息')).toBe('info');
  expect(logLevel('[ERROR] 失败')).toBe('error');
});
it('上万行只渲染可见窗口，搜索可跳转，错误和警告有文字标记', async () => {
  const user = userEvent.setup(),
    lines: LogLine[] = Array.from({ length: 12000 }, (_, i) => ({
      id: String(i),
      text: i === 4321 ? '[ERROR] 唯一错误' : i === 7000 ? '[WARNING] 警告信息' : '普通信息 ' + i,
      step: '构建产物',
      time: 1000 + i,
    }));
  const { container } = render(<VirtualLogs entries={lines} />);
  expect(container.querySelectorAll('[data-log-line]').length).toBeLessThan(50);
  await user.type(screen.getByRole('textbox', { name: '搜索日志' }), '唯一错误');
  expect(screen.getByRole('status').textContent).toContain('1 处命中');
  await user.click(screen.getByRole('button', { name: '下一处' }));
  expect(screen.getByText('[ERROR] 唯一错误')).toBeTruthy();
  expect(screen.getAllByText('错误').length).toBeGreaterThan(0);
  await user.selectOptions(screen.getByRole('combobox', { name: '日志级别' }), 'warning');
  expect(container.querySelectorAll('[data-log-line]').length).toBe(2);
  expect(screen.getByText('警告')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: '收起 · 构建产物' }));
  expect(container.querySelectorAll('[data-log-line]').length).toBe(0);
});
it('选择日志文字时保留原节点和文字，清除选择后再展示新行，缺失时间不伪造', () => {
  const first: LogLine[] = [{ id: 'one', text: '可复制的原始日志' }];
  const { rerender } = render(<VirtualLogs entries={first} />);
  const node = screen.getByText('可复制的原始日志'),
    range = document.createRange();
  range.selectNodeContents(node);
  window.getSelection()?.addRange(range);
  fireEvent(document, new Event('selectionchange'));
  rerender(<VirtualLogs entries={[...first, { id: 'two', text: '后来的日志' }]} />);
  expect(screen.getByText('可复制的原始日志')).toBe(node);
  expect(window.getSelection()?.toString()).toBe('可复制的原始日志');
  expect(screen.queryByText('后来的日志')).toBeNull();
  window.getSelection()?.removeAllRanges();
  fireEvent(document, new Event('selectionchange'));
  expect(screen.getByText('后来的日志')).toBeTruthy();
  expect(screen.getAllByText('时间未记录')).toHaveLength(2);
});

it('隐藏日志页签不计算滚动位置，恢复后跟随最新；暂停跟随则保留查看位置', () => {
  const lines: LogLine[] = Array.from({ length: 100 }, (_, i) => ({
    id: String(i),
    text: '日志' + i,
    step: '构建',
  }));
  const { container, rerender } = render(<VirtualLogs entries={lines} />);
  const viewport = container.querySelector<HTMLElement>('.log-viewport')!;
  let position = viewport.scrollTop,
    writes = 0;
  Object.defineProperty(viewport, 'scrollTop', {
    configurable: true,
    get: () => position,
    set: (value: number) => {
      position = value;
      writes++;
    },
  });
  Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 102 * 28 });
  Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 420 });
  const more = [...lines, { id: 'new', text: '新增日志', step: '构建' }];
  rerender(<VirtualLogs active={false} entries={more} />);
  expect(writes).toBe(0);
  rerender(<VirtualLogs active={true} entries={more} />);
  expect(position).toBe(102 * 28 - 420);
  viewport.scrollTop = 112;
  fireEvent.scroll(viewport);
  expect((screen.getByLabelText('跟随最新') as HTMLInputElement).checked).toBe(false);
  const later = [...more, { id: 'later', text: '更多日志', step: '构建' }];
  writes = 0;
  rerender(<VirtualLogs active={false} entries={later} />);
  expect(writes).toBe(0);
  rerender(<VirtualLogs active={true} entries={later} />);
  expect(position).toBe(112);
});
