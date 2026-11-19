export type ImageEngine = { kind: 'windows' | 'wsl'; distro?: string };
export type ImagePlatform = 'linux/amd64' | 'linux/arm64';
export type ImageBuild = {
  serviceId: string;
  engine: ImageEngine;
  mode: 'build' | 'existing';
  jarPath?: string;
  dockerfile: string;
  context: string;
  reference: string;
  platform: ImagePlatform;
};
export type ImageSource = { buildId: string } | { file: string };
export type ImagePackage = {
  name: string;
  path: string;
  size: number;
  hash: string;
  reference: string;
  platform: ImagePlatform;
  imageId: string;
  manifestIds?: string[];
};
export type ImageStage = {
  name: string;
  status: 'pending' | 'running' | 'success' | 'failed' | 'skipped';
  started?: number;
  finished?: number;
};
export type ImageJob = {
  id: string;
  name: string;
  kind: 'build' | 'import';
  status: 'running' | 'success' | 'failed' | 'interrupted' | 'cancelled';
  started: number;
  finished?: number;
  stages: ImageStage[];
  archive?: ImagePackage;
  message?: string;
  remoteFile?: string;
  remoteImageId?: string;
  server?: string;
  cancelling?: boolean;
  upload?: { bytes: number; size: number; speed: number };
};
export type ImageCheck = {
  archive: ImagePackage;
  server: string;
  remoteDirectory: string;
  uploadFile?: string;
  free: number;
  alreadyPresent: boolean;
};

export type ImageLogChunk = { offset: number; text: string; time: number; step: string };

export const imageIdentities = (archive: ImagePackage) => [
  archive.imageId,
  ...(archive.manifestIds || []),
];

export const imageSize = (bytes: number) =>
  bytes < 1024 * 1024 * 1024
    ? (bytes / (1024 * 1024)).toFixed(1) + ' MB'
    : (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
