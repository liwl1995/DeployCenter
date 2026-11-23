export type UpdatePolicy = 'manual' | 'check' | 'download';
export const zoomOptions = [90, 100, 110, 125] as const;
export type DesktopPreferences = {
  zoom: (typeof zoomOptions)[number];
  rememberWindow: boolean;
  followLogs: boolean;
  wrapLogs: boolean;
  launchAtLogin: boolean;
  closeToTray: boolean;
  updatePolicy: UpdatePolicy;
  checkUpdatesOnStartup: boolean;
  tutorialInstallId?: string;
  sortSidebarByDeployment: boolean;
  sidebarServiceOrder: string[];
};

export const desktopPreferenceDefaults: DesktopPreferences = {
  zoom: 100,
  rememberWindow: true,
  followLogs: true,
  wrapLogs: false,
  launchAtLogin: false,
  closeToTray: false,
  updatePolicy: 'manual',
  checkUpdatesOnStartup: false,
  sortSidebarByDeployment: false,
  sidebarServiceOrder: [],
};
