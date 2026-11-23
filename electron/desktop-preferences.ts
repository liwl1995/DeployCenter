import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Rectangle } from 'electron';
import { z } from 'zod';
import { desktopPreferenceDefaults, type DesktopPreferences } from '../src/desktop-preferences';
import { plainPath } from './managed-path';

export const preferencesSchema = z.object({
  zoom: z.union([z.literal(90), z.literal(100), z.literal(110), z.literal(125)]),
  rememberWindow: z.boolean(),
  followLogs: z.boolean(),
  wrapLogs: z.boolean(),
  launchAtLogin: z.boolean(),
  closeToTray: z.boolean(),
  updatePolicy: z.enum(['manual', 'check', 'download']),
  checkUpdatesOnStartup: z.boolean(),
  tutorialInstallId: z.string().regex(/^\d{12,20}-\d{1,10}$/).optional(),
  sortSidebarByDeployment: z.boolean(),
  sidebarServiceOrder: z.array(z.string()),
});
const windowSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().min(900).max(32768),
  height: z.number().int().min(600).max(32768),
  maximized: z.boolean(),
});
type SavedWindow = z.infer<typeof windowSchema>;

export class DesktopPreferenceStore {
  preferences: DesktopPreferences = { ...desktopPreferenceDefaults };
  window?: SavedWindow;
  private readonly file: string;

  constructor(directory: string) {
    this.file = path.join(directory, 'desktop-preferences.json');
    try {
      const saved = JSON.parse(readFileSync(plainPath(this.file), 'utf8'));
      this.preferences = { ...desktopPreferenceDefaults, ...preferencesSchema.partial().parse(saved.preferences) };
      this.window = windowSchema.safeParse(saved.window).data;
    } catch {
      // 无有效偏好时使用默认值，配置导入与 SQLite 不接触此文件。
    }
  }

  save(preferences: DesktopPreferences, window = this.window) {
    const destination = plainPath(this.file);
    const temporary = plainPath(destination + '.next');
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(temporary, JSON.stringify({
      preferences,
      window: preferences.rememberWindow ? window : undefined,
    }), { mode: 0o600 });
    renameSync(temporary, destination);
    this.preferences = preferences;
    this.window = preferences.rememberWindow ? window : undefined;
  }
}

export function fitWindow(saved: Rectangle, area: Rectangle): Rectangle {
  const width = Math.max(900, Math.min(saved.width, area.width));
  const height = Math.max(600, Math.min(saved.height, area.height));
  return {
    width,
    height,
    x: Math.max(area.x, Math.min(saved.x, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(saved.y, area.y + area.height - height)),
  };
}
