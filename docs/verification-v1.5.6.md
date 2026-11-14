# v1.5.6 更新安装交接修复验收

日期：2026-11-14。

## 根因与修复

在本机复现了 Windows PowerShell 使用 `detached: true` 后未执行脚本、直接退出，移除 detached 又导致父进程退出后助手无法存活的问题。之前的夹具直接运行 PowerShell 脚本，没有覆盖真实启动函数的脱离进程选项及释放管道后的生存期。

改为独立 Windows .NET Framework 助手，随安装包分发（约 6.5 KB，内嵌 asInvoker 清单）。助手获取父进程句柄并通知就绪后应用才退出；等待父进程和同名子进程自然结束后，检查安装包非链接并复核 SHA-256，启动带原安装目录的交互式向导。不强杀进程，不静默安装。原任务、迁移与维护保护未修改。

`electron/update-installer.ts` 只传递编码参数、等就绪和记录失败，路径不经过 shell。Windows 构建用系统编译器生成 `dist-electron/update-helper.exe`；正式资源在 `resources/update-helper.exe`，不放进 ASAR。Windows 11 无需用户配置编译器或额外启动服务。

## 实际执行

- `npm run typecheck`：通过。
- `npm run build`：通过，实际编译独立助手。
- `npm test -- tests/update-handoff.test.ts tests/update-installer.test.ts tests/app-updater.test.ts --testTimeout=60000 --reporter=dot`：19 项通过。
- 设置 `DEPLOY_CENTER_TEST_WSL=Ubuntu-24.04` 及本机缓存的 `DEPLOY_CENTER_NSIS` 后，执行 `npm test -- --testTimeout=60000 --hookTimeout=30000 --reporter=json --outputFile=.test-data/v156-final-tests.json`：277 项通过、1 项跳过、0 失败。唯一跳过项为未配置专用非 22 端口 sshd 的真实 SSH 集成。
- `npm run dist -- --x64`：通过，实际生成 Windows x64 NSIS 安装包。
- 指定 `DEPLOY_CENTER_TEST_EXE=release/win-unpacked/YOTOO 部署中心.exe`，执行 `npm run test:smoke -- --reporter=line`：25 项通过。
- `node .test-data/verify-package.mjs`：主进程、预加载及渲染入口与构建一致；正式包资源助手 SHA-256 与构建助手一致。
- `git -c core.whitespace=cr-at-eol diff --check`：通过。

## 新增覆盖与边界

- 真实 Node、Electron 父进程均通过正式 TypeScript 启动函数交接：父进程存活时安装器不启动；释放管道并退出后，助手仍能启动无害安装脚本。安装器与安装目录包含中文、空格、单引号和美元符。
- 助手已就绪后再篡改安装包，父进程退出后会拒绝安装并记录 SHA-256 错误。该失败夹具只将中文弹窗替换成日志，避免无人值守测试阻塞；原校验逻辑实际执行。
- 测试助手只替换产品进程名，避免正式程序正在运行影响夹具；没有终止用户正式程序或修改正式数据。
- 单元覆盖：参数编码与校验、完整就绪信号才交接、未就绪即使退出码为 0 也保持应用运行、系统启动失败写入错误详情。
- 正式 Electron 包实测：资源助手与构建相同，无效参数在就绪前退出、不启动安装；原三种窗口尺寸及深浅主题桌面回归继续通过。
- 未对用户当前正式安装执行覆盖升级、卸载，也没有连接用户正式服务器。

旧版交接代码不会因下载新安装包而改变，本次需正常退出旧版后手动覆盖安装一次 1.5.6，后续更新使用新助手。源码、安装包和校验文件保存在源码的 `release` 目录。
