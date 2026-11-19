// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { backgroundUpdates } from '../electron/background-updates';
import { DesktopPreferenceStore, fitWindow, preferencesSchema } from '../electron/desktop-preferences';
import { panelBounds } from '../electron/tray-panel';
import { desktopPreferenceDefaults } from '../src/desktop-preferences';
import type { AppUpdate } from '../src/app-update';

vi.mock('electron', () => ({ BrowserWindow: {}, ipcMain: {}, screen: {}, Tray: {} }));

afterEach(() => vi.useRealTimers());

it('本机偏好按数据目录保存，关闭记忆后不再恢复旧窗口', () => {
  const base = path.resolve('.test-data');
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(path.join(base, 'desktop-preferences-'));
  try {
    const first = new DesktopPreferenceStore(dir);
    expect(first.preferences).toEqual(desktopPreferenceDefaults);
    const window = { x: -987, y: 60, width: 1000, height: 620, maximized: true };
    const preferences = { ...first.preferences, zoom: 125 as const, closeToTray: true, followLogs: false };
    first.save(preferences, window);
    const reopened = new DesktopPreferenceStore(dir);
    expect(reopened.preferences).toEqual(preferences);
    expect(reopened.window).toEqual(window);
    reopened.save({ ...preferences, rememberWindow: false });
    expect(new DesktopPreferenceStore(dir).window).toBeUndefined();
    expect(preferencesSchema.partial().safeParse({ zoom: 150 }).success).toBe(false);
  } finally {
    if (path.dirname(dir) === base) rmSync(dir, { recursive: true, force: true });
  }
});

it('恢复到可用显示器，托盘面板约束在负坐标显示器的工作区内', () => {
  const area = { x: -1280, y: 40, width: 1280, height: 800 };
  expect(fitWindow({ x: 5000, y: -600, width: 1500, height: 920 }, area)).toEqual(area);
  expect(panelBounds({ x: -80, y: 850, width: 30, height: 30 }, area))
    .toEqual({ x: -374, y: 466, width: 324, height: 374 });
  expect(panelBounds({ x: -1300, y: 0, width: 30, height: 40 }, area))
    .toEqual({ x: -1280, y: 40, width: 324, height: 374 });
});

it('后台检查等待一分钟，间隔六小时，并根据当前偏好下载', async () => {
  vi.useFakeTimers();
  const update: AppUpdate = { currentVersion: '2.1.0', stage: 'available', received: 0, speed: 0 };
  const server = {
    isBusy: vi.fn().mockReturnValue(false),
    check: vi.fn().mockResolvedValue(update),
    download: vi.fn().mockResolvedValue({ ...update, stage: 'ready' }),
  };
  const policy = backgroundUpdates(server, vi.fn());
  await vi.advanceTimersByTimeAsync(60_000);
  expect(server.check).not.toHaveBeenCalled();
  policy('check');
  await vi.advanceTimersByTimeAsync(59_999);
  expect(server.check).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(server.check).toHaveBeenCalledTimes(1);
  expect(server.download).not.toHaveBeenCalled();
  server.isBusy.mockReturnValueOnce(true);
  await vi.advanceTimersByTimeAsync(6 * 3600_000);
  expect(server.check).toHaveBeenCalledTimes(1);
  policy('download');
  await vi.advanceTimersByTimeAsync(60_000);
  expect(server.download).toHaveBeenCalledTimes(1);
  policy('manual');
  await vi.advanceTimersByTimeAsync(6 * 3600_000);
  expect(server.check).toHaveBeenCalledTimes(2);
});

it('关闭后台检查后，正在返回的检查结果不会触发新下载', async () => {
  vi.useFakeTimers();
  let finish!: (result: AppUpdate) => void;
  const server = {
    isBusy: () => false,
    check: () => new Promise<AppUpdate>((resolve) => { finish = resolve; }),
    download: vi.fn(),
  };
  const policy = backgroundUpdates(server, vi.fn());
  policy('download');
  await vi.advanceTimersByTimeAsync(60_000);
  policy('manual');
  finish({ currentVersion: '2.1.0', stage: 'available', received: 0, speed: 0 });
  await vi.advanceTimersByTimeAsync(6 * 3600_000);
  expect(server.download).not.toHaveBeenCalled();
});
