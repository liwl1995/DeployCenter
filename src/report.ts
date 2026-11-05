import type { Task } from './model';
import { fmtTime, seconds, serverAddress } from './model';
import { operationLabel, shortHash, stepLabels, targetLabels, taskResult } from './presentation';
export type ReportLogs = { build: string[]; targets: Record<string, string[]> };
/** 报告采用 Markdown：便于归档和版本对比，不依赖浏览器执行 HTML。只投影展示所需字段。 */
export function deploymentReport(
  task: Task,
  logs: ReportLogs,
  redact: (text: string) => string = (text) => text,
) {
  const clean = (value: unknown) =>
    redact(String(value ?? '未记录'))
      .replace(/\\/g, '\\\\')
      .replace(/([`*_{}[\]()#+!|>])/g, '\\$1')
      .replace(/</g, '&lt;')
      .replace(/[\r\n]+/g, ' ');
  const code = (text: string) => {
    const safe = redact(text),
      fence = '`'.repeat(Math.max(3, ...[...safe.matchAll(/`+/g)].map((m) => m[0].length + 1)));
    return fence + 'text\n' + safe + '\n' + fence;
  };
  const steps = (list: Task['buildSteps']) =>
    '| 步骤 | 结果 | 耗时 |\n| --- | --- | --- |\n' +
    list
      .map(
        (s) =>
          '| ' +
          clean(s.label) +
          ' | ' +
          stepLabels[s.status || 'pending'] +
          ' | ' +
          seconds(s.elapsed || 0) +
          ' |',
      )
      .join('\n');
  const out = [
    '# YOTOO 部署报告',
    '',
    '- 服务：' + clean(task.service.name),
    '- 类型：' + operationLabel(task),
    '- 结果：' + taskResult(task),
    '- 时间：' + fmtTime(task.started),
    '- 耗时：' + seconds(task.elapsed),
    '- 任务编号：' + clean(task.id),
    '',
    '## 本次内容',
    '',
    code(task.note || '未填写'),
    '',
    '## 产物信息',
    '',
    '- 文件：' + clean(task.artifact.name),
    '- 大小：' + task.artifact.size + ' 字节',
    '- 修改时间：' + clean(fmtTime(task.artifact.modified)),
    '- Git 提交：' + clean(task.deployedCommit || '无法确定此 JAR 对应的提交'),
    '- 项目分支（参考）：' + clean(task.service.git.branch),
    '- JAR 指纹：' + clean(task.artifact.sha256 || '未记录'),
    ...(task.sourceBackup ? ['', '- 回滚恢复来源：' + clean(task.sourceBackup)] : []),
    '',
    '## 构建步骤',
    '',
    steps(task.buildSteps),
    '',
    '### 构建日志摘要（末尾 80 行）',
    '',
    code(logs.build.slice(-80).join('\n')),
  ];
  for (const run of task.targets)
    out.push(
      '',
      '## 环境：' + clean(run.target.name),
      '',
      '- 服务器：' + clean(run.server.name) + ' · ' + clean(serverAddress(run.server)),
      '- 结果：' +
        (task.dryRun && run.status === 'success' ? '检查通过' : targetLabels[run.status]),
      '- 耗时：' + seconds(run.elapsed),
      '- JAR 指纹：' + clean(shortHash(task.artifact.sha256)),
      '- 备份：' +
        clean(
          run.backupRemoved
            ? '备份已清理，不能用于回滚'
            : run.backupCreated
              ? run.backupPath
              : '未创建',
        ),
      '- 恢复版本：' + clean(run.backupVersion || '未记录'),
      ...(run.error ? ['- 原因：' + clean(run.error)] : []),
      '',
      steps(run.steps),
      '',
      '### 目标日志摘要（末尾 80 行）',
      '',
      code((logs.targets[run.target.id] || []).slice(-80).join('\n')),
    );
  out.push('', '报告只包含展示字段与脱敏日志摘要；完整原始日志可在应用中单独导出。', '');
  return out.join('\n');
}
