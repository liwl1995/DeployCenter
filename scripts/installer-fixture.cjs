const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const [mode, directory, marker, root] = process.argv.slice(2);
if (
  !directory ||
  !marker ||
  fs.readFileSync(path.join(directory, '.installer-test-owned'), 'utf8').trim() !== marker
)
  throw new Error('仅允许访问安装验收脚本创建的数据');
const db = new Database(path.join(directory, 'deploy-center.sqlite'));
try {
  const data = JSON.parse(db.prepare('SELECT json FROM config WHERE id=1').get().json);
  if (mode === 'seed') {
    data.services = [
      {
        id: 'installer-fixture',
        name: '升级保留配置验收',
        code: 'installer-fixture',
        description: '隔离的安装验收记录',
        root,
        workDir: '.',
        tool: 'auto',
        mavenPath: '',
        jdk: '',
        args: 'clean package',
        profiles: '',
        jarDir: 'target',
        jarName: 'fixture.jar',
        git: { branch: '待检测', commit: '待检测', time: new Date(0).toISOString() },
      },
    ];
    data.lastService = 'installer-fixture';
    db.prepare('UPDATE config SET json=? WHERE id=1').run(JSON.stringify(data));
  }
  console.log(
    data.services.some((s) => s.id === 'installer-fixture' && s.name === '升级保留配置验收')
      ? 'fixture-kept'
      : 'fixture-missing',
  );
} finally {
  db.close();
}
