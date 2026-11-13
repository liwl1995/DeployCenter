# v1.5.2 验收记录

日期：2026-11-13。所有任务、凭据、数据迁移及更新测试使用隔离数据目录；未修改用户正式数据，未连接用户真实部署服务器。

## 实际执行

- `npm run typecheck`：通过。
- `npm run build`：通过，生成渲染界面与 Electron 主进程、预加载和工作进程。
- `DEPLOY_CENTER_TEST_WSL=Ubuntu-24.04 npm test -- --testTimeout=60000 --hookTimeout=30000 --reporter=json --outputFile=.test-data/v152-final-tests.json`（PowerShell 中通过环境变量设置）：254 项通过、1 项跳过。唯一跳过项是未配置专用非 22 端口 sshd 的真实 SSH 集成；包括隔离 Linux 脚本测试。
- 最后补齐等待 Electron 子进程退出逻辑后，执行 `npm test -- tests/update-handoff.test.ts tests/app-updater.test.ts tests/app-update-ui.test.tsx --testTimeout=60000 --reporter=dot`：17 项通过。
- `DEPLOY_CENTER_TEST_EXE=release/win-unpacked/YOTOO 部署中心.exe npm run test:smoke -- --reporter=line`（PowerShell 环境变量）：22 项通过，使用打包程序，不是浏览器静态页。
- 隔离 Electron 实际调用公开 GitHub 版本接口成功，查询时线上最新正式版本为 1.5.1，本地 1.5.2 不会降级。
- `git -c core.whitespace=cr-at-eol diff --check`：通过，保留原有 CRLF 文件格式。

## 更新与界面覆盖

- 正式版本数值比较、降级和预发布拒绝、错误资产/校验信息拒绝、HTTPS 重定向来源限制、离线和限流提示。
- 下载大小及 SHA-256 校验、进度事件、取消与重试、半成品清理、缓存目录链接拒绝、过期缓存不误删未知文件。
- 安装前重新校验文件及业务状态、助手启动失败保留应用、运行/中断任务禁止安装。
- 使用真实 Windows PowerShell 运行助手：父进程存活时不启动，正常退出后才启动无害 `.cmd` 测试脚本；测试不执行真实安装包。
- 打包程序中直接调用安装接口时，隔离数据库的未核实任务触发后端拒绝，确认不会启动夹具安装包。
- 1000×620、1280×800、1600×900 下测量页面横向边界、固定页脚、更新确认弹窗及纵向帮助入口；生成截图。更新页深浅主题均实际渲染检查。
- 自定义页面切换和确认快捷键已删除；Tab 焦点及 Esc 关闭最上层弹窗保留。

## 验证边界

未在用户当前安装上实际执行覆盖升级或卸载；没有把模拟安装包当成真实程序安装。真实 GitHub 安装包的大文件下载及完整 NSIS 更新安装尚未端到端验证，下载逻辑使用受控 HTTP 响应覆盖，安装交接使用真实 Windows 进程及无害脚本验证。程序未配置 Windows 代码签名证书，SHA-256 校验验证的是已发布资产的内容一致性。最终安装包、源码包大小与 SHA-256 见 `release/YOTOO部署中心-1.5.2-verification.json`。
