# 状态探测只读。JAR 识别按 java -jar 后的文件名，不能据此断言没有其他启动方式。
probe() {
  if [ "$MODE" = docker ]; then
    local value running paused status restarts health started container
    # Docker 会对缺少的字段报错。没有 HEALTHCHECK 时，用 index 读取可选字段。
    value="$(timeout 8 docker inspect --type container --format '{{.State.Running}} {{.State.Paused}} {{.State.Status}} {{.RestartCount}} {{with index .State "Health"}}{{.Status}}{{else}}none{{end}} {{.State.StartedAt}} {{.Id}}' -- "$CONTAINER")" || return 1
    read -r running paused status restarts health started container <<< "$value"
    docker_id="$container"
    probe_restarts="$restarts"; probe_health="$health"; probe_started="$started"
    case "$running:$paused:$status" in
      true:false:running) service_state=running;;
      false:false:exited|false:false:created) service_state=stopped;;
      *) service_state=unknown;;
    esac
  else
    local value
    value="$(ps -eo pid=,etimes=,comm=,args= | awk '
      $3 == "java" {
        for (i=4; i<NF; i++) if ($i == "-jar") {
          file=$(i+1); sub(/^.*\//, "", file)
          if (file == ENVIRON["OPS_JAR"]) { print $1, $2 }
          break
        }
      }')" || return 1
    if [[ "$value" = *$'\n'* ]]; then service_state=unknown
    elif [ -z "$value" ]; then service_state=not-found
    else read -r probe_pid probe_age <<< "$value"; service_state=matched
    fi
  fi
}

status_result() {
  local locked=0
  if [ -e "$LOCK" ] || [ -L "$LOCK" ]; then locked=1; fi
  service_state=unknown
  probe || true
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$service_state" "$locked" "${probe_pid:-}" "${probe_age:-}" "${probe_restarts:-}" "${probe_health:-}" "${probe_started:-}"
}

run_operation() {
  local verdict=blocked message= code=0 initial_id= baseline= observed=0
  finish() {
    # 连接中断或命令超时时保留锁。由现有锁核实入口检查 PID 后处理。
    if [ "$verdict" != unknown ]; then
      if ! dc_lock || ! rm -f -- "$LOCK/pid" || ! dc_unlock; then
        verdict=unknown; message='远程任务锁释放失败，请先核实'
      fi
    fi
    printf '\n%s\t%s\t%s\n' "$MARKER" "$verdict" "$message"
  }
  reject() { printf '%s\tblocked\t%s\n' "$MARKER" "$1"; }
  [ -d "$DIR" ] && dc_path "$DIR" || { reject '部署目录不可用或包含链接'; return; }
  dc_acquire || { reject '目标已有任务锁，或无法创建目标锁'; return; }
  trap 'exit 129' HUP INT TERM PIPE
  exec 9<"$LOCK"
  flock -n 9 && dc_lock || { reject '无法持有目标任务锁'; return; }
  (umask 077; set -C; printf '%s %s %s\n' "$$" "$(dc_proc "$$")" "$(cat /proc/sys/kernel/random/boot_id)" > "$LOCK/pid") ||
    { verdict=unknown; message='无法记录远程进程身份'; finish; return; }
  cd -P -- "$DIR" && [ "$(pwd -P)" = "$DIR" ] || { message='部署目录变化'; finish; return; }
  if ! dc_path "$JOB" || { [ -e "$JOB" ] && { [ ! -d "$JOB" ] || entries=("$JOB"/*) && [ "${#entries[@]}" -gt 0 ]; }; }; then
    message='远程存在未收尾的部署工作台，请先核实'; finish; return
  fi
  if ! probe; then message='无法读取当前运行状态，请检查服务器和权限'; finish; return; fi
  case "$ACTION:$service_state" in
    start:stopped) ;;
    start:not-found) [ "$CONFIRM_STOPPED" = 1 ] || { message='未确认 JAR 服务已停止'; finish; return; };;
    stop:running|restart:running|stop:matched|restart:matched) ;;
    *) message='运行状态已变化或不明确，请刷新后重试'; finish; return;;
  esac
  initial_id="${docker_id:-}"
  printf '已取得目标任务锁，开始执行运维操作。\n'
  execute() {
    local command_code=0
    if [ "$MODE" = docker ]; then
      if [ "$1" = stop ]; then timeout --kill-after=5 "$LIMIT" docker stop --time 30 -- "$initial_id" || command_code=$?
      else timeout --kill-after=5 "$LIMIT" docker start -- "$initial_id" || command_code=$?; fi
    else
      # 命令配置来自已确认的目标。关闭锁描述符，避免常驻 Java 子进程继承。
      timeout --kill-after=5 "$LIMIT" bash -c "$2" 9<&- || command_code=$?
    fi
    return "$command_code"
  }
  verdict=unknown
  if [ "$ACTION" = stop ] || { [ "$ACTION" = restart ] && { [ "$MODE" = docker ] || [ -z "$RESTART" ]; }; }; then
    execute stop "$STOP" || code=$?
  fi
  if [ "$code" = 0 ] && [ "$ACTION" != stop ]; then
    if [ "$ACTION" = restart ] && [ "$MODE" != docker ] && [ -n "$RESTART" ]; then
      execute restart "$RESTART" || code=$?
    else execute start "$START" || code=$?; fi
  fi
  case "$code" in
    0) ;;
    124|137|143) message='命令超时或被中断，远程状态需要核实'; finish; return;;
    *) verdict=failed; message="远程命令退出码 $code，请查看执行日志并刷新状态"; finish; return;;
  esac
  printf '命令已返回，正在复查运行状态。\n'
  if [ "$ACTION" = stop ]; then
    if probe && [ "$MODE" = docker ] && [ "$service_state" = stopped ] && [ "$initial_id" = "$docker_id" ]; then
      verdict=success; message='容器已停止'
    elif [ "$MODE" = jar ] && [ "$service_state" = not-found ]; then
      verdict=unverified; message='停止命令已完成，未发现匹配进程'
    else verdict=failed; message='停止命令已返回，复查未确认停止'; fi
    finish; return
  fi
  probe || service_state=unknown
  baseline="${probe_restarts:-}"
  local begin=$SECONDS initial_pid= first_seen=0
  while :; do
    if [ "$MODE" = docker ]; then
      if ! probe || [ "$service_state" != running ] || [ "$initial_id" != "$docker_id" ] || [ "$baseline" != "$probe_restarts" ] || [ "$probe_health" = unhealthy ]; then
        verdict=failed; message='观察期内容器未保持稳定，请查看应用日志'; break
      fi
      if [ "$((SECONDS-begin))" -ge "$STABILITY" ]; then
        if [ "$probe_health" = healthy ]; then verdict=success; message='容器运行稳定，容器健康检查通过'
        else verdict=unverified; message='容器运行稳定，应用健康未验证'; fi
        break
      fi
    else
      if probe && [ "$service_state" = matched ]; then
        if [ "$observed" = 0 ]; then observed=1; initial_pid="$probe_pid"; first_seen=$SECONDS
        elif [ "$probe_pid" != "$initial_pid" ]; then verdict=failed; message='观察期内匹配进程发生变化'; break; fi
      elif [ "$observed" = 1 ]; then verdict=failed; message='观察期内匹配进程退出，请查看应用日志'; break; fi
      if { [ "$observed" = 1 ] && [ "$((SECONDS-first_seen))" -ge "$STABILITY" ]; } ||
         { [ "$observed" = 0 ] && [ "$((SECONDS-begin))" -ge "$STABILITY" ]; }; then
        verdict=unverified
        if [ "$observed" = 1 ]; then message='发现匹配进程，应用健康未验证'
        else message='未确认 Java 进程，应用健康未验证'; fi
        break
      fi
    fi
    sleep 1
  done
  finish
}
