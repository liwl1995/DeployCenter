// @vitest-environment node
import { expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

it('Electron 进度条在准备、已量化和核验阶段都只显示一段填充', async () => {
  const html = await fs.readFile('installer/ui/index.html', 'utf8');
  const script = await fs.readFile('installer/ui/renderer.js', 'utf8');
  const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
    JSDOM: new (html: string, options: { runScripts: 'outside-only' }) => { window: Window & { eval(source: string): unknown } };
  };
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  try {
    let emit = (_status: { phase: string; progress: number; indeterminate: boolean }) => {};
    Object.assign(dom.window, {
      matchMedia: () => ({ matches: false, addEventListener() {} }),
      wizard: {
        request: async () => ({ mode: 'repair', from: '2.5.0', to: '2.5.0', installPath: 'C:\\YOTOO', required: 1000 }),
        onStatus: (callback: typeof emit) => { emit = callback; },
      },
    });
    dom.window.eval(script);
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const [progress, indeterminate, width] of [[0, true, '28%'], [38, false, '38%'], [94, true, '94%']] as const) {
      emit({ phase: 'progress', progress, indeterminate });
      const bar = dom.window.document.querySelector('#pbar')!;
      expect(bar.children.length).toBe(1);
      expect(bar.querySelector('i')!.style.width).toBe(width);
      expect(bar.classList.contains('pending')).toBe(progress === 0);
    }
  } finally {
    dom.window.close();
  }
});

const compiler =
  process.env.DEPLOY_CENTER_NSIS ||
  path.join(
    process.env.LOCALAPPDATA || '',
    'electron-builder/Cache/nsis-3.0.4.1/nsis-3.0.4.1-1mx3n/Bin/makensis.exe',
  );

it.skipIf(process.platform !== 'win32' || !existsSync(compiler))(
  'Electron 正在读取 94% 时仍能发布完成状态',
  async () => {
    const base = path.resolve('.test-data');
    await fs.mkdir(base, { recursive: true });
    const root = await fs.mkdtemp(path.join(base, 'installer-status-'));
    try {
      const wizard = await fs.readFile('installer/electron-wizard.nsh', 'utf8');
      const publish = wizard.match(/^!macro DC_WriteWizardStatus\b[\s\S]+?^!macroend/m)?.[0];
      expect(publish).toBeDefined();
      const source = path.join(root, 'status.nsi');
      const exe = path.join(root, 'check.exe');
      await fs.writeFile(source, `
Unicode true
RequestExecutionLevel user
SilentInstall silent
OutFile "${exe}"
!include LogicLib.nsh
Var DC_WizardChannel
Var DC_WizardProcess
Var DC_WizardSequence
Var DC_WizardStatusResult
${publish}
Section
  StrCpy $DC_WizardChannel "${root}"
  StrCpy $DC_WizardProcess 1
  StrCpy $DC_WizardSequence 0
  !insertmacro DC_WriteWizardStatus "progress" "94?" "" "" "0"
  ; 模拟 Windows 读者打开进度文件但未允许替换。
  System::Call 'kernel32::CreateFileW(w "$DC_WizardChannel\\status.1.txt",i0x80000000,i1,p0,i3,i0x80,p0)p.r4'
  \${If} $4 == -1
    SetErrorLevel 1
    Quit
  \${EndIf}
  !insertmacro DC_WriteWizardStatus "done" "100" "" "" "0"
  System::Call 'kernel32::CloseHandle(pr4)'
  \${If} $DC_WizardStatusResult == "failed"
    SetErrorLevel 1
    Quit
  \${EndIf}
  SetErrorLevel 0
SectionEnd
`);
      const build = spawnSync(compiler, ['/INPUTCHARSET', 'UTF8', '/V2', '/WX', source], {
        windowsHide: true, encoding: 'utf8',
      });
      expect(build.status, build.stdout + build.stderr).toBe(0);
      const run = spawnSync(exe, [], { windowsHide: true, timeout: 5000 });
      expect(run.status, String(run.error)).toBe(0);
      expect(await fs.readFile(path.join(root, 'status.1.txt'), 'utf16le')).toMatch(/progress\r?\n94\?/);
      expect(await fs.readFile(path.join(root, 'status.2.txt'), 'utf16le')).toMatch(/done\r?\n100/);
    } finally {
      if (path.dirname(root) !== base) throw new Error('测试目录越界');
      await fs.rm(root, { recursive: true, force: true });
    }
  },
  15000,
);

it.skipIf(process.platform !== 'win32' || !existsSync(compiler)).each([0, 1])(
  '安装中禁止关闭且只显示进度，完成页等待用户选择（%i）',
  async (runAfterFinish) => {
    const base = path.resolve('.test-data');
    await fs.mkdir(base, { recursive: true });
    const root = await fs.mkdtemp(path.join(base, 'installer-progress-'));
    try {
      const exe = path.join(root, 'check.exe');
      const build = spawnSync(
        compiler,
        [
          '/INPUTCHARSET',
          'UTF8',
          '/V2',
          '/WX',
          '/DPROJECT_DIR=' + path.resolve('.'),
          '/DOUTPUT_FILE=' + exe,
          '/DCASE_DIR=' + root,
          '/DRUN_AFTER_FINISH=' + runAfterFinish,
          'installer/test-progress.nsi',
        ],
        { windowsHide: true, encoding: 'utf8' },
      );
      expect(build.status, build.stdout + build.stderr).toBe(0);
      const run = spawnSync(exe, [], { windowsHide: true, timeout: 15000 });
      expect(run.status, String(run.error)).toBe(0);
      expect(await fs.readFile(path.join(root, 'passed.txt'), 'utf16le')).toContain('安装中禁止取消和关闭');
      expect(await fs.readFile(path.join(root, 'finish-ready.txt'), 'utf16le')).toContain(
        '完成页及立即运行选项持续可见',
      );
      expect(await fs.readFile(path.join(root, 'finish-closed.txt'), 'utf16le')).toContain(
        '通过完成按钮正常退出',
      );
      expect(existsSync(path.join(root, 'run-requested.txt'))).toBe(Boolean(runAfterFinish));
    } finally {
      if (path.dirname(root) !== base) throw new Error('测试目录越界');
      await fs.rm(root, { recursive: true, force: true });
    }
  },
  20000,
);
