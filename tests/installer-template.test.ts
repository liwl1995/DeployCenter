// @vitest-environment node
import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
it('安装模板仅关闭框架缓存，变化时停止；构建成功与失败均恢复原始字节', () => {
  const script = `import fs from 'node:fs/promises';
    import path from 'node:path';
    import { withoutInstallerCache, withNsisTemplate } from './scripts/prepare-nsis.mjs';
    const source=await fs.readFile('node_modules/app-builder-lib/templates/nsis/include/installer.nsh','utf8');
    const updated=withoutInstallerCache(source);
    if(!updated.includes('File "/oname=')||!updated.includes('!macro registryAddInstallInfo'))process.exit(2);
    let refused=0;for(const bad of ['',source+source]){try{withoutInstallerCache(bad);}catch{refused++;}}
    if(refused!==2)process.exit(3);
    const base=path.resolve('.test-data');await fs.mkdir(base,{recursive:true});
    const root=await fs.mkdtemp(path.join(base,'nsis-template-'));
    const file=path.join(root,'node_modules/app-builder-lib/templates/nsis/include/installer.nsh');
    await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,source);
    try {
      const result=await withNsisTemplate(async()=>{
        if(await fs.readFile(file,'utf8')!==updated)throw new Error('未替换缓存指令');
        return 'passed';
      },root);
      if(result!=='passed'||await fs.readFile(file,'utf8')!==source)process.exit(4);
      try{await withNsisTemplate(async()=>{throw new Error('fixture');},root);}catch(error){if(error.message!=='fixture')throw error;}
      if(await fs.readFile(file,'utf8')!==source)process.exit(5);
      if(await fs.stat(file+'.yotoo-lock').catch(()=>undefined))process.exit(6);
    }finally{if(path.dirname(root)!==base)throw new Error('越界');await fs.rm(root,{recursive:true,force:true});}
    console.log('ok');`;
  expect(
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
    }).trim(),
  ).toBe('ok');
});
