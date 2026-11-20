const path = require('node:path');
const { createRequire } = require('node:module');
const { accessSync, constants } = require('node:fs');

// 安装器使用新 EXE 的 Node 模式运行。按主进程的位置加载依赖，且不访问用户数据。
const archive = path.join(path.dirname(process.execPath), 'resources', 'app.asar');
const entry = path.join(archive, 'dist-electron', 'main.cjs');
accessSync(entry, constants.R_OK);
const load = createRequire(entry);
if (load('../package.json').version !== process.argv[2]) throw new Error('应用归档版本与安装包不符');
load('ssh2');
const Database = load('better-sqlite3');
new Database(':memory:').close();
process.stdout.write('YOTOO_PROGRAM_READY');
