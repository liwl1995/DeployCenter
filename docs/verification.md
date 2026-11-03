# 本次实际验收记录

验收日期：2026-11-03。项目为 YOTOO 部署中心 1.0.0，Windows 11 x64。本文只列实际执行过的检查；原型时期的说明另见 prototype-v03.md。

## 源码检查和构建

| 命令 | 实际结果 |
|---|---|
| npm run typecheck | 通过，退出码 0（React 与 Electron 两套 TypeScript 配置） |
| npm test | 79 项通过、9 项跳过，共 88 项；9 个文件通过、2 个文件跳过 |
| npm run build | 通过，退出码 0，生成 dist 与 dist-electron |
| npm run test:smoke（DEPLOY_CENTER_TEST_EXE 指向 release/win-unpacked/YOTOO 部署中心.exe） | 4 项通过，实际运行打包后的 Electron 程序 |
| npx electron-builder --win nsis --prepackaged release/win-unpacked | 通过，生成中文 NSIS 安装包；最终一次只修改安装向导品牌资源，沿用同一应用内容 |
| npm run rebuild:native | 失败：本机缺 Visual Studio C++ Build Tools。没有声称源码重编译成功 |

better-sqlite3 使用 npm 依赖随附的官方 Windows x64 N-API 预编译模块。打包程序中实际验证了 SQLite 读写和 Windows DPAPI 加密往返。asarUnpack 保留原生模块目录。Electron 45.2.1 / Node 24.22.1。未配置代码签名证书，安装包及应用未签名。

79 项通过的测试包括原型回归、真实本地文件/JAR/进程/SQLite、确认快照与 IPC 边界、服务删除关联、日志流跨块脱敏、仅监听 127.0.0.1 随机端口的真实 SSH2/SFTP 协议测试。测试不连接业务服务器。

9 项跳过：8 项 Linux Bash 流程测试（本机 Git Bash 的 mkdir -m 700 被 ACL 拒绝）；1 项系统 sshd 集成（未提供回环地址、非 22 端口、测试私钥及指纹）。没有为通过测试降低生产脚本权限要求。

## 安装体验

最终安装器欢迎页已实际打开检查：名称为 YOTOO 部署中心；文字使用原生字体控件；图标按 DPI 选择多尺寸方形 ICO，侧栏纯色背景可铺满，图标本身不随侧栏拉伸。安装侧栏使用与背景合成的图标，消除透明圆角的白块。此次肉眼检查在当前 100% Windows 显示比例进行，未切换系统全局缩放设置。

脚本 scripts/test-installer.ps1 的机器可读报告随交付提供，含最终安装包 SHA-256。验收使用任务工作区内含中文和空格的专用目录；开始前拒绝已有正式安装或用户数据。卸载彻底清理仅针对本脚本创建且持有所有权标记的夹具。

## 尚未覆盖的运行场景

- 未连接用户的业务服务器，未执行业务 Maven 构建或真实 Docker 部署。
- 远端 Bash 的完整停服、原子替换、回滚、锁接管和断线恢复仍需在专用 Linux/Docker 环境验收；本机协议、单元及 UI 测试不能代替这些检查。
- 不保证应用层任意启动命令的幂等性，正式使用前需按目标服务核对命令、权限、健康检查与备份目录。
- 安装失败恢复已有实现，但未注入断电、磁盘损坏或强制崩溃来验证所有恢复分支。
- 安装器 DPI 自适应已有实现；本次未逐一实测不同显示器间移动或系统 125%/150%/200% 的安装向导表现。

## 最终安装包的实测结果

执行命令（在项目目录中）：

```powershell
& scripts/test-installer.ps1 -Installer './release/YOTOO部署中心-1.0.0-x64-安装包.exe' -OlderInstaller './.test-data/upgrade-fixture/DeployCenter-0.9.0-x64-setup.exe' -RunDesktopSmoke
```

结果：脚本退出码 0，报告中 **21 个检查全部通过**。包括中文空格目录、Windows 注册、开始菜单和桌面入口、实际启动 SQLite/DPAPI、运行中拒绝安装且不杀应用、0.9.0 至 1.0.0 覆盖升级、中文改名与清除旧入口、真实服务配置保留、默认卸载保留数据、重装和可选彻底清理。升级夹具是本机生成的旧版安装包，不代表已发布历史版本。

脚本还设置 DEPLOY_CENTER_TEST_EXE 为安装目录中的 YOTOO 部署中心.exe、DEPLOY_CENTER_TEST_SCALE=1.5，实际执行 npm run test:smoke：**4 项通过**。覆盖首次空配置与沙箱、通过界面保存服务后重启恢复、受控文件/任务 IPC、utilityProcess 的真实回环 SSH 只读试运行与首次指纹确认。该项为应用进程 150% 缩放测试，不是更改 Windows 全局缩放或安装器多显示器测试。

最终安装包 SHA-256：892829f4e9cb81b074dcde3df3d5103b4d7f8bcf9a517c3af6ac879317669c01。

交付的 installer-verification.json 对应同一哈希；安装器文件名为 YOTOO部署中心-1.0.0-x64-安装包.exe。源码包脚本另外验证压缩文件 CRC 及每个收录文件的 SHA-256。
