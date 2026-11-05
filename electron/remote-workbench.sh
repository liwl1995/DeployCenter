# 所有读取和清理都在预期目录内进行；不跟随工作台或其文件的符号链接。
dc_path() { [ "$(readlink -m -- "$1")" = "$1" ] && [ ! -L "$1" ]; }
dc_dir() { dc_path "$1" && [ -d "$1" ] && [ -O "$1" ]; }
dc_file() { [ -f "$1" ] && [ ! -L "$1" ] && [ -O "$1" ]; }
dc_value() { dc_file "$1" && cat -- "$1"; }
dc_task() { dc_file "$JOB/task" && IFS= read -r dc_owner < "$JOB/task" && printf '%s' "$dc_owner"; }
dc_terminal() {
  case "$1" in SUCCESS|UNVERIFIED|FAILED|ROLLEDBACK|ROLLBACK_FAILED|CANCELLED) return 0;; *) return 1;; esac
}
dc_proc() {
  local stat rest
  stat="$(cat "/proc/$1/stat" 2>/dev/null)" || return 1
  rest="${stat##*) }"
  set -- $rest
  [ "$#" -ge 20 ] && [ "$1" != Z ] && [ "$1" != X ] || return 1
  printf '%s' "${20}"
}
# 0 为原进程仍在，1 为已退出，2 为证据不足。PID 与启动时钟均来自同一次启动。
dc_alive() {
  local pid start boot extra current count=0 live=1
  dc_file "$JOB/pid" || return 2
  current="$(cat /proc/sys/kernel/random/boot_id)" || return 2
  while read -r pid start boot extra; do
    count=$((count + 1))
    [[ "$pid" =~ ^[0-9]+$ && "$start" =~ ^[0-9]+$ && "$boot" =~ ^[0-9a-f-]{36}$ && -z "$extra" ]] || return 2
    [ "$current" = "$boot" ] || continue
    if [ -e "/proc/$pid/stat" ] && [ ! -r "/proc/$pid/stat" ]; then return 2; fi
    if [ "$(dc_proc "$pid")" = "$start" ]; then live=0; fi
  done < "$JOB/pid"
  [ "$count" -ge 1 ] && [ "$count" -le 2 ] || return 2
  return "$live"
}
dc_lock() { dc_dir "$LOCK" && [ "$(dc_value "$LOCK/owner")" = "$OWNER" ]; }
dc_workspace() { dc_dir "$JOB" && [ "$(dc_task)" = "$OWNER" ]; }
dc_verify() { dc_path "$DIR" && dc_lock && dc_workspace; }
# 名单以外的项目（包括同名链接、目录、设备）一律阻止清理，打印可读名称供核对。
dc_list() {
  local entry name ok=0
  for entry in "$JOB"/*; do
    name="${entry##*/}"
    case "$name" in
      task|runner.sh|preflight|state|state.next|pid|journal|output.log|upload.jar|restore.jar|cancel|local-health)
        if dc_file "$entry"; then continue; fi;;
    esac
    printf 'UNEXPECTED\t%q\n' "$name"; ok=1
  done
  return "$ok"
}
dc_acquire() {
  mkdir -m 700 -- "$LOCK" || return 1
  (umask 077; set -C; printf '%s' "$OWNER" > "$LOCK/owner" && date +%s > "$LOCK/created")
}
dc_unlock() {
  dc_lock || return 1
  rm -f -- "$LOCK/created" "$LOCK/owner"
  rmdir -- "$LOCK"
}

# 进入已核对的实际目录后才按相对路径删除，避免父目录被换成链接时跟随到别处。
dc_remove_files() (
  local expected="$JOB" entry
  cd -P -- "$expected"
  [ "$(pwd -P)" = "$expected" ] || exit 1
  JOB=.
  dc_list
  if [ -e ./task ]; then [ "$(dc_task)" = "$OWNER" ] || exit 1; fi
  for entry in ./*; do
    [ "$entry" = ./task ] || { dc_file "$entry"; rm -- "$entry"; }
  done
  if [ -e ./task ]; then
    [ "$(dc_task)" = "$OWNER" ] || exit 1
    rm -- ./task
  fi
)

# 原子移开旧锁后再删除其已知元数据；断线也不会留下一个无法识别的空任务锁。
dc_remove_retired() (
  local retired="$LOCK.released.$OWNER" entry
  dc_path "$retired" || exit 1
  if [ ! -e "$retired" ]; then exit 0; fi
  dc_dir "$retired" || exit 1
  cd -P -- "$retired"
  [ "$(pwd -P)" = "$retired" ] || exit 1
  local entries=(./*)
  if [ "${#entries[@]}" -gt 0 ]; then
    [ "$(dc_value ./owner)" = "$OWNER" ] || exit 1
    for entry in "${entries[@]}"; do
      case "$entry" in ./owner|./created|./cleanup) dc_file "$entry" || exit 1;; *) exit 1;; esac
    done
    rm -f -- ./created ./cleanup
    rm -- ./owner
  fi
  cd -P -- "$DIR"
  dc_dir "$retired" && rmdir -- "$retired"
)
dc_release() {
  dc_lock || return 1
  local retired="$LOCK.released.$OWNER"
  dc_path "$retired" && [ ! -e "$retired" ] || return 1
  mv -T -- "$LOCK" "$retired" || return 1
  dc_remove_retired
}
