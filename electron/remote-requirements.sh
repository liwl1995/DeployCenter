# 仅执行只读探测，必须在创建目录和写入工作台之前运行。
fail() { printf '%s\n' "$*" >&2; exit 1; }
for name in readlink stat date df awk mv head tail timeout flock; do
  command -v "$name" >/dev/null || fail "服务器缺少命令 $name。请参照使用说明中的服务器要求。"
done
gnu_required() {
  fail "服务器的 $1 不支持所需用法，需要 GNU coreutils。精简的 Alpine、BusyBox 环境不受支持。"
}
[[ "$(readlink -m -- /proc/../.deploy-center-preflight 2>/dev/null)" = /.deploy-center-preflight ]] ||
  gnu_required 'readlink -m'
stat_fields="$(stat -c '%s %a %d %u:%g' -- /dev/null 2>/dev/null)" &&
  [[ "$stat_fields" =~ ^[0-9]+\ [0-7]+\ [0-9]+\ [0-9]+:[0-9]+$ ]] || gnu_required 'stat -c'
proc_identity="$(stat -Lc '%d:%i' -- "/proc/$$" 2>/dev/null)" &&
  [[ "$proc_identity" =~ ^[0-9]+:[0-9]+$ ]] || {
    [ -r "/proc/$$/stat" ] || fail '服务器未提供可读取的 Linux /proc，无法核对远程进程身份。'
    gnu_required 'stat -Lc'
  }
milliseconds="$(date +%s%3N 2>/dev/null)" &&
  [[ "$milliseconds" =~ ^[0-9]{13}$ ]] || gnu_required 'date +%s%3N'
available_kb="$(df -Pk -- / 2>/dev/null | awk 'END {print $4}')" &&
  [[ "$available_kb" =~ ^[0-9]+$ ]] || gnu_required 'df -Pk'
mv_options="$(LC_ALL=C mv -T --version 2>/dev/null)" &&
  [[ "$mv_options" = *'GNU coreutils'* ]] || gnu_required 'mv -T'
[[ "$(printf abc | tail -c +2 2>/dev/null | head -c 1 2>/dev/null)" = b ]] ||
  gnu_required 'tail -c +N / head -c N'
timeout 2 bash -c ':' >/dev/null 2>&1 || gnu_required 'timeout'
[ -r /proc/sys/kernel/random/boot_id ] && [ -r "/proc/$$/stat" ] ||
  fail '服务器未提供可读取的 Linux /proc，无法核对远程进程身份。'
# 使用当前 shell 的 proc 文件作只读锁探测，避免在服务器创建测试文件。
( exec 9<"/proc/$$/stat"; flock -s -n 9 ) 2>/dev/null ||
  fail '服务器的 flock 不支持所需的文件描述符锁，请安装 util-linux 并启用文件锁。'
if [ "$MODE" = docker ]; then
  command -v docker >/dev/null || fail '服务器未安装 Docker'
  command -v tar >/dev/null || fail 'Docker 部署需要宿主机安装 tar'
fi
if [ "$HEALTH_TYPE" = http ] && [ "$HEALTH_LOCATION" != local ]; then
  command -v curl >/dev/null || fail '服务器上的 HTTP 健康检查需要 curl'
fi
