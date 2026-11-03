set -Eeuo pipefail
fail() { printf '%s\n' "$*" >&2; exit 1; }
for name in bash mkdir cp mv chmod stat df awk base64 tail head nohup timeout cat dirname readlink rm rmdir date sleep chown; do command -v "$name" >/dev/null || fail "远端缺少命令：$name"; done
if [ ! -d "$DIR" ]; then [ "$CREATE_DIR" = 1 ] || fail '部署目录不存在，未允许创建'; mkdir -p -- "$DIR"; fi
[ -w "$DIR" ] || fail '部署目录不可写'
[ ! -L "$JAR" ] || fail '目标 JAR 是符号链接，请配置实际文件路径'
if [ -e "$JAR" ]; then [ -f "$JAR" ] && [ -r "$JAR" ] || fail '旧 JAR 不是可读普通文件'; fi
if ! mkdir -- "$LOCK" 2>/dev/null; then fail "已有任务锁，持有者=$(cat "$LOCK/owner" 2>/dev/null || true)，时间=$(cat "$LOCK/created" 2>/dev/null || true)，禁止交叉替换：$LOCK"; fi
printf '%s' "$OWNER" > "$LOCK/owner"; date +%s > "$LOCK/created"
cleanup_failure() { code=$?; if [ "$code" != 0 ] && [ "$(cat "$LOCK/owner" 2>/dev/null || true)" = "$OWNER" ]; then rm -f -- "$LOCK/owner" "$LOCK/created"; rmdir -- "$LOCK" 2>/dev/null || true; fi; }
trap cleanup_failure EXIT
root="$(dirname "$JOB")"
[ ! -L "$root" ] || fail '任务目录不能是符号链接'
mkdir -p -- "$root"; [ -O "$root" ] || fail '任务目录不属于当前用户'; chmod 700 "$root"
mkdir -m 700 -- "$JOB"
algorithm=none
if command -v sha256sum >/dev/null; then algorithm=sha256sum; elif command -v shasum >/dev/null; then algorithm=shasum; elif command -v openssl >/dev/null; then algorithm=openssl; fi
hash_file() { case "$algorithm" in sha256sum) sha256sum -- "$1" | awk '{print $1}';; shasum) shasum -a 256 -- "$1" | awk '{print $1}';; openssl) openssl dgst -sha256 "$1" | awk '{print $NF}';; none) printf '';; esac; }
if [ "$algorithm" = none ]; then [ "$ALLOW_WEAK" = 1 ] && [ "$MODE" = jar ] || fail '远端缺少 SHA-256 工具（sha256sum/shasum/openssl），Docker 必须保证容器内哈希校验'; fi
old_exists=0; old_size=0; old_hash=''; old_mode=644
if [ -f "$JAR" ]; then old_exists=1; old_size="$(stat -c%s -- "$JAR")"; old_hash="$(hash_file "$JAR")"; old_mode="$(stat -c%a -- "$JAR")"; fi
required=$(( (NEW_SIZE * 2 + old_size + 10485760 + 1023) / 1024 ))
available="$(df -Pk -- "$DIR" | awk 'END {print $4}')"
[[ "$available" =~ ^[0-9]+$ ]] && [ "$available" -ge "$required" ] || fail '部署分区可用空间不足'
if [ "$BACKUP_ENABLED" = 1 ] && [ "$old_exists" = 1 ]; then
  [ ! -e "$BACKUP" ] && [ ! -L "$BACKUP" ] || fail "备份名称已存在，拒绝覆盖：$BACKUP"
  parent="$(dirname "$BACKUP")"; mkdir -p -- "$parent"; [ -w "$parent" ] || fail '备份目录不可写'
  available="$(df -Pk -- "$parent" | awk 'END {print $4}')"; required=$(( (old_size + 10485760 + 1023) / 1024 ))
  [[ "$available" =~ ^[0-9]+$ ]] && [ "$available" -ge "$required" ] || fail '备份分区可用空间不足'
fi
if [ "$MODE" = docker ]; then command -v docker >/dev/null || fail '远端未安装 Docker'; command -v tar >/dev/null || fail '容器内校验需要宿主机 tar'; docker inspect "$CONTAINER" >/dev/null; fi
if [ "$HEALTH_TYPE" = http ] && [ "$HEALTH_LOCATION" != local ]; then command -v curl >/dev/null || fail 'HTTP 健康检查需要 curl'; fi
printf 'old_exists=%s\nold_size=%s\nold_hash=%s\nold_mode=%s\nalgorithm=%s\n' "$old_exists" "$old_size" "$old_hash" "$old_mode" "$algorithm" > "$JOB/preflight"
printf 'PREPARED' > "$JOB/state"
printf '远端预检通过\n'
