import path from 'node:path';
import { createHash } from 'node:crypto';
import { remoteJar, shellQuote as q, type Target } from '../src/model';
import { mustExec, type Transport } from './ssh';
import { isFinalState, validOwner, workbenchHeader, workbenchPath } from './workbench';

export type Inspection = {
  owner: string;
  lockOwner: string;
  cleanupOwner: string;
  state: string;
  process: '0' | '1' | '2';
  hasPid: boolean;
  present: boolean;
  age: number;
  unknown: string[];
  legacy: string[];
  jarHash: string;
  container: string;
  task: string;
  revision: string;
};

const legacyChecks =
  [
    'dc_legacy() {',
    '  local dir="$1" name entry pid allowed state',
    '  dc_dir "$dir" || return 1',
    '  name="$(basename -- "$dir")"',
    '  if [[ "$name" =~ ^DC-CLEAN-[a-f0-9-]{36}$ ]]; then allowed="pid|state|exit-code";',
    '  elif [[ "$name" =~ ^DC-[A-Z0-9]+-[a-z0-9]+-[A-Za-z0-9_-]+$ ]]; then allowed="runner.sh|preflight|state|state.next|pid|journal|output.log|cancel|local-health";',
    '  else return 1; fi',
    '  for entry in "$dir"/*; do',
    '    [[ "$(basename -- "$entry")" =~ ^($allowed)$ ]] && dc_file "$entry" || return 1',
    '  done',
    '  state="$(dc_value "$dir/state" || true)"',
    '  if [[ "$name" = DC-CLEAN-* ]]; then [ "$state" = FINISHED ] || return 1;',
    '  else dc_terminal "$state" || return 1; fi',
    '  if [ -e "$dir/pid" ]; then',
    '    pid="$(dc_value "$dir/pid")"; [[ "$pid" =~ ^[0-9]+$ ]] || return 1',
    '    [ ! -e "/proc/$pid/stat" ] || return 1',
    '  fi',
    '}',
  ].join('\n') + '\n';

export async function inspectWorkbench(transport: Transport, target: Target): Promise<Inspection> {
  const script =
    workbenchHeader(target, '') +
    legacyChecks +
    [
      'dc_path "$DIR"',
      'if ! dc_path "$JOB" || ! dc_path "$LOCK"; then printf "UNEXPECTED\\t工作台或任务锁路径含符号链接\\n"; exit 0; fi',
      'if [ -e "$LOCK" ]; then',
      '  printf "present\\t1\\n"',
      '  dc_dir "$LOCK"',
      '  created="$(dc_value "$LOCK/created" || true)"',
      '  if [[ "$created" =~ ^[0-9]{1,12}$ ]]; then printf "age\\t%s\\n" "$(( $(date +%s) - created ))"; fi',
      '  lockOwner="$(dc_value "$LOCK/owner" || true)"; [[ "$lockOwner" =~ ^DC-[A-Za-z0-9_-]+$ ]] && printf "lockOwner\\t%s\\n" "$lockOwner"',
      '  cleanup="$(dc_value "$LOCK/cleanup" || true)"; [[ "$cleanup" =~ ^DC-[A-Za-z0-9_-]+$ ]] && printf "cleanupOwner\\t%s\\n" "$cleanup"',
      '  for entry in "$LOCK"/*; do',
      '    case "$(basename -- "$entry")" in owner|created|cleanup|pid) dc_file "$entry" || printf "UNEXPECTED\\t锁/%q\\n" "$(basename -- "$entry")";; *) printf "UNEXPECTED\\t锁/%q\\n" "$(basename -- "$entry")";; esac',
      '  done',
      'fi',
      'if [ -e "$JOB" ]; then',
      '  dc_dir "$JOB"',
      '  entries=("$JOB"/*); if [ "${#entries[@]}" -gt 0 ]; then printf "present\\t1\\n"; fi',
      '  owner="$(dc_task || true)"',
      '  if [[ "$owner" =~ ^DC-[A-Za-z0-9_-]+$ ]]; then',
      '    printf "owner\\t%s\\n" "$owner"',
      '    state="$(dc_value "$JOB/state" || true)"; [[ "$state" =~ ^[A-Z_]+$ ]] && printf "state\\t%s\\n" "$state"',
      '    dc_list || true',
      '    process=0; dc_alive || process=$?; printf "process\\t%s\\n" "$process"',
      '    if [ -e "$JOB/pid" ] || [ -L "$JOB/pid" ]; then printf "hasPid\\t1\\n"; fi',
      '  else',
      '    for entry in "$JOB"/*; do',
      '      if dc_legacy "$entry"; then printf "LEGACY\\t%s\\n" "$(basename -- "$entry")";',
      '      else printf "UNEXPECTED\\t%q\\n" "$(basename -- "$entry")"; fi',
      '    done',
      '  fi',
      'fi',
      'jar=' + q(remoteJar(target)),
      'if dc_file "$jar"; then',
      '  if command -v sha256sum >/dev/null; then printf "jarHash\\t"; timeout 15 sha256sum -- "$jar" | awk \'{print $1}\' || true;',
      '  elif command -v shasum >/dev/null; then printf "jarHash\\t"; timeout 15 shasum -a 256 -- "$jar" | awk \'{print $1}\' || true; fi',
      'fi',
      target.mode === 'docker'
        ? 'printf "container\\t"; timeout 10 docker inspect -f "{{.State.Running}}" -- ' +
          q(target.container) +
          ' 2>/dev/null || printf "未知\\n"'
        : '',
    ].join('\n');
  const response = await mustExec(transport, 'bash -s', script);
  const rows = response
    .trim()
    .split(/\r?\n/)
    .map((line) => line.split('\t', 2));
  const values = Object.fromEntries(rows);
  const owner = validOwner(values.owner || '') ? values.owner : '';
  let task = '';
  if (owner) {
    const job = workbenchPath(target) + '/.deploy-center/task';
    const bytes = await transport.read(job, 0, 16385);
    if (bytes.length <= 16384 && bytes.toString('utf8').startsWith(owner + '\n'))
      task = bytes.toString('utf8').slice(owner.length + 1);
  }
  const result = {
    owner,
    lockOwner: values.lockOwner || '',
    cleanupOwner: values.cleanupOwner || '',
    state: values.state || '',
    process: values.process === '0' || values.process === '1' ? values.process : '2',
    hasPid: values.hasPid === '1',
    present: values.present === '1',
    age: Number.isSafeInteger(Number(values.age)) ? Number(values.age) : -1,
    unknown: rows.filter(([key]) => key === 'UNEXPECTED').map(([, name]) => name),
    legacy: rows.filter(([key]) => key === 'LEGACY').map(([, name]) => name),
    jarHash: /^[a-f0-9]{64}$/.test(values.jarHash || '') ? values.jarHash : '',
    container: values.container || '',
    task,
  } satisfies Omit<Inspection, 'revision'>;
  // 锁的年龄随读取变化，不参与身份比较；执行时仍重新检查阈值和进程。
  const revision = createHash('sha256')
    .update(JSON.stringify({ ...result, age: undefined }))
    .digest('hex');
  return { ...result, revision };
}

export function exited(info: Inspection) {
  return (
    info.process === '1' ||
    (!info.hasPid && ['PREPARED', 'LAUNCHING', 'CANCELLED', 'FAILED'].includes(info.state))
  );
}

export async function claimForImport(transport: Transport, target: Target, info: Inspection) {
  if (!validOwner(info.owner) || !isFinalState(info.state) || !exited(info))
    throw new Error('工作台尚未写完最终结果');
  await mustExec(
    transport,
    'bash -s',
    workbenchHeader(target, info.owner) +
      [
        'dc_workspace',
        '[ "$(dc_value "$JOB/state")" = ' + q(info.state) + ' ]',
        'if [ ! -e "$LOCK" ] && [ ! -L "$LOCK" ]; then dc_acquire; fi',
        'dc_verify',
      ].join('\n'),
  );
}

export function canDiscard(info: Inspection, staleMinutes: number) {
  return (
    validOwner(info.owner) &&
    !info.unknown.length &&
    (!info.lockOwner || (info.lockOwner === info.owner && info.age >= staleMinutes * 60)) &&
    (info.process === '1' || (!info.hasPid && info.age >= staleMinutes * 60))
  );
}
export async function discardWorkbench(
  transport: Transport,
  target: Target,
  info: Inspection,
  staleMinutes: number,
) {
  if (!canDiscard(info, staleMinutes)) throw new Error('无法确认原任务已停止，已保留现场');
  await mustExec(
    transport,
    'bash -s',
    workbenchHeader(target, info.owner) +
      [
        'dc_workspace',
        'held=0; if [ -e "$LOCK" ]; then held=1; else dc_acquire; fi',
        'dc_lock; exec 9<"$LOCK"; flock -n 9',
        'dc_verify; [ "$(stat -Lc "%d:%i" -- "$LOCK")" = "$(stat -Lc "%d:%i" /proc/$$/fd/9)" ]',
        '[ "$(dc_value "$JOB/state" || true)" = ' + q(info.state) + ' ]',
        'age=$(( $(date +%s) - $(dc_value "$LOCK/created") ))',
        '[ "$held" = 0 ] || [ "$age" -ge ' + String(staleMinutes * 60) + ' ]',
        'alive=0; dc_alive || alive=$?',
        '[ "$alive" = 1 ] || { [ ! -e "$JOB/pid" ] && [ ! -L "$JOB/pid" ] && [ "$age" -ge ' +
          String(staleMinutes * 60) +
          ' ]; }',
        'dc_list',
        'for entry in "$LOCK"/*; do',
        '  case "$(basename -- "$entry")" in owner|created) dc_file "$entry";; *) exit 1;; esac',
        'done',
        'dc_remove_files; dc_dir "$JOB"; rmdir -- "$JOB"; dc_release',
      ].join('\n'),
  );
}

export async function archiveLegacyWorkbench(
  transport: Transport,
  target: Target,
  owner: string,
  names: string[],
) {
  const archive = workbenchPath(target) + '/.deploy-center.legacy.' + owner;
  await mustExec(
    transport,
    'bash -s',
    workbenchHeader(target, owner) +
      legacyChecks +
      [
        'dc_dir "$JOB"; dc_acquire',
        'trap dc_unlock EXIT',
        'entries=("$JOB"/*)',
        '[ "${#entries[@]}" -eq ' + names.length + ' ]',
        ...names.map((name) => 'dc_legacy "$JOB"/' + q(name)),
        '[ ! -e ' + q(archive) + ' ] && [ ! -L ' + q(archive) + ' ]',
        'mv -T -- "$JOB" ' + q(archive),
      ].join('\n'),
  );
  return archive;
}

export function allowedBackup(target: Target, file: string) {
  const configured = target.backup.directory.startsWith('/')
    ? target.backup.directory
    : path.posix.join(target.directory, target.backup.directory);
  return (
    file === path.posix.normalize(file) &&
    path.posix.dirname(file) === path.posix.normalize(configured).replace(/\/$/, '') &&
    file !== remoteJar(target) &&
    !/[\r\n\0]/.test(file)
  );
}
