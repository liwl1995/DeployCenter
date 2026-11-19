import { shellQuote as q } from '../src/model';
import { imageIdentities, imageSize } from '../src/images';
import type { ImageCheck, ImagePackage } from '../src/images';
import type { Transport } from './ssh';

const preamble = `set -eu
export LC_ALL=C
case "$HOME" in /*) ;; *) echo 'SSH 登录目录不是绝对路径' >&2; exit 1;; esac
cd -P -- "$HOME"
home="$(pwd -P)"
base="$home/.deploy-center"
imports="$base/image-imports"
for dir in "$base" "$imports"; do
  if [ -L "$dir" ] || { [ -e "$dir" ] && [ ! -d "$dir" ]; }; then
    echo '镜像临时路径异常' >&2; exit 1
  fi
done`;

function expect(result: Awaited<ReturnType<Transport['exec']>>, label: string) {
  if (result.code)
    throw new Error(`${label}：${(result.stderr || result.stdout).trim() || '远程命令失败'}`);
  return result.stdout.trim();
}

/** 标签查询区分 Docker 命令失败和不存在；检查和加载必须指向服务器本机的引擎。 */
const docker = 'docker --host unix:///var/run/docker.sock';
const listRef = (ref: string) =>
  `${docker} image ls --no-trunc --format '{{.ID}}' --filter ${q('reference=' + ref)}`;

export async function checkImageImport(
  t: Transport,
  server: string,
  archive: ImagePackage,
): Promise<ImageCheck> {
  const response = expect(
    await t.exec(
      `${preamble}
for command in docker sha256sum df awk flock; do
  command -v "$command" >/dev/null || { echo "服务器缺少 $command" >&2; exit 1; }
done
dest="$home"
[ ! -d "$base" ] || dest="$base"
[ ! -d "$imports" ] || dest="$imports"
[ -w "$dest" ] || { echo '镜像临时目录不可写' >&2; exit 1; }
engine="$(${docker} info --format '{{.OSType}}/{{.Architecture}}')"
space="$(df -Pk -- "$dest" | awk 'END{print $4}')"
image="$(${listRef(archive.reference)})"
printf '%s\n' "$imports" "$engine" "$space" "$image"`,
      { timeout: 30_000 },
    ),
    '导入前检查失败',
  );
  const [remoteDirectory, engine, space, present, extra] = response.split('\n');
  if (
    !remoteDirectory?.startsWith('/') ||
    !remoteDirectory.endsWith('/.deploy-center/image-imports') ||
    !/^\d+$/.test(space || '') ||
    extra !== undefined ||
    (present && !/^sha256:[a-f0-9]{64}$/.test(present))
  )
    throw new Error('无法解析服务器 Docker 或磁盘信息');
  const platform = engine?.replace(/\/x86_64$/, '/amd64').replace(/\/aarch64$/, '/arm64');
  if (platform !== archive.platform)
    throw new Error(`服务器平台为 ${platform || '未知'}，镜像包需要 ${archive.platform}`);
  if (present && !imageIdentities(archive).includes(present))
    throw new Error(`服务器上已有不同的 ${archive.reference}，请换一个标签再尝试`);
  const free = Number(space) * 1024;
  if (!Number.isSafeInteger(free) || (!present && free < archive.size))
    throw new Error(
      `远程临时目录空间不足。镜像包 ${imageSize(archive.size)}，可用 ${imageSize(free)}`,
    );
  return { server, archive, remoteDirectory, free, alreadyPresent: !!present };
}

export async function createImageUpload(
  t: Transport,
  remoteDirectory: string,
  id: string,
  compressed: boolean,
) {
  const file = compressed ? 'image.tar.gz' : 'image.tar';
  const result = await t.exec(
    `${preamble}
[ "$imports" = ${q(remoteDirectory)} ] || exit 1
umask 077
mkdir -p -- "$imports"
mkdir -- "$imports/"${q(id)}
printf '%s/%s/%s' "$imports" ${q(id)} ${q(file)}`,
    { timeout: 30_000 },
  );
  const expected = remoteDirectory + '/' + id + '/' + file;
  if (expect(result, '无法创建服务器临时目录') !== expected)
    throw new Error('服务器返回的临时路径与预期不一致');
  return expected;
}

const ownedFile = (file: string) => {
  const dir = file.slice(0, file.lastIndexOf('/'));
  return `${preamble}
file=${q(file)}
dir=${q(dir)}
[ "${'$'}{dir%/*}" = "$imports" ] && [ ! -L "$dir" ] && [ -d "$dir" ] && [ ! -L "$file" ] ||
  { echo '服务器临时路径已变化' >&2; exit 1; }`;
};

export async function verifyUploadedImage(t: Transport, remote: string, hash: string) {
  expect(
    await t.exec(
      `${ownedFile(remote)}
[ -f "$file" ]
actual="$(sha256sum < "$file")"
[ "${'$'}{actual%% *}" = ${q(hash)} ] || { echo '上传文件 SHA-256 不一致' >&2; exit 1; }`,
      { timeout: 30 * 60_000 },
    ),
    '上传校验失败',
  );
}

export async function loadRemoteImage(
  t: Transport,
  remote: string,
  archive: ImagePackage,
  onLog: (text: string) => void,
) {
  const channel = await t.channel(`${ownedFile(remote)}
[ -f "$file" ]
exec 8<"$imports"
flock -x -w 30 8
current="$(${listRef(archive.reference)})"
case "$current" in ${imageIdentities(archive).map(q).join('|')}) echo '服务器已存在相同镜像，跳过加载'; exit 0;; esac
[ -z "$current" ] || { echo '导入期间出现同名不同镜像，已停止加载' >&2; exit 1; }
${docker} image load --input "$file"`);
  channel.output.setEncoding('utf8').on('data', onLog);
  channel.error.setEncoding('utf8').on('data', onLog);
  channel.input.end();
  const timeout = setTimeout(() => channel.stop(), 60 * 60_000);
  try {
    if ((await channel.done) !== 0) throw new Error('镜像加载未确认完成，请查看日志');
  } finally {
    clearTimeout(timeout);
  }
}

export async function verifyRemoteImage(t: Transport, archive: ImagePackage) {
  const result = expect(
    await t.exec(
      `${docker} image inspect --format '{{.Id}} {{.Os}}/{{.Architecture}}' ${q(archive.reference)}`,
      { timeout: 60_000 },
    ),
    '无法核验服务器镜像',
  );
  const [id, platform] = result.split(' ');
  if (platform !== archive.platform || !imageIdentities(archive).includes(id))
    throw new Error('服务器上的镜像 ID 或平台与上传的镜像包不一致');
  return id;
}

export async function cleanImageUpload(t: Transport, remote: string) {
  expect(
    await t.exec(
      `${ownedFile(remote)}
[ ! -e "$file" ] || [ -f "$file" ]
rm -f -- "$file"
rmdir -- "$dir"`,
      { timeout: 30_000 },
    ),
    '远程临时包待清理',
  );
}
