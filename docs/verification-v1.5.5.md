# v1.5.5 顶栏入口验收

日期：2026-11-14。本版将外观和设置入口放到固定顶栏右上角，移除侧栏设置入口。主题继续共用原有配置，数据库和部署相关逻辑不变。

## 实际执行结果

- `npm run typecheck`：通过。
- `npm run build`：通过。
- `npm run dist -- --x64`：通过，生成 Windows x64 NSIS 安装包。
- 设置 `DEPLOY_CENTER_TEST_WSL=Ubuntu-24.04`、`DEPLOY_CENTER_NSIS` 为本机已缓存的编译器，执行 `npm test -- --testTimeout=60000 --hookTimeout=30000 --reporter=json --outputFile=.test-data/v155-final-tests.json`：272 项通过、1 项跳过。唯一跳过项为未配置专用非 22 端口 sshd 的真实 SSH 集成，NSIS 原生隔离夹具已运行。
- 新顶栏与原菜单/更新界面相关组件回归：12 项通过；安装助手夹具隔离后，与新顶栏一起复核的 5 项通过。
- 使用 `DEPLOY_CENTER_TEST_EXE=release/win-unpacked/YOTOO 部署中心.exe` 执行 `npm run test:smoke -- --reporter=line`：24 项全部通过。
- 在同一打包程序上设置 `DEPLOY_CENTER_TEST_SCALE=1.25`，执行 `npx playwright test smoke/ui-simplify.spec.ts --grep '顶栏外观与设置' --reporter=line`：1 项通过。
- `node .test-data/verify-package.mjs`：打包主进程、预加载及渲染入口匹配最终构建。
- `git -c core.whitespace=cr-at-eol diff --check`：通过，保留现有文件换行格式。

## 桌面检查覆盖

- 1000×620、1280×800、1600×900 的内容区逻辑尺寸，浅色和深色均实际渲染、截图和测量。
- 顶栏高度为 48px，外观和设置按钮各 36px，位于右上角且不遮挡左侧部署模式提示；内容滚动时保持可见，页脚固定，无横向溢出。
- 菜单包含浅色、深色、跟随系统，当前项有勾选及单选语义，菜单不越界。
- Enter/方向键打开和选择，Esc 关闭并恢复焦点，Tab 关闭后前往设置；保留原有菜单键盘行为，不新增全局快捷键。
- 完整设置页和顶栏使用同一主题值，SQLite 保存后重新加载恢复；切换系统颜色偏好时，跟随系统实时匹配深浅主题。
- 原服务、目标、服务器、历史、日志、更新下载和数据迁移桌面回归继续通过。

## 测试隔离与验证边界

开发机的正式程序正在运行，初轮安装助手测试因此受进程名检测影响。仅在测试生成的助手脚本中将产品名称查询替换成独立夹具名称；真实父进程等待、文件哈希及无害脚本启动仍实际执行，正式助手的运行检测没有修改。测试未关闭正式程序，也未修改其数据。

本版未在用户当前正式安装上实际执行覆盖升级或卸载。交付安装包、源码和 SHA-256 位于源码 `release` 下；正式升级仍受既有运行状态和任务保护约束。
