set -Eeuo pipefail
if [ "${1:-}" != execute ]; then
  dc_verify
  [ "$(dc_value "$JOB/state")" = LAUNCHING ]
  dc_file "$JOB/output.log"
  umask 077
  (set -C; printf '%s %s %s\n' "$$" "$(dc_proc "$$")" "$(cat /proc/sys/kernel/random/boot_id)" > "$JOB/pid")
  # 子进程写完步骤、Docker 日志和终态后退出。只有监督进程能公开最终 state。
  bash "$JOB/runner.sh" execute > "$JOB/output.log" 2>&1 < /dev/null
  result="$(dc_value "$JOB/state.next")"
  dc_terminal "$result"
  mv -f -- "$JOB/state.next" "$JOB/state"
  exit 0
fi
dc_verify
dc_file "$JOB/preflight"
dc_file "$JOB/pid"
printf '%s %s %s\n' "$$" "$(dc_proc "$$")" "$(cat /proc/sys/kernel/random/boot_id)" >> "$JOB/pid"
source "$JOB/preflight"
critical=0; replaced=0; restart_baseline="$INITIAL_RESTARTS"; stopped=0; backup_created=0; current=verify
now_ms() { local value; value="$(date +%s%3N 2>/dev/null || true)"; if [[ "$value" =~ ^[0-9]{13}$ ]]; then printf '%s' "$value"; else printf '%s000' "$(date +%s)"; fi; }
event() { printf '%s\t%s\t%s\t%s\n' "$(now_ms)" "$1" "$2" "$3" >> "$JOB/journal"; }
state() { (set -C; printf '%s' "$1" > "$JOB/state.next") && mv -f -- "$JOB/state.next" "$JOB/state"; }
finish() { (set -C; printf '%s' "$1" > "$JOB/state.next"); }
hash_file() { case "$algorithm" in sha256sum) sha256sum -- "$1" | awk '{print $1}';; shasum) shasum -a 256 -- "$1" | awk '{print $1}';; openssl) openssl dgst -sha256 "$1" | awk '{print $NF}';; none) printf '';; esac; }
hash_stream() { case "$algorithm" in sha256sum) sha256sum | awk '{print $1}';; shasum) shasum -a 256 | awk '{print $1}';; openssl) openssl dgst -sha256 | awk '{print $NF}';; *) return 1;; esac; }
verify_file() { [ "$(stat -c%s -- "$1")" = "$2" ] || return 1; if [ "$algorithm" != none ]; then [ "$(hash_file "$1")" = "$3" ] || return 1; fi; }
check_cancel() { if [ "$critical" = 0 ] && [ -f "$JOB/cancel" ]; then event STATE task CANCELLED; finish CANCELLED; exit 0; fi; }
step() { check_cancel; current="$1"; shift; event STEP "$current" START; "$@"; event STEP "$current" OK; }
skip() { check_cancel; current="$1"; event STEP "$current" SKIP; }
run_custom() { timeout "$COMMAND_TIMEOUT" bash -c "$1"; }
stop_service() { stopped=1; if [ "$MODE" = docker ]; then timeout "$COMMAND_TIMEOUT" docker stop --time 30 "$CONTAINER"; elif [ "$old_exists" = 1 ] && [ -n "$STOP_CMD" ]; then if run_custom "$STOP_CMD"; then :; elif [ "$STOP_WARNING" = 1 ]; then printf '停止命令非零，按配置记录警告并继续\n'; else return 1; fi; fi; stopped=1; }
start_service() { if [ "$MODE" = docker ]; then timeout "$COMMAND_TIMEOUT" docker start "$CONTAINER"; restart_baseline="$(timeout "$COMMAND_TIMEOUT" docker inspect -f '{{.RestartCount}}' "$CONTAINER")"; else run_custom "${RESTART_CMD:-$START_CMD}"; fi; }
container_hash() { local expected="$1" actual; actual="$(timeout "$COMMAND_TIMEOUT" docker exec "$CONTAINER" sh -c 'command -v sha256sum >/dev/null || { printf "容器内缺少 sha256sum，不能完成最终校验\n" >&2; exit 1; }; sha256sum -- "$1"' _ "$CONTAINER_JAR" | awk '{print $1}')" || return 1; [ "$actual" = "$expected" ] || { printf '容器内 JAR 哈希不一致：expected=%s actual=%s\n' "$expected" "$actual" >&2; return 1; }; }
stability() {
  local start stamp running restarts health; start="$(date +%s)"
  while :; do
    running="$(timeout "$COMMAND_TIMEOUT" docker inspect -f '{{.State.Running}}' "$CONTAINER")" || return 1
    restarts="$(timeout "$COMMAND_TIMEOUT" docker inspect -f '{{.RestartCount}}' "$CONTAINER")" || return 1
    health="$(timeout "$COMMAND_TIMEOUT" docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CONTAINER")" || return 1
    [ "$running" = true ] && [ "$restarts" -eq "$restart_baseline" ] && { [ "$HEALTH_TYPE" != none ] || [ "$health" != unhealthy ]; } || return 1
    stamp=$(( $(date +%s) - start ))
    if [ "$stamp" -ge "$STABILITY_SECONDS" ] && { [ "$HEALTH_TYPE" != none ] || [ "$health" = none ] || [ "$health" = healthy ]; }; then return 0; fi
    [ "$stamp" -lt "$COMMAND_TIMEOUT" ] || return 1; sleep 1
  done
}
# 应用健康有独立启动窗口，不能被单条命令超时或旧重试次数提前截断。
container_ready() {
  [ "$MODE" != docker ] && return 0
  local status running restarts result remaining limit
  remaining=$((deadline - $(date +%s))); [ "$remaining" -gt 0 ] || return 1
  limit="$HEALTH_TIMEOUT"; [ "$remaining" -ge "$limit" ] || limit="$remaining"
  result="$(timeout "$limit" docker inspect -f '{{.State.Running}} {{.RestartCount}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CONTAINER")" || return 1
  read -r running restarts status <<< "$result"
  [ "$running" = true ] && [ "$restarts" -eq "$restart_baseline" ] && { [ "$status" = none ] || [ "$status" = healthy ]; }
}
health_check() {
  local attempt=0 code remaining limit deadline
  if [ "$HEALTH_DELAY" -gt 0 ]; then printf '启动等待 %s 秒后开始健康检查\n' "$HEALTH_DELAY"; sleep "$HEALTH_DELAY"; fi
  deadline=$(( $(date +%s) + HEALTH_WINDOW ))
  if [ "$HEALTH_LOCATION" = local ] && { [ "$HEALTH_TYPE" = http ] || [ "$HEALTH_TYPE" = tcp ]; }; then
    rm -f -- "$JOB/local-health"; state AWAITING_LOCAL
    # 为引擎轮询和结果写回留出传输余量，实际本机探测仍受 HEALTH_WINDOW 限制。
    while [ ! -f "$JOB/local-health" ]; do [ "$(date +%s)" -lt "$((deadline + 30))" ] || return 1; sleep 1; done
    [ "$(cat "$JOB/local-health")" = PASS ] || return 1
    while ! container_ready; do
      [ "$(date +%s)" -lt "$deadline" ] || return 1
      sleep 1
    done
    return 0
  fi
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if [ "$HEALTH_BY_WINDOW" != 1 ] && [ "$attempt" -ge "$HEALTH_RETRIES" ]; then break; fi
    attempt=$((attempt + 1)); remaining=$((deadline - $(date +%s))); limit="$HEALTH_TIMEOUT"
    [ "$remaining" -gt 0 ] || break
    [ "$remaining" -ge "$limit" ] || limit="$remaining"
    if [ "$HEALTH_TYPE" = http ]; then
      if code="$(curl --silent --show-error --max-time "$limit" -o /dev/null -w '%{http_code}' "$HEALTH_VALUE")" && [[ "$code" =~ ^2[0-9][0-9]$ ]] && container_ready; then return 0; fi
    elif [ "$HEALTH_TYPE" = tcp ]; then
      if timeout "$limit" bash -c 'exec 3<>"/dev/tcp/$1/$2"' _ "$TCP_HOST" "$TCP_PORT" && container_ready; then return 0; fi
    elif [ "$HEALTH_TYPE" = command ]; then
      if timeout "$limit" bash -c "$HEALTH_VALUE" && container_ready; then return 0; fi
    else return 0; fi
    printf '健康检查第 %s 次尚未就绪，继续等待\n' "$attempt"
    remaining=$((deadline - $(date +%s)))
    [ "$remaining" -gt 0 ] || break
    if [ "$HEALTH_BY_WINDOW" != 1 ] && [ "$attempt" -ge "$HEALTH_RETRIES" ]; then break; fi
    if [ "$remaining" -lt "$HEALTH_INTERVAL" ]; then sleep "$remaining"; else sleep "$HEALTH_INTERVAL"; fi
  done
  printf '健康检查等待结束，应用仍未就绪\n'; return 1
}
backup_old() {
  [ ! -e "$BACKUP" ] && [ ! -L "$BACKUP" ] || return 1
  cp -p -- "$JAR" "$BACKUP" || return 1
  verify_file "$BACKUP" "$old_size" "$old_hash" || return 1
  backup_created=1; event BACKUP "$old_size" "${old_hash:-none}"
}
restore_old() {
  if [ "$MODE" = docker ]; then timeout "$COMMAND_TIMEOUT" docker stop --time 30 "$CONTAINER" || return 1; elif [ -n "$STOP_CMD" ]; then run_custom "$STOP_CMD" || true; fi
  verify_file "$BACKUP" "$old_size" "$old_hash" || return 1
  [ ! -e "$RESTORE" ] && [ ! -L "$RESTORE" ] || return 1
  cp -p -- "$BACKUP" "$RESTORE" || return 1
  mv -f -- "$RESTORE" "$JAR" || return 1
  printf '旧 JAR 已恢复\n'
  if [ "$MODE" = docker ] && [ "$ORIGINAL_RUNNING" = false ]; then printf '已恢复旧 JAR，原容器为停止状态，保持停止\n'; return 0; fi
  start_service || return 1
  printf '旧服务启动命令成功\n'
  if [ "$MODE" = docker ]; then container_hash "$old_hash" || return 1; stability || return 1; fi
  if [ "$HEALTH_TYPE" != none ]; then health_check || return 1; fi
}
failure() {
  local code="$1"; trap - ERR; set +e
  event STEP "$current" FAIL; printf '步骤 %s 执行失败（退出码 %s）\n' "$current" "$code" >&2
  if [ "$replaced" = 1 ] && [ "$backup_created" = 1 ] && [ "$AUTO_ROLLBACK" = 1 ]; then
    event STEP rollback START
    if restore_old; then event STEP rollback OK; result=ROLLEDBACK; else event STEP rollback FAIL; result=ROLLBACK_FAILED; fi
  else
    if [ "$replaced" = 0 ] && [ "$stopped" = 1 ] && [ "$old_exists" = 1 ]; then
      printf '旧文件未被替换，尝试重新启动原服务\n'; if ! start_service; then printf '原服务恢复启动失败\n' >&2; fi
    fi
    result=FAILED
  fi
  if [ "$MODE" = docker ]; then printf '\n=== 失败时容器最近 200 行 ===\n'; timeout "$COMMAND_TIMEOUT" docker logs --tail 200 "$CONTAINER" 2>&1 || true; fi
  finish "$result"
  exit 0
}
trap 'failure "$?"' ERR
trap 'printf 1 > "$JOB/cancel"' TERM INT
state RUNNING
cd -- "$DIR"
[ "$(cat "$LOCK/owner")" = "$OWNER" ]
if [ "$MODE" = docker ]; then [ "$(timeout "$COMMAND_TIMEOUT" docker inspect -f '{{.Id}}' "$CONTAINER")" = "$CONTAINER_ID" ]; fi
dc_dir "$JOB"
[ "$(stat -c%d -- "$DIR")" = "$(stat -c%d -- "$JOB")" ]
dc_file "$STAGE"
step verify verify_file "$STAGE" "$NEW_SIZE" "$NEW_HASH"
if [ "$old_exists" = 1 ]; then verify_file "$JAR" "$old_size" "$old_hash"; else [ ! -e "$JAR" ]; fi
if [ "$BACKUP_ENABLED" = 1 ] && [ "$old_exists" = 1 ]; then step backup backup_old; else skip backup; fi
# 元数据在停服前设置，权限错误不能把线上服务提前停掉。
prepare_metadata() {
if [ "$old_exists" = 1 ]; then
  chmod "$old_mode" "$STAGE"
  owner="$(stat -c%u:%g -- "$JAR")"; current_owner="$(stat -c%u:%g -- "$STAGE")"
  if [ "$owner" != "$current_owner" ]; then chown "$owner" "$STAGE"; fi
else chmod 644 "$STAGE"; fi
}
step permissions prepare_metadata
check_cancel; critical=1
if [ "$MODE" = jar ] && [ "$old_exists" = 0 ]; then skip stop; else step stop stop_service; fi
current=replace; event STEP replace START; mv -f -- "$STAGE" "$JAR"; replaced=1; event STEP replace OK
if [ "$MODE" = jar ] && [ "$CHMOD_EXECUTABLE" = 1 ]; then step chmod chmod +x "$JAR"; fi
step start start_service
if [ "$MODE" = docker ]; then step containerHash container_hash "$NEW_HASH"; step stability stability; fi
if [ "$HEALTH_TYPE" = none ]; then skip health; finish UNVERIFIED; else step health health_check; finish SUCCESS; fi
