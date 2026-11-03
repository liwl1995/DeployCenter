# YOTOO 部署中心 Windows 桌面工具

源码位于 `E:\projects\DeployCenter`。仅面向 Windows 11 x64，提供普通用户 NSIS 安装版，不提供便携版。桌面工具已接入真实文件、构建、SSH 与部署能力，请先在专用测试环境执行「试运行」，确认配置后再部署。

## 安装与启动

运行 `YOTOO部署中心-1.0.0-x64-安装包.exe`，按中文向导选择目录和桌面快捷方式。开始菜单入口始终创建，完成页可选择立即运行。默认安装到当前用户的 Programs 目录；其他目录必须具备写入权限和足够空间，不自动请求管理员权限。

正常使用不需要安装 Node.js、数据库服务，也不需要另开前端或后端。图标、界面、帮助和依赖随安装包提供。只有实际构建时才需要在应用里配置外部 JDK、Wrapper/Maven；部署时需要访问目标服务器。Maven 首次下载依赖可能需要网络。

安装器拒绝覆盖正在运行的应用，不会强杀部署任务。请在应用内等待任务结束或请求安全取消，再正常退出。升级识别固定应用 ID，沿用原安装目录，不生成重复安装项。升级前备份旧程序，失败时尝试恢复；恢复备份和失败日志位于 `%LOCALAPPDATA%\DeployCenter`。

默认卸载保留用户数据。卸载向导的可选组件可彻底清理配置、部署历史、凭据与日志，默认不勾选，并有二次确认。升级流程始终保留数据。

## 数据与权限

| 内容 | 位置 |
|---|---|
| 正式配置与历史 | `%APPDATA%\DeployCenter\deploy-center.sqlite` |
| 开发数据 | `%APPDATA%\DeployCenter-Development` |
| 完整日志 | 数据目录下 `logs\<taskId>\build.log`、`<targetId>.log` |
| 产物快照 | 数据目录下 `artifacts\<taskId>` |
| 构建临时文件 | 数据目录下 `tmp` |
| 迁移前备份 | 数据目录下 `backups` |
| 安装日志 | `%LOCALAPPDATA%\DeployCenter\InstallerLogs` |

应用默认普通用户运行，安装位置与用户数据独立。更新、覆盖安装与默认卸载不会清空配置。数据库带版本号，迁移前备份、事务内迁移；未知新版本拒绝打开，损坏配置保留原文，确认之前不覆盖。

首次启动为空配置，不内置演示服务器、模拟历史或故障注入。`src/demo.ts` 是测试夹具；Vite 正式构建将其替换为空配置。生产构建只认 `src/` 和 `electron/` 源码，`dist/` 与 `dist-electron/` 由构建生成。

## 配置与认证

依次配置服务、JDK、服务器和目标，再执行只读试运行。试运行检查本地环境、连接、目录权限、空间及 Docker 挂载，不上传、不创建远端目录或任务锁、不停止服务。

SSH Config 别名由系统 `ssh.exe` 处理，保留 ProxyJump、Agent、IdentityFile 等能力，固定 BatchMode、超时、keepalive 与严格 known_hosts。使用 `ssh -G` 解析并显示最终地址，不自己解析 SSH Config。别名首次使用须先通过本机 OpenSSH 核对并建立 known_hosts 信任。密码认证请选密码方式。

密码与私钥模式使用 SSH2 和 SFTP。首次连接显示 SHA-256 主机指纹；已有指纹变化直接阻止，不提供忽略入口。

凭据可选「每次部署时询问」或「使用 Windows 加密保存到本机」。后者使用 Electron safeStorage / DPAPI，密文保存在本机，不是 Windows 凭据管理器。加密不可用时不能保存。口令不进入配置导出；引擎日志与错误做脱敏，任务结束清除内存引用。没有启用远程崩溃报告上传。

配置导入先检查 schema、字段和引用关系，展示路径及命令供确认，再按实体 ID 合并；导入前备份数据库。原型配置只导入配置，不导入模拟历史。DPAPI 凭据不导出，也不能保证跨 Windows 用户或机器解密。

## 构建和部署规则

- 自动选择 `mvnw.cmd`、`mvnw`、本地 Maven；显式 Wrapper 缺失时拒绝回退。JDK 未配置或验证失败阻止重新构建。
- JAVA_HOME 与 PATH 仅注入单次构建进程。`.cmd` 经受控 cmd 启动，支持中文和空格路径；构建日志支持 UTF-8 与 GBK/GB18030。
- Maven 非零退出兼容默认开启，只有成功标记、有效 JAR、修改时间晚于本次构建开始全部满足才接受。正式上传前完整读取 ZIP 条目，检查 Manifest、CRC 和 SHA-256。
- 每个任务只构建一次，按目标顺序执行；失败停止/继续是本次任务快照。先上传任务专属临时文件并校验，再备份、停服、同目录原子替换、启动和检查。
- 普通 JAR 支持 chmod、停止失败视为警告；首次部署无旧文件跳过备份。Docker 两种绑定都在停容器后替换，启动后用 docker exec 检查容器内 SHA-256，并观察重启次数、运行及 Docker Healthcheck；容器缺少哈希工具会明确失败。
- HTTP/TCP 可选择从本机或通过 SSH 在服务器检查；自定义命令在服务器执行。均支持超时、重试与间隔；未配置时标记未验证。
- 构建取消结束进程树并等待退出；停服前尽快取消并清理。切换期间等待当前目标检查或回滚，不强杀远端 runner。
- 正式目标部署、手动回滚必须输入 DEPLOY；目录创建默认关闭；弱校验必须目标配置与本次确认都允许。

## 回滚、中断与互斥

备份由真实远程结果决定，保存大小、哈希和旧版本。新版本失败且有效备份存在时，可按目标策略自动恢复。手动历史回滚再次检查远程备份，不重新构建，默认先保护当前版本，并生成独立任务。

目标目录的 `.deploy-center.lock` 保存任务 ID 和服务器时间。已有锁拒绝部署。超过配置阈值后，用户确认原任务已停止并输入 TAKEOVER，且远端进程不再存活，才允许归档旧锁。

应用单实例。异常退出后运行中任务改为已中断、远端状态未知，不自动继续。可核实原任务状态或清理尚未启动的上传；不会重新上传、替换或继续后续目标。界面提供含登录方式的诊断命令和容器日志。

历史可按条数和天数清理，同时清理不再引用的本机日志、产物和任务。中断任务保留，远程备份不会被保留策略删除。

## 开发与构建

```powershell
npm ci
npm run typecheck
npm test
npm run build
npm run test:smoke
npm start
npm run rebuild:native
npm run dist
```

`npm run dist` 生成 NSIS 安装包。`installer/custom.nsh` 定义中文向导、路径/空间检查、快捷方式、运行保护、升级恢复与可选数据清理。`scripts/generate-icon.py` 生成 SVG 母版对应的多尺寸图标与安装品牌图形（需 Python + Pillow）。

SQLite 使用 better-sqlite3，asarUnpack 解包原生模块。`@electron/rebuild` 从源码重编译需要 Visual Studio C++ Build Tools。本次环境缺少该工具链，重编译尝试失败；当前运行测试使用依赖自带的官方 N-API 预编译模块，已在 Electron 中实际加载。不能把预编译模块可用称为源码编译成功。

## 测试与验收边界

实际执行记录见 `docs/verification.md`。没有连接业务服务器，没有构建业务项目，没有执行真实 Docker 部署。

- 假能力测试不调用文件、进程或网络；原生测试仅操作 `.test-data` 下临时文件和测试进程。
- 临时 SSH2 测试服务器只监听 127.0.0.1 随机端口，验证真实指纹、认证、命令和 SFTP。
- 系统 sshd 集成只有显式提供回环地址、非 22 端口、测试私钥和预期指纹时才运行；未配置时明确 SKIP。
- Linux Bash 流程测试保留。当前 Windows Git Bash 无法设置测试目录 POSIX 权限，因此跳过，未降低生产脚本权限要求。
- 上线前仍需专用 Linux/Docker 环境验收完整部署、回滚及断线恢复。原型 v0.3 说明保留于 `docs/prototype-v03.md`。

## v1.0 桌面实现与交付

保留原型 v0.3 的交互与回归测试，生产路径改为 Electron 主进程、受控 preload 与 utilityProcess 引擎。真实执行代码位于 `electron/`；React 仍在 `src/`。旧原型说明（包括逐项 v0.3 变更）保留在 `docs/prototype-v03.md`，不把其中的模拟执行说明当作桌面版能力。

应用和中文安装器统一使用「YOTOO 部署中心」，图标资源在 `assets/`，安装品牌原生控件在 `installer/custom.nsh`。应用 ID 和用户数据目录保留旧标识，确保改名升级能沿用配置。

本次自动化测试为 **79 项通过、9 项明确跳过**，另有桌面与安装验收，具体命令、结果及边界见 `docs/verification.md` 与安装报告。

完整源码交付可复现打包：

```powershell
python scripts/package-source.py --output "YOTOO部署中心-1.0.0-source.zip"
```

脚本包含源码、测试、构建脚本、安装品牌资源、dist、dist-electron、说明和逐文件 SHA256SUMS，排除 node_modules、release 和本机测试数据；生成后检查 ZIP CRC 和逐文件 SHA-256。
