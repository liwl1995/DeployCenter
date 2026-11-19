export const onlineLogLimit = 2 * 1024 ** 2;
export const onlineLogSessionLimit = 3;
export const onlineLogDuration = 30 * 60;
export const onlineSearchLimit = 200;
export const onlineLargeLog = 100 * 1024 ** 2;

export type OnlineLogSource = {
  target: string;
  server: string;
  address: string;
  kind: 'docker' | 'file';
  location: string;
  production: boolean;
  password: boolean;
  key: boolean;
  credentialAvailable?: boolean;
  session?: string;
};

export type OnlineSearch = {
  query: string;
  regex: boolean;
  range: '1' | '4' | '8' | '24' | '168';
};

export type OnlineSearchResult = {
  scope: string;
  truncated: boolean;
  matches: { line: number; before: string[]; text: string; after: string[] }[];
};

export type OnlineDownload = { token: string; bytes: number; source: string };
export type OnlineSession = { id: string; target: string; server: string };
