export const stepNames: Record<string, string> = {
  local: '检查本机配置',
  environment: '检查本机构建环境',
  build: '构建部署文件',
  artifact: '校验部署文件',
  connect: '连接服务器',
  preflight: '检查服务器环境',
  mount: '检查容器挂载',
  upload: '上传文件',
  verify: '校验文件',
  permissions: '准备文件权限',
  backup: '备份旧版本',
  stop: '停止服务',
  replace: '替换文件',
  chmod: '设置执行权限',
  start: '启动服务',
  containerHash: '核对容器中的文件',
  stability: '检查容器运行状态',
  health: '检查应用是否可用',
  rollback: '恢复并检查旧版本',
};

export const deploymentStages = ['构建', '上传与校验', '备份', '切换', '检查'];

export function deploymentStage(key: string) {
  if (key === 'backup') return 2;
  if (['stop', 'replace', 'chmod', 'start', 'rollback'].includes(key)) return 3;
  if (['health', 'containerHash', 'stability'].includes(key)) return 4;
  return 1;
}
