// @vitest-environment node
import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
it('安装模板暂存主程序并关闭框架缓存，构建成功与失败均恢复原始字节', () => {
  const script = `import fs from 'node:fs/promises';
    import path from 'node:path';
    import { withoutInstallerCache, withNsisTemplate } from './scripts/prepare-nsis.mjs';
    const source=await fs.readFile('node_modules/app-builder-lib/templates/nsis/include/installer.nsh','utf8');
    const updated=withoutInstallerCache(source);
    if(!updated.includes('File "/oname=')||!updated.includes('!macro registryAddInstallInfo'))process.exit(2);
    if(!updated.includes('DC_InstallStage 2'))process.exit(7);
    let refused=0;for(const bad of ['',source+source]){try{withoutInstallerCache(bad);}catch{refused++;}}
    if(refused!==2)process.exit(3);
    const base=path.resolve('.test-data');await fs.mkdir(base,{recursive:true});
    const root=await fs.mkdtemp(path.join(base,'nsis-template-'));
    const file=path.join(root,'node_modules/app-builder-lib/templates/nsis/include/installer.nsh');
    await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,source);
    const extras=await Promise.all(['include/extractAppPackage.nsh','installSection.nsh','include/installUtil.nsh'].map(async (name)=>{
      const original=await fs.readFile(path.join('node_modules/app-builder-lib/templates/nsis',name),'utf8');
      const target=path.join(root,'node_modules/app-builder-lib/templates/nsis',name);
      await fs.writeFile(target,original);
      return {target,original};
    }));
    const restored=async()=>{
      for(const {target,original} of extras)expectEqual(await fs.readFile(target,'utf8'),original);
    };
    function expectEqual(actual,expected){if(actual!==expected)throw new Error('模板未还原');}
    try {
      const result=await withNsisTemplate(async()=>{
        if(await fs.readFile(file,'utf8')!==updated)throw new Error('未替换缓存指令');
        const extract=await fs.readFile(extras[0].target,'utf8');
        const section=await fs.readFile(extras[1].target,'utf8');
        const uninstall=await fs.readFile(extras[2].target,'utf8');
        if(!extract.includes('DC_StageProgramExecutable')||(extract.match(/^ *Nsis7z::Extract/gm)||[]).length!==1)
          throw new Error('解压流程可提前写入主程序');
        if(section.indexOf('Call DC_WithdrawProgram')>=section.indexOf('!insertmacro uninstallOldVersion SHELL_CONTEXT')||
          section.indexOf('Call DC_PublishProgram')<=section.indexOf('!insertmacro installApplicationFiles'))
          throw new Error('主程序的关闭或恢复位置有误');
        if(section.includes('!insertmacro addStartMenuLink') || section.includes('!insertmacro addDesktopLink'))
          throw new Error('框架仍在重复写入快捷方式');
        if(!uninstall.includes('$DC_BackupSource == $installationDir') || !uninstall.includes('$isTryToKeepShortcuts "true"') ||
          !uninstall.includes('$0 --keep-shortcuts'))
          throw new Error('原地升级会卸载快捷方式');
        return 'passed';
      },root);
      if(result!=='passed'||await fs.readFile(file,'utf8')!==source)process.exit(4);
      await restored();
      try{await withNsisTemplate(async()=>{throw new Error('fixture');},root);}catch(error){if(error.message!=='fixture')throw error;}
      if(await fs.readFile(file,'utf8')!==source)process.exit(5);
      await restored();
      if(await fs.stat(file+'.yotoo-lock').catch(()=>undefined))process.exit(6);
    }finally{if(path.dirname(root)!==base)throw new Error('越界');await fs.rm(root,{recursive:true,force:true});}
    console.log('ok');`;
  expect(
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
    }).trim(),
  ).toBe('ok');
});
