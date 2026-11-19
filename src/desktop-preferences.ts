export type UpdatePolicy = 'manual' | 'check' | 'download';
export const zoomOptions = [90, 100, 110, 125] as const;
export type DesktopPreferences = {
  zoom: (typeof zoomOptions)[number];
  rememberWindow: boolean;
  followLogs: boolean;
  launchAtLogin: boolean;
  closeToTray: boolean;
  updatePolicy: UpdatePolicy;
};

export const desktopPreferenceDefaults: DesktopPreferences = {
  zoom: 100,
  rememberWindow: true,
  followLogs: true,
  launchAtLogin: false,
  closeToTray: false,
  updatePolicy: 'manual',
};
