# v1.5.4 更新下载修复验收

日期：2026-11-13。只调整应用更新的原生网络适配及测试，不修改部署引擎、SSH、凭据、数据库结构、锁、回滚和安装保护。

## 根因与修复

在实际 Electron 45.2.1 中请求公开 GitHub 安装包并设置 `redirect: manual`，复现 `Error: Redirect was cancelled`。此前模拟 Fetch Response 未覆盖 Electron 的原生重定向事件。现在用 `net.request` 取得 3xx，将下一跳交回现有更新器检查 HTTPS、域名和路径后再请求，不自动跟随未知地址。响应以流式方式读取，保留背压、取消、超时、大小与 SHA-256 校验。

## 实际执行

- `npm run typecheck`：通过。
- `npm run build`：通过。
- `npm run dist -- --x64`：通过，生成最终 Windows x64 NSIS 安装包。
- 设置 `DEPLOY_CENTER_TEST_WSL=Ubuntu-24.04`，执行 `npm test -- --testTimeout=60000 --hookTimeout=30000 --reporter=json --outputFile=.test-data/v154-tests.json`：268 项通过、1 项跳过（未配置专用非 22 端口 sshd）。随后补齐错误资源释放后再次运行更新相关测试，20 项通过。
- 更新适配器覆盖原生 redirect 事件、正常流式响应、取消、异常中断、背压、写端提前关闭和空响应；原有更新器测试继续检查版本、来源、摘要和安装阻断。
- 桌面更新用例通过真实 Electron `net.request` 访问本机 HTTP 夹具，产生实际 302 与三段响应。验证不可信跳转在请求目标前被拒绝、看到部分文件进度后取消、重试成功、SHA-256 校验、确认安装及未核实任务阻断；不执行夹具安装包。
- 设置 `DEPLOY_CENTER_TEST_EXE` 指向打包后的程序，最终执行 `npm run test:smoke -- --reporter=line`：23 项全部通过。保留三个窗口尺寸和深浅主题检查。
- 期间一轮 Windows Playwright 工作进程在保存重启用例异常退出（3221226505）；未改产品保存逻辑及断言，专项复核通过，最终全量重跑通过。该次宿主退出根因未定位，未复现为应用更新故障。
- `node .test-data/verify-package.mjs`：打包的主进程、预加载与渲染入口匹配最终构建。
- `git -c core.whitespace=cr-at-eol diff --check`：通过。

## 真实 GitHub 下载

隔离验收将客户端版本设为 1.5.2，使用修复后的同一更新模块读取真实 GitHub 发布信息，完整下载已发布的 1.5.3 安装包。

- 请求经过 `api.github.com`、`github.com`、`release-assets.githubusercontent.com`。
- 完成状态为 `ready`。
- 大小：117024595 字节。
- SHA-256：`89472725be125f4827179a6a25bd3200dd4e8257647310f07b161d412973ee81`，独立读取下载文件并与发布附件记录核对一致。
- 未调用安装接口，未启动下载的安装包；缓存放在隔离测试目录，验证后清理。结果另存 `release/YOTOO部署中心-1.5.4-real-download.json`。

## 交付与边界

旧版下载器本身存在问题，需要先手动覆盖安装一次本版。安装包和源码包、SHA-256 位于源码目录的 `release` 下。未在用户正式安装上实际执行覆盖升级或卸载，未连接用户部署服务器；下载到校验通过的真实网络链路已验证。
