for name in mkdir cp chmod base64 nohup cat dirname rm rmdir sleep chown basename; do
  command -v "$name" >/dev/null || fail "服务器缺少命令 $name。请参照使用说明中的服务器要求。"
done
algorithm=none
if command -v sha256sum >/dev/null; then algorithm=sha256sum; elif command -v shasum >/dev/null; then algorithm=shasum; elif command -v openssl >/dev/null; then algorithm=openssl; fi
hash_file() { case "$algorithm" in sha256sum) sha256sum -- "$1" | awk '{print $1}';; shasum) shasum -a 256 -- "$1" | awk '{print $1}';; openssl) openssl dgst -sha256 "$1" | awk '{print $NF}';; none) printf '';; esac; }
if [ "$algorithm" = none ]; then [ "$ALLOW_WEAK" = 1 ] && [ "$MODE" = jar ] || fail '远端缺少 SHA-256 工具（sha256sum/shasum/openssl），Docker 必须保证容器内哈希校验'; fi
if [ "$MODE" = docker ]; then docker inspect "$CONTAINER" >/dev/null; fi
dc_path "$DIR" || fail '部署目录包含符号链接，或实际路径与配置不一致'
if [ ! -d "$DIR" ]; then [ "$CREATE_DIR" = 1 ] || fail '部署目录不存在，未允许创建'; mkdir -p -- "$DIR"; fi
[ -w "$DIR" ] || fail '部署目录不可写'
[ ! -L "$JAR" ] || fail '目标 JAR 是符号链接，请配置实际文件路径'
if [ -e "$JAR" ]; then [ -f "$JAR" ] && [ -r "$JAR" ] || fail '旧 JAR 不是可读普通文件'; fi
if ! dc_acquire 2>/dev/null; then
  fail '目标已有任务锁。请核实远程工作台，禁止交叉替换。'
fi
claimed=0
cleanup_failure() {
  code=$?
  if [ "$code" != 0 ] && [ "$claimed" = 0 ]; then dc_unlock || true; fi
}
trap cleanup_failure EXIT
shopt -s nullglob dotglob
dc_path "$JOB" || fail '远程工作台包含符号链接'
if [ -e "$JOB" ]; then
  dc_dir "$JOB" || fail '远程工作台目录归属不符'
  entries=("$JOB"/*)
  if [ "${#entries[@]}" -ne 0 ]; then
    for entry in "${entries[@]}"; do printf '工作台已有内容：%q\n' "${entry##*/}" >&2; done
    fail '远程工作台已有任务或未知文件，请先核实上一任务。'
  fi
  # 空挂载点无法 rmdir。重新在部署目录下创建，避免 mv 跨挂载点退化为复制。
  rmdir -- "$JOB" || fail '空工作台不能安全复用，可能是独立挂载点'
fi
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
umask 077
mkdir -m 700 -- "$JOB"
claimed=1
( set -C
  printf '%s\n%s\n' "$OWNER" "$TASK_INFO" > "$JOB/task"
  : > "$JOB/journal"
  : > "$JOB/output.log"
  printf 'PREPARED' > "$JOB/state"
)
printf 'old_exists=%s\nold_size=%s\nold_hash=%s\nold_mode=%s\nalgorithm=%s\n' "$old_exists" "$old_size" "$old_hash" "$old_mode" "$algorithm" > "$JOB/preflight"
printf '远端预检通过\n'
