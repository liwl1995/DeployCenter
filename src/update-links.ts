/** 远端更新说明的链接仅允许本项目的 HTTPS 页面，禁止协议处理器和其他站点。 */
export function allowedProjectLink(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      !url.username &&
      !url.password &&
      !url.port &&
      (url.pathname === '/liwl1995/DeployCenter' ||
        url.pathname.startsWith('/liwl1995/DeployCenter/'))
    );
  } catch {
    return false;
  }
}
