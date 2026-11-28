const fs = require('node:fs/promises');
const path = require('node:path');
const { Arch, exec } = require('builder-util');
// 先沿用 CLI 的初始化入口，确保内部目标与平台模块按原顺序加载。
require('app-builder-lib');
const { archive } = require('app-builder-lib/out/targets/archive');
const { NsisTarget, createAppPackageArchiveOptions } = require('app-builder-lib/out/targets/nsis/NsisTarget');
const { getPath7za } = require('app-builder-lib/out/toolsets/7zip');

const wizardLocales = new Set(['en-US.pak', 'zh-CN.pak']);

// 只拆分 NSIS 的压缩载荷，保留 win-unpacked 以及其它打包目标的原始布局。
const buildAppPackage = NsisTarget.prototype.buildAppPackage;
NsisTarget.prototype.buildAppPackage = async function (appOutDir, arch, ...options) {
  if (this.name !== 'nsis') return buildAppPackage.call(this, appOutDir, arch, ...options);
  if (arch !== Arch.x64 || this.isZipPayload || this.isBuildDifferentialAware) {
    throw new Error('当前安装向导需要 x64 及非差分的 7z 安装载荷');
  }
  const workspace = process.env.YOTOO_INSTALLER_BUILD_TEMP;
  if (!workspace || !path.isAbsolute(workspace)) throw new Error('未设置隔离的安装包构建目录');
  const runtime = path.join(workspace, 'runtime');
  const payload = path.join(workspace, 'payload');
  const runtimeArchive = path.join(workspace, 'electron.7z');
  const runtimeInclude = path.join(workspace, 'electron-runtime.nsh');
  await fs.mkdir(runtime);
  await fs.mkdir(payload);
  const files = await fs.readdir(appOutDir, { withFileTypes: true });
  const copyForUninstall = ['!macro DC_CopyElectronForUninstall'];
  const copyFile = (relative) =>
    `  System::Call 'kernel32::CopyFileW(w "$INSTDIR\\${relative}",w "$PLUGINSDIR\\7z-out\\${relative}",i1)i.r0'`;
  for (const entry of files) {
    if (entry.isSymbolicLink() || /['"$\r\n]/.test(entry.name)) throw new Error('无法拆分安装载荷中的路径：' + entry.name);
    const source = path.join(appOutDir, entry.name);
    if (entry.name === 'resources' || (entry.isFile() && entry.name.startsWith('LICENSE'))) {
      await fs.cp(source, path.join(payload, entry.name), { recursive: entry.isDirectory() });
    } else if (entry.isDirectory()) {
      if (entry.name !== 'locales') throw new Error('请核对新增 Electron 运行时目录：' + entry.name);
      await fs.mkdir(path.join(runtime, 'locales'));
      await fs.mkdir(path.join(payload, 'locales'));
      const locales = await fs.readdir(source);
      if (![...wizardLocales].every((name) => locales.includes(name))) throw new Error('缺少安装向导所需的中英文语言资源');
      copyForUninstall.push('  CreateDirectory "$PLUGINSDIR\\7z-out\\locales"');
      for (const name of locales) {
        if (!/^[a-zA-Z0-9-]+\.pak$/.test(name)) throw new Error('无法复制 Electron 语言资源：' + name);
        const early = wizardLocales.has(name);
        await fs.copyFile(path.join(source, name), path.join(early ? runtime : payload, 'locales', name));
        if (early) copyForUninstall.push(copyFile('locales\\' + name));
      }
    } else {
      await fs.copyFile(source, path.join(runtime, entry.name));
      copyForUninstall.push(copyFile(entry.name));
    }
  }
  await fs.access(path.join(payload, 'resources', 'app.asar'));
  const payloadFiles = await fs.readdir(payload, { recursive: true, withFileTypes: true });
  let payloadBytes = 0;
  for (const entry of payloadFiles) {
    if (entry.isFile()) payloadBytes += (await fs.stat(path.join(entry.parentPath, entry.name))).size;
  }
  await fs.writeFile(runtimeInclude, [`!define DC_INSTALLER_PAYLOAD_BYTES ${payloadBytes}`, ...copyForUninstall, '!macroend', ''].join('\n'));
  if (this.packager.compression === 'store' || process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL != null) {
    await archive('7z', runtimeArchive, runtime, createAppPackageArchiveOptions(this.packager.compression));
  } else {
    // 先显示向导再解包应用资源。运行时用较低压缩等级，并保留 Nsis7z 支持的 BCJ 过滤器。
    await exec(await getPath7za(), ['a', '-t7z', '-mx=3', '-mf=BCJ', '-mtc=off', '-mtm=off', '-mta=off', '-bd', runtimeArchive, '.'], { cwd: runtime });
  }
  process.env.YOTOO_INSTALLER_RUNTIME_ARCHIVE = runtimeArchive;
  process.env.YOTOO_INSTALLER_RUNTIME_INCLUDE = runtimeInclude;
  return buildAppPackage.call(this, payload, arch, ...options);
};
