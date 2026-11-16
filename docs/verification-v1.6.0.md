# v1.6.0 验证记录

## 范围和取舍

- 文本复制统一走原生写入接口，不开放浏览器权限，不增加读取剪贴板的应用接口。等待 Electron 45 的异步写入完成后才提示成功。失败不触发下载；导出和创建配置副本维持原语义。
- 日志根据真实内容高度跟随，监听视口与内容尺寸，末行与滚动条间保留 12px 间距；保持虚拟滚动、选择文字和手动上翻时暂停跟随。
- 目标卡片和详情中的“编辑目标”统一为“编辑”。
- 安装进度表示四个真实阶段，非字节百分比。独立阶段条不会被解压插件重置；日志默认展开，开关与日志分行，支持重复显示/隐藏。没有改变安装、失败恢复、默认卸载保留用户数据和运行中拒绝覆盖的规则。

主要文件：`src/clipboard.ts`、`src/LogViewer.tsx`、`src/TaskExtras.tsx`、`src/App.tsx`、`src/platform.ts`、`src/style.css`、`electron/main.ts`、`electron/preload.ts`、`installer/progress.nsh`、`installer/custom.nsh`、`scripts/prepare-nsis.mjs` 及对应测试。

## 实际检查

| 实际执行的命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm test -- --testTimeout=60000 --hookTimeout=30000 --reporter=json --outputFile=.test-data/v160-tests.json` | 314 项，313 通过、0 失败、1 项专用 sshd 集成跳过 |
| `npm run pack -- --x64` | Vite、Electron、原生更新助手与正式 Windows x64 载荷构建通过 |
| `npm run test:smoke -- --reporter=line`（指定正式打包 EXE） | 第二轮完整运行 26 通过、1 项 Windows 测试运行器异常退出；27 项均已有通过记录，异常项专项复测通过 |
| `npm run test:smoke -- --grep '顶栏外观与设置' --reporter=line` | 1 项通过，主题与键盘行为不改；测量等待视口布局帧稳定 |
| `npm run test:smoke -- --grep 'utilityProcess 通过 IPC' --reporter=line` | 1 项通过，只读试运行、首次指纹确认与不上传约束通过 |
| `npm run test:smoke -- --grep '文本复制' --reporter=line` | 1 项通过，真实 Windows 复制及 Ctrl+V，没有触发下载 |
| `./scripts/verify-isolated-installer.ps1 -Prepackaged ./release/win-unpacked` | 15 项通过，安装、启动、覆盖升级、默认保留数据卸载与彻底清理均实际执行 |
| `node .test-data/verify-package.mjs` | 正式载荷 main、preload、renderer 与构建输出一致 |

完整单元回归启用了本机 NSIS 编译器及 `DEPLOY_CENTER_TEST_WSL=Ubuntu-24.04`。安装验收的 app.asar SHA-256：`598e5d74631a6f84c0e702f8259ae9fa69ebd233f3ab0f2f17f8c258f6bea271`，与正式载荷一致。记录位于 `release/installer-qa-1.6.0.json`。

第一次完整桌面运行出现菜单测量超时：菜单已打开，却被窗口调整后的延迟滚动/尺寸事件关闭；测试改为等待布局帧完成，专项及第二轮完整运行中均通过。第二轮完整运行中有一次测试运行器异常退出（退出码 3221226505），不是断言失败；相同正式程序的只读试运行专项复测通过。保留异常事实，不将它写成一次完整运行全部通过。

## 覆盖说明

- 组件测试验证原生写入成功/失败不触发下载、浏览器原型复制，以及动态高度上传区的日志跟随。
- 真实 Electron 使用 Windows 剪贴板写入中文与多行文本，点击提交复制按钮后在搜索框直接 Ctrl+V；确认得到完整提交号且没有下载事件。验证非法参数被拒绝。测试仅在内存备份、按格式恢复剪贴板，内容不写入测试报告和文件。
- 1000×620、1280×800、1600×900 窗口下持续追加日志，检查跟随仍勾选、实际滚动底部和末行矩形边界；保留大日志虚拟滚动、手动翻阅及文本选择测试。
- 原生 NSIS 夹具检查总体阶段单调、内部进度从接近完成归零时总体不变、安装期间通过计时回调收起/显示详情，检查开关底边不超过日志区顶边。
- 原生夹具的初次视觉检查发现详情开关与第一行重叠，已为开关单独留行；无回调宿主时不能及时响应的问题已用隐藏宿主修复并由原生回归验证。

## 验证边界

- 没有操作用户正式安装或真实部署服务器。安装和升级验证使用独立 QA 身份及源码下的测试数据。
- 根据用户要求结束 computer-use，确认验收窗口退出并重置控制会话，此后没有重新开启。修改后的安装页依靠原生控件几何与行为测试；正式安装向导没有再次逐页人工点击或截图。
- Linux 完整测试套件未执行；Windows 原生 GUI 测试在非 Windows 下跳过。专用非 22 端口 sshd 未配置的集成项不记为通过。
- 本版安装阶段进度不承诺按文件大小匀速推进；安装文件期间会显示正在处理的阶段和可展开的日志，不显示编造的字节百分比。
