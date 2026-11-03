import { shellQuote, remoteJar, type ServerSnapshot, type Target } from './model';
/** 构建兼容只接受本次构建产生的有效文件，不能以旧 JAR 掩盖失败。 */
export function acceptBuild(
  result: {
    exitCode: number;
    successMarker: boolean;
    validJar: boolean;
    modified: number;
    started: number;
  },
  compatibility: boolean,
) {
  return (
    result.validJar &&
    result.modified > result.started &&
    (result.exitCode === 0 || (compatibility && result.successMarker))
  );
}
/** 字节数退化校验必须由目标策略及本次确认同时允许。 */
export function acceptUpload(
  local: { size: number; hash: string },
  remote: { size: number; hash?: string },
  policy: 'required' | 'size-confirm',
  confirmed: boolean,
) {
  if (local.size !== remote.size) return false;
  return remote.hash ? local.hash === remote.hash : policy === 'size-confirm' && confirmed;
}

export function diagnostics(server: ServerSnapshot, target: Target): string {
  const login =
    server.auth === 'alias'
      ? `ssh ${shellQuote(server.alias)}`
      : `ssh -p ${server.port} ${shellQuote(server.user + '@' + server.host)}`;
  const commands =
    target.mode === 'docker'
      ? `docker inspect ${shellQuote(target.container)}\ndocker logs --tail 200 ${shellQuote(target.container)}\nstat -- ${shellQuote(remoteJar(target))}`
      : `cd -- ${shellQuote(target.directory)}\nls -l -- ${shellQuote(target.fileName)}\n# 检查配置的启动命令及服务日志\n${target.start}`;
  return login + '\n' + commands;
}

/**
 * 检查普通 ZIP 或带启动脚本前缀的可执行 JAR 的结构与 Manifest。
 * 不解压、不执行，不替代真实引擎的 CRC、完整性和 JVM 兼容性检查；暂不接受 ZIP64/分卷。
 */
export function inspectJar(bytes: Uint8Array): { valid: boolean; reason: string } {
  const invalid = (reason: string) => ({ valid: false, reason });
  if (bytes.length < 22) return invalid('文件过短，不是完整 ZIP');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 65557); p--) {
    if (
      view.getUint32(p, true) === 0x06054b50 &&
      p + 22 + view.getUint16(p + 20, true) === bytes.length
    ) {
      end = p;
      break;
    }
  }
  if (end < 0) return invalid('缺少完整 ZIP 结束记录');
  const count = view.getUint16(end + 10, true),
    size = view.getUint32(end + 12, true),
    offset = view.getUint32(end + 16, true);
  if (
    view.getUint16(end + 4, true) ||
    view.getUint16(end + 6, true) ||
    view.getUint16(end + 8, true) !== count ||
    count === 65535 ||
    offset === 0xffffffff ||
    size === 0xffffffff
  )
    return invalid('不支持分卷或 ZIP64');
  const directory = end - size,
    base = directory - offset;
  if (directory < 0 || base < 0 || count === 0) return invalid('中央目录无效');
  let position = directory,
    manifest = false;
  for (let i = 0; i < count; i++) {
    if (position + 46 > end || view.getUint32(position, true) !== 0x02014b50)
      return invalid('中央目录头部无效');
    const nameLength = view.getUint16(position + 28, true),
      extra = view.getUint16(position + 30, true),
      comment = view.getUint16(position + 32, true);
    const next = position + 46 + nameLength + extra + comment,
      local = base + view.getUint32(position + 42, true),
      compressed = view.getUint32(position + 20, true);
    if (
      next > end ||
      local < base ||
      local + 30 > directory ||
      view.getUint32(local, true) !== 0x04034b50
    )
      return invalid('ZIP 文件头部或偏移无效');
    const localName = view.getUint16(local + 26, true),
      localExtra = view.getUint16(local + 28, true),
      dataStart = local + 30 + localName + localExtra;
    if (
      dataStart + compressed > directory ||
      localName !== nameLength ||
      view.getUint16(position + 8, true) & 1
    )
      return invalid('条目截断、名称不一致或已加密');
    const nameBytes = bytes.subarray(position + 46, position + 46 + nameLength);
    if (!nameBytes.every((v, index) => bytes[local + 30 + index] === v))
      return invalid('文件名与中央目录不一致');
    if (
      new TextDecoder().decode(nameBytes) === 'META-INF/MANIFEST.MF' &&
      view.getUint32(position + 24, true) > 0
    )
      manifest = true;
    position = next;
  }
  if (position !== end) return invalid('中央目录长度不匹配');
  return manifest
    ? { valid: true, reason: 'ZIP 结构与非空 Manifest 存在' }
    : invalid('缺少非空 META-INF/MANIFEST.MF');
}
export const acceptJar = (bytes: Uint8Array) => inspectJar(bytes).valid;
