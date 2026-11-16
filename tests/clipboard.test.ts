import { afterEach, expect, it, vi } from 'vitest';
import { copyText } from '../src/clipboard';
afterEach(() => {
  delete window.deployCenter;
  vi.unstubAllGlobals();
});
it('桌面复制只调用受限原生接口，不依赖浏览器权限且不触发下载', async () => {
  const write = vi.fn().mockResolvedValue(undefined),
    browser = vi.fn().mockRejectedValue(new Error('denied'));
  window.deployCenter = { copyText: write } as never;
  vi.stubGlobal('navigator', { clipboard: { writeText: browser } });
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click');
  await copyText('中文\n完整提交与日志');
  expect(write).toHaveBeenCalledWith('中文\n完整提交与日志');
  expect(browser).not.toHaveBeenCalled();
  expect(click).not.toHaveBeenCalled();
  click.mockRestore();
});
it('原生和浏览器复制失败只反馈失败，不创建文件', async () => {
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click');
  window.deployCenter = { copyText: vi.fn().mockRejectedValue(new Error('IPC failure')) } as never;
  await expect(copyText('指纹')).rejects.toThrow('复制失败');
  delete window.deployCenter;
  vi.stubGlobal('navigator', {
    clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
  });
  await expect(copyText('日志')).rejects.toThrow('复制失败');
  expect(click).not.toHaveBeenCalled();
  click.mockRestore();
});
it('浏览器原型在允许时仍可以正常复制文本', async () => {
  const write = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText: write } });
  await copyText('原型文本');
  expect(write).toHaveBeenCalledWith('原型文本');
});
