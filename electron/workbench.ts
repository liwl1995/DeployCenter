import path from 'node:path';
import { createHash } from 'node:crypto';
import { shellQuote as q, type RunTarget, type Server, type Target } from '../src/model';
import { backupConnection } from './backup-catalog';
import { mustExec, type Transport } from './ssh';
import helpers from './remote-workbench.sh';

export const states = [
  'SUCCESS',
  'UNVERIFIED',
  'FAILED',
  'ROLLEDBACK',
  'ROLLBACK_FAILED',
  'CANCELLED',
] as const;
export type FinalState = (typeof states)[number];
export const isFinalState = (value: string): value is FinalState =>
  states.some((state) => state === value);
export const validOwner = (owner: string) => /^DC-[A-Za-z0-9_-]{1,160}$/.test(owner);
export const workbenchFiles = ['task', 'state', 'journal', 'output.log'] as const;
type WorkbenchFile = (typeof workbenchFiles)[number];
export type RemoteFileProof = { file: WorkbenchFile; size: number; sha256?: string };
export type Receipt = {
  scope: string;
  owner: string;
  state: FinalState;
  files: RemoteFileProof[];
};

export function workbenchPath(target: Pick<Target, 'directory'>) {
  const directory = path.posix.normalize(target.directory).replace(/\/+$/, '');
  if (
    !directory.startsWith('/') ||
    /[\r\n\0]/.test(directory) ||
    target.directory.split('/').includes('..')
  )
    throw new Error('远程部署目录必须是可核对的绝对路径，且不能使用上级目录片段');
  return directory;
}
export function workbenchScope(target: Pick<Target, 'directory'>, server: Server) {
  return backupConnection(server) + ':' + workbenchPath(target);
}
export function workbenchHeader(target: Pick<Target, 'directory'>, owner: string) {
  const dir = workbenchPath(target);
  return [
    'set -euo pipefail',
    'shopt -s nullglob dotglob',
    'DIR=' + q(dir),
    'JOB=' + q(dir + '/.deploy-center'),
    'LOCK=' + q(dir + '/.deploy-center.lock'),
    'OWNER=' + q(owner),
    helpers,
    '',
  ].join('\n');
}
export async function pollWorkbench(
  transport: Transport,
  r: RunTarget,
  owner: string,
  offsets?: { journal: number; log: number },
) {
  if (offsets && transport.execBytes) {
    const script = workbenchPollScript(r.target, owner, offsets);
    const packet = await transport.execBytes('bash -s', script, 2 * 262144 + 128);
    return parseWorkbenchPoll(packet);
  }
  const result = await mustExec(
    transport,
    'bash -s',
    workbenchHeader(r.target, owner) +
      'dc_verify; state="$(dc_value "$JOB/state")"; alive=0; dc_alive || alive=$?; printf "%s\\t%s" "$state" "$alive"',
  );
  const [state, code] = result.trim().split('\t');
  if (!/^[A-Z_]+$/.test(state) || !['0', '1', '2'].includes(code))
    throw new Error('远端工作台状态无法读取');
  return {
    state,
    alive: code === '0',
    exited: code === '1',
    journal: undefined as Buffer | undefined,
    output: undefined as Buffer | undefined,
  };
}
const hashScript =
  [
    'dc_hash() {',
    '  if command -v sha256sum >/dev/null; then sha256sum -- "$1" | awk \'{print $1}\'',
    '  elif command -v shasum >/dev/null; then shasum -a 256 -- "$1" | awk \'{print $1}\'',
    '  elif command -v openssl >/dev/null; then openssl dgst -sha256 "$1" | awk \'{print $NF}\'',
    '  else printf -; fi',
    '}',
  ].join('\n') + '\n';

function proofScript(target: Target, owner: string, state: FinalState) {
  return (
    workbenchHeader(target, owner) +
    hashScript +
    [
      'dc_verify',
      '[ "$(dc_value "$JOB/state")" = ' + q(state) + ' ]',
      'alive=0; dc_alive || alive=$?',
      '[ "$alive" = 1 ] || { [ ' +
        q(state === 'CANCELLED' || state === 'FAILED' ? '1' : '0') +
        ' = 1 ] && [ ! -e "$JOB/pid" ] && [ ! -L "$JOB/pid" ]; }',
      'for name in ' + workbenchFiles.join(' ') + '; do',
      '  file="$JOB/$name"; dc_file "$file"',
      '  size="$(stat -c%s -- "$file")"; hash="$(dc_hash "$file")"',
      '  printf "%s\\t%s\\t%s\\n" "$name" "$size" "$hash"',
      'done',
    ].join('\n')
  );
}
function parseProof(value: string): RemoteFileProof[] {
  const rows = value.trim().split('\n');
  if (rows.length !== workbenchFiles.length) throw new Error('远端文件校验清单不完整');
  return rows.map((row, index) => {
    const [file, length, digest, extra] = row.split('\t');
    const size = Number(length);
    if (
      file !== workbenchFiles[index] ||
      !/^\d+$/.test(length) ||
      !Number.isSafeInteger(size) ||
      !(digest === '-' || /^[a-f0-9]{64}$/.test(digest)) ||
      extra !== undefined
    )
      throw new Error('远端文件校验清单无效');
    return { file: workbenchFiles[index], size, ...(digest === '-' ? {} : { sha256: digest }) };
  });
}
export async function verifyWorkbench(
  transport: Transport,
  r: RunTarget,
  owner: string,
  state: FinalState,
  consume: (file: WorkbenchFile, bytes: Buffer, offset: number) => void,
): Promise<Receipt> {
  const job = workbenchPath(r.target) + '/.deploy-center';
  if (r.remote?.jobDir !== job || !validOwner(owner))
    throw new Error('远端工作台身份与目标配置不符');
  const script = proofScript(r.target, owner, state);
  const files = parseProof(await mustExec(transport, 'bash -s', script));
  for (const item of files) {
    const hash = createHash('sha256');
    const expectedState = item.file === 'state' ? Buffer.from(state) : undefined;
    if (expectedState && item.size !== expectedState.length)
      throw new Error('远端最终状态长度不符');
    let offset = 0;
    while (offset < item.size) {
      const chunk = await transport.read(
        job + '/' + item.file,
        offset,
        Math.min(item.size - offset, 262144),
      );
      if (!chunk.length || offset + chunk.length > item.size)
        throw new Error('远端工作文件未完整接收：' + item.file);
      if (expectedState && !chunk.equals(expectedState.subarray(offset, offset + chunk.length)))
        throw new Error('远端最终状态与核对结果不符');
      hash.update(chunk);
      consume(item.file, chunk, offset);
      offset += chunk.length;
    }
    if (item.sha256 && hash.digest('hex') !== item.sha256)
      throw new Error('远端工作文件 SHA-256 不一致：' + item.file);
  }
  const second = parseProof(await mustExec(transport, 'bash -s', script));
  if (JSON.stringify(second) !== JSON.stringify(files))
    throw new Error('读取过程中远端工作文件发生变化，已保留现场');
  return { scope: workbenchScope(r.target, r.server), owner, state, files };
}

export function cleanupScript(target: Target, receipt: Receipt) {
  if (
    !validOwner(receipt.owner) ||
    !isFinalState(receipt.state) ||
    receipt.files.length !== workbenchFiles.length ||
    receipt.files.some(
      ({ file, size, sha256 }, i) =>
        file !== workbenchFiles[i] ||
        !Number.isSafeInteger(size) ||
        size < 0 ||
        (sha256 !== undefined && !/^[a-f0-9]{64}$/.test(sha256)),
    )
  )
    throw new Error('本机保存确认不完整，禁止清理远程文件');
  const proof = receipt.files.map(({ file, size, sha256 }) => {
    const lines = [
      'file="$JOB/' + file + '"; dc_file "$file"',
      '[ "$(stat -c%s -- "$file")" = ' + q(String(size)) + ' ]',
    ];
    if (sha256) lines.push('[ "$(dc_hash "$file")" = ' + q(sha256) + ' ]');
    return lines.join('\n');
  });
  return (
    workbenchHeader(target, receipt.owner) +
    hashScript +
    [
      'dc_path "$DIR"; dc_path "$JOB"; dc_path "$LOCK"',
      'if [ -e "$LOCK.released.$OWNER" ] || [ -L "$LOCK.released.$OWNER" ]; then dc_remove_retired; printf CLEANED; exit 0; fi',
      'if [ ! -e "$JOB" ] && [ ! -e "$LOCK" ]; then printf GONE; exit 0; fi',
      'if [ ! -e "$LOCK" ]; then dc_workspace; dc_acquire; fi',
      'dc_lock',
      'exec 9<"$LOCK"; flock -n 9',
      'dc_lock; [ "$(stat -Lc "%d:%i" -- "$LOCK")" = "$(stat -Lc "%d:%i" /proc/$$/fd/9)" ]',
      'for entry in "$LOCK"/*; do',
      '  case "$(basename -- "$entry")" in owner|created|cleanup) dc_file "$entry";; *) printf "UNEXPECTED\\t%q\\n" "$(basename -- "$entry")"; exit 1;; esac',
      'done',
      'if [ -e "$JOB" ]; then',
      '  dc_dir "$JOB"; dc_list',
      '  if [ "$(dc_value "$LOCK/cleanup" || true)" != "$OWNER" ]; then',
      '    dc_workspace; [ "$(dc_value "$JOB/state")" = ' + q(receipt.state) + ' ]',
      '    alive=0; dc_alive || alive=$?',
      '    [ "$alive" = 1 ] || { [ ' +
        q(receipt.state === 'CANCELLED' || receipt.state === 'FAILED' ? '1' : '0') +
        ' = 1 ] && [ ! -e "$JOB/pid" ] && [ ! -L "$JOB/pid" ]; }',
      ...proof,
      '    (umask 077; set -C; printf "%s" "$OWNER" > "$LOCK/cleanup")',
      '  elif [ -e "$JOB/task" ]; then dc_workspace; fi',
      '  dc_remove_files; dc_dir "$JOB"; rmdir -- "$JOB"',
      'else',
      '  [ "$(dc_value "$LOCK/cleanup")" = "$OWNER" ]',
      'fi',
      'dc_release',
      'printf CLEANED',
    ].join('\n')
  );
}
export async function cleanWorkbench(transport: Transport, target: Target, receipt: Receipt) {
  const result = await transport.exec('bash -s', {
    input: cleanupScript(target, receipt),
    timeout: 120000,
  });
  if (result.code || !['CLEANED', 'GONE'].includes(result.stdout.trim())) {
    const unexpected = result.stdout
      .split('\n')
      .filter((line) => line.startsWith('UNEXPECTED\t'))
      .map((line) => line.slice('UNEXPECTED\t'.length));
    throw new Error(
      unexpected.length
        ? '发现非预期文件，已保留：' + unexpected.join('、')
        : result.stderr.trim() || '远程校验或清理未完成',
    );
  }
}

/** 身份核对、进程状态和两份增量日志在一次连接中读取，不改变终态确认与清理规则。 */
export function workbenchPollScript(
  target: Target,
  owner: string,
  offsets: { journal: number; log: number },
) {
  for (const offset of [offsets.journal, offsets.log])
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('远端日志偏移无效');
  return (
    workbenchHeader(target, owner) +
    [
      'dc_verify',
      'dc_file "$JOB/journal"; dc_file "$JOB/output.log"',
      'state="$(dc_value "$JOB/state")"; alive=0; dc_alive || alive=$?',
      'js="$(stat -c%s -- "$JOB/journal")"; os="$(stat -c%s -- "$JOB/output.log")"',
      '[ "$js" -ge ' + offsets.journal + ' ] && [ "$os" -ge ' + offsets.log + ' ]',
      'jl=$((js - ' + offsets.journal + ')); ol=$((os - ' + offsets.log + '))',
      '[ "$jl" -le 262144 ] || jl=262144; [ "$ol" -le 262144 ] || ol=262144',
      'printf "%s\\t%s\\t%s\\t%s\\n" "$state" "$alive" "$jl" "$ol"',
      // head 读满约定长度后会主动关管道，tail 的 SIGPIPE 不表示日志读取失败。
      '( set +o pipefail; tail -c +' +
        (offsets.journal + 1) +
        ' -- "$JOB/journal" | head -c "$jl" )',
      '( set +o pipefail; tail -c +' +
        (offsets.log + 1) +
        ' -- "$JOB/output.log" | head -c "$ol" )',
    ].join('\n') +
    '\n'
  );
}

export function parseWorkbenchPoll(packet: Buffer) {
  const end = packet.indexOf(10);
  if (end < 0 || end > 120) throw new Error('远端任务状态响应无效');
  const [state, alive, a, b] = packet.subarray(0, end).toString('ascii').split('\t');
  const journalSize = Number(a),
    outputSize = Number(b);
  if (
    !/^[A-Z_]+$/.test(state) ||
    !['0', '1', '2'].includes(alive) ||
    !/^\d+$/.test(a || '') ||
    !/^\d+$/.test(b || '') ||
    journalSize > 262144 ||
    outputSize > 262144 ||
    packet.length !== end + 1 + journalSize + outputSize
  )
    throw new Error('远端任务状态或增量日志长度无效');
  return {
    state,
    alive: alive === '0',
    exited: alive === '1',
    journal: packet.subarray(end + 1, end + 1 + journalSize),
    output: packet.subarray(end + 1 + journalSize),
  };
}
