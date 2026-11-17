import { dryRunScript } from './remote';
import type { RunTarget, Task } from '../src/model';

/** 只读预检与线上基线读取；不创建目录、上传文件或取得部署锁。 */
export function scheduleCheckScript(task: Task, target: RunTarget) {
  return (
    dryRunScript(task, target).replace('发现已有任务锁', 'SCHEDULE_LOCKED: 发现已有任务锁') +
    `
if [ -e "$JAR" ]; then
  [ -f "$JAR" ] && [ -r "$JAR" ] || { printf '线上 JAR 不是可读普通文件' >&2; exit 1; }
  if command -v sha256sum >/dev/null; then hash="$(sha256sum -- "$JAR" | awk '{print $1}')";
  elif command -v shasum >/dev/null; then hash="$(shasum -a 256 -- "$JAR" | awk '{print $1}')";
  elif command -v openssl >/dev/null; then hash="$(openssl dgst -sha256 "$JAR" | awk '{print $NF}')";
  else printf '定时发布需要 SHA-256 工具以核对线上版本' >&2; exit 1; fi
  [[ "$hash" =~ ^[a-fA-F0-9]{64}$ ]] || exit 1
  printf 'DC_BASELINE=%s\\n' "$hash"
else printf 'DC_BASELINE=absent\\n'; fi
`
  );
}
