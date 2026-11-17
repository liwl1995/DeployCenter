# v1.6.1 安装完成页修复验证

## 原因与改动

Windows 应用事件记录确认 1.6.0 安装器在进入完成页时抛出 `0xC000041D`。新增的详情计时器通过 `nsDialogs::Create` 创建辅助窗口，临时替换主窗口的对话框回调，却没有走 `nsDialogs::Show` 的恢复流程；下一张完成页再次创建对话框时形成回调递归。

- 辅助窗口创建后立即恢复原向导回调，只使用隐藏窗口承载详情计时器；离页时停止计时器并释放窗口。
- 阶段条仅对自身关闭系统缓动，每次更新立即重绘，不改变其他控件的主题、字体或 DPI 布局。
- 保留四阶段单调推进、详情展开/收起、安装目录和用户数据保护、正在运行时拒绝安装等规则。
- 补丁版本更新为 1.6.1；应用部署引擎、SSH、凭据、数据库、远程锁与回滚未修改。

## 回归范围

原生测试夹具不安装真实程序，只写隔离测试目录，实际经过“选项页 → 安装页 → 完成页”：

1. 比较安装页辅助窗口创建前后向导回调，要求保持一致。
2. 内部进度从 90 归零时总体阶段不回退。
3. 重复勾选详情开关，检查日志可见性与控件边界。
4. 检查最终进度值，并通过原生打印接口采样进度条右侧颜色，确认完成时实际已填充。
5. 完成页及“立即运行”控件持续可见，等待完成按钮后才退出。
6. 分别验证立即运行选中和未选中，只有选中时执行无害的启动记录回调。

修复前新增的两项回归均以 `3221226525`（`0xC000041D`）失败；修复后两项通过。初次修复后的测试还暴露 NSIS `FileWrite` 使用系统编码的问题，夹具报告已改为明确的 UTF-16LE 后重新通过。

## 已实际执行

| 命令 | 结果 |
| --- | --- |
| `npx vitest run tests/installer-progress.test.ts --testTimeout=30000 --reporter=verbose` | 两种立即运行选择均通过 |
| `npm run typecheck` | 通过 |
| `npm test -- --testTimeout=60000 --hookTimeout=30000 --reporter=json --outputFile=.test-data/v161-tests.json` | 315 项：314 通过、0 失败、1 项专用 SSH 集成跳过；启用隔离 WSL 测试 |
| `npm run build` | Vite、Electron 和独立 Windows 更新助手构建通过；存在原有的大分块体积提示 |
| `npx prettier --check tests/installer-progress.test.ts` | 通过 |
| `git -c core.whitespace=cr-at-eol diff --check` | 通过，保留既有 CRLF 文件格式 |

## 实际安装与图形验收

- `npx electron-builder --win dir --x64 --publish never`：生成正式 Windows 载荷。
- `./scripts/verify-isolated-installer.ps1 -Prepackaged ./release/win-unpacked`：15 项全部通过，包括中文目录实际安装、已安装 EXE 启动与 SQLite/Windows 加密、覆盖升级、默认保留用户数据卸载、可选彻底清理及正式安装注册保持不变。报告为 `release/installer-qa-1.6.1.json`。
- 实际打开独立 QA 身份的中文图形安装器，经过欢迎、目录、选项、文件安装和完成页。确认数据目录为隔离 QA 目录，安装期间进度条与日志正常显示，完成页实际显示“已安装”和默认勾选的“立即运行”，停留等待操作，取消立即运行并点击完成后正常关闭，没有启动测试应用。
- 图形安装后的 QA 程序已正常卸载，QA 数据与定位键已清理；正式安装注册保持原样。报告为 `release/installer-gui-1.6.1.json`。验收后已关闭测试窗口并重置 computer-use 会话。卸载启动进程退出后仍有短暂的异步清理，等待程序和测试数据目录均消失后才判定清理完成。
- 安装包构建使用 `node scripts/build-installer.mjs --win nsis --x64 --prepackaged release/win-unpacked --publish never`，与 `npm run dist -- --x64` 使用同一个安装器构建入口；源码使用 `python scripts/package-source.py --output release/YOTOO部署中心-1.6.1-source.zip` 打包并逐文件核对 SHA-256 和 ZIP CRC。

## 验证边界

未覆盖用户正式安装，未连接真实部署服务器，未执行真实部署。实际安装验收使用独立 QA 产品名、注册项、程序和数据目录，应用载荷与交付程序一致；图形交付包没有再次安装到正式身份。Linux 完整测试套件未执行。阶段条表示四个安装阶段，不表示按文件大小匀速增长。

