#!/usr/bin/env bash

set -euo pipefail

if [[ $# -eq 0 ]]; then
  echo "usage: $0 <command> [args...]" >&2
  exit 2
fi
for command in docker dockerd sudo timeout readlink stat awk python3; do
  command -v "$command" >/dev/null || { echo "required command is missing: $command" >&2; exit 1; }
done
[[ -d "$RUNNER_TEMP" ]] || { echo 'RUNNER_TEMP must be an existing job directory' >&2; exit 1; }

current_cgroup="$(awk -F: '$1 == "0" && $2 == "" { print $3 }' /proc/self/cgroup)"
if [[ "$current_cgroup" != /* || "$current_cgroup" == / || "$current_cgroup" == *..* || "$current_cgroup" == *$'\n'* ]]; then
  echo 'Kata packaging requires an existing non-root cgroup-v2 parent' >&2
  exit 1
fi
# The process-bearing runner leaf cannot delegate cgroup-v2 controllers. Its
# immediate Pod parent already bounds the whole job and has no direct processes.
cgroup_parent="$(dirname "$current_cgroup")"
case "$cgroup_parent" in
  /kubepods/pod*|/kubepods/*/pod*) ;;
  *) echo 'Kata packaging requires its immediate Kubernetes Pod cgroup parent' >&2; exit 1 ;;
esac
cgroup_directory="/sys/fs/cgroup$cgroup_parent"
if [[ "$(stat -f -c %T "$cgroup_directory")" != cgroup2fs ]]; then
  echo 'Kata packaging requires the current cgroup-v2 hierarchy to be visible' >&2
  exit 1
fi
memory_limit="$(cat "$cgroup_directory/memory.max")"
read -r cpu_quota cpu_period <<< "$(cat "$cgroup_directory/cpu.max")"
leaf_memory="$(cat "/sys/fs/cgroup$current_cgroup/memory.max")"
read -r leaf_quota leaf_period <<< "$(cat "/sys/fs/cgroup$current_cgroup/cpu.max")"
if [[ ! "$memory_limit" =~ ^[1-9][0-9]*$ || ! "$cpu_quota" =~ ^[1-9][0-9]*$ || ! "$cpu_period" =~ ^[1-9][0-9]*$ ||
      ! "$leaf_memory" =~ ^[1-9][0-9]*$ || ! "$leaf_quota" =~ ^[1-9][0-9]*$ || ! "$leaf_period" =~ ^[1-9][0-9]*$ ]] ||
  ((memory_limit > leaf_memory || cpu_period != leaf_period || cpu_quota > leaf_quota)); then
  echo 'Kata packaging requires finite positive memory and CPU limits on its existing cgroup parent' >&2
  exit 1
fi
controllers=" $(cat "$cgroup_directory/cgroup.subtree_control") "
if [[ "$controllers" != *" cpu "* || "$controllers" != *" memory "* ||
      -n "$(cat "$cgroup_directory/cgroup.procs")" ]]; then
  echo 'The bounded Pod cgroup must already delegate CPU and memory with no direct processes' >&2
  exit 1
fi
readonly cgroup_parent
if [[ -e /run/containerd/containerd.sock || -L /run/containerd/containerd.sock ]]; then
  echo 'Refusing Docker auto-attachment to a pre-existing system containerd socket' >&2
  exit 1
fi

docker_cli="$(command -v docker)"
docker_daemon="$(command -v dockerd)"
daemon_entry="$(readlink -f "$docker_daemon")"
# nixpkgs wraps dockerd to expose its pinned containerd/runc dependencies.
daemon_binary="$(dirname "$(dirname "$daemon_entry")")/libexec/docker/dockerd"
[[ -x "$daemon_binary" ]] || daemon_binary="$daemon_entry"
# The pinned nixpkgs wrapper links containerd but omits its runc-v2 shim.
# containerd searches PATH before its own bin directory, so an ambient newer
# shim can speak an incompatible bootstrap protocol to the bundled daemon.
daemon_support="$(dirname "$daemon_binary")"
containerd_binary="$(readlink -f "$daemon_support/containerd")"
containerd_bin="$(dirname "$containerd_binary")"
containerd_shim="$containerd_bin/containerd-shim-runc-v2"
runc_binary="$(readlink -f "$daemon_support/runc")"
if [[ ! -x "$containerd_binary" || ! -x "$containerd_shim" || ! -x "$runc_binary" ]]; then
  echo 'Kata packaging requires the Docker-bundled containerd, runc-v2 shim, and runc' >&2
  exit 1
fi
readonly daemon_support containerd_binary containerd_bin containerd_shim runc_binary
printf 'Kata runtime provenance: dockerd=%s containerd=%s shim=%s runc=%s\n' \
  "$daemon_binary" "$containerd_binary" "$containerd_shim" "$runc_binary"
"$containerd_binary" --version
"$containerd_shim" --version
"$runc_binary" --version
state="$(mktemp -d "$RUNNER_TEMP/kata-docker.XXXXXX")"
docker_host="unix://$state/docker.sock"
docker_config="$state/client"
readonly docker_cli docker_daemon daemon_entry daemon_binary state docker_host docker_config
chmod 00700 "$state"
mkdir -p "$state/bin" "$state/client" "$state/tmp"
printf '{}\n' > "$state/daemon.json"
printf '{}\n' > "$state/client/config.json"

# All state, including managed containerd/runc state, belongs to this job. The
# daemon has no bridge or iptables access; containers use the runner Pod's network
# namespace. ARC does not use hostNetwork, a host socket, or a Docker sidecar.
export DOCKER_HOST="$docker_host"
export DOCKER_CONFIG="$docker_config"
unset DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH BUILDX_BUILDER BUILDKIT_HOST
{
  printf '#!/usr/bin/env bash\nset -euo pipefail\n'
  printf 'readonly docker_cli=%q docker_host=%q docker_config=%q docker_cgroup=%q\n' \
    "$docker_cli" "$docker_host" "$docker_config" "$cgroup_parent"
  cat <<'DOCKER_CLI'
unset DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH BUILDX_BUILDER BUILDKIT_HOST
configure_host_network() {
  local argument expects_network=false
  network_args=(--network=host)
  for argument; do
    if [[ "$expects_network" == true ]]; then
      [[ "$argument" == host ]] || { echo 'Kata packaging requires host networking inside its Pod' >&2; return 1; }
      network_args=()
      expects_network=false
      continue
    fi
    case "$argument" in
      --) break ;;
      --network|--net) expects_network=true ;;
      --network=*|--net=*)
        [[ "${argument#*=}" == host ]] || { echo 'Kata packaging requires host networking inside its Pod' >&2; return 1; }
        network_args=()
        ;;
    esac
  done
  [[ "$expects_network" == false ]] || { echo 'Kata packaging requires an explicit host network value' >&2; return 1; }
}
if [[ $# -gt 0 ]]; then
  case "$1" in
    run|build)
      subcommand="$1"
      shift
      configure_host_network "$@"
      exec "$docker_cli" --host "$docker_host" --config "$docker_config" \
        "$subcommand" "${network_args[@]}" --cgroup-parent="$docker_cgroup" "$@"
      ;;
    buildx)
      if [[ $# -gt 1 && "$2" == build ]]; then
        shift 2
        configure_host_network "$@"
        exec "$docker_cli" --host "$docker_host" --config "$docker_config" \
          buildx build "${network_args[@]}" --cgroup-parent="$docker_cgroup" "$@"
      fi
      ;;
  esac
fi
exec "$docker_cli" --host "$docker_host" --config "$docker_config" "$@"
DOCKER_CLI
} > "$state/bin/docker"
chmod 0755 "$state/bin/docker"

owned_pid=''
owned_starttime=''
observed_starttime=''
is_owned_daemon() {
  local candidate="$1" executable index process_stat
  local has_pidfile=false has_data_root=false has_cgroup=false
  local -a arguments=() stat_fields=()
  [[ "$candidate" =~ ^[1-9][0-9]*$ && -r "/proc/$candidate/cmdline" ]] || return 1
  executable="$(sudo -n "$(command -v readlink)" -f "/proc/$candidate/exe")" || return 1
  mapfile -d '' -t arguments < "/proc/$candidate/cmdline" || return 1
  if [[ "$executable" != "$daemon_binary" && "$executable" != "$daemon_entry" ]]; then
    # A shell entry point is supported for local development and focused fixtures.
    [[ "$executable" == "$(readlink -f "$BASH")" && "${arguments[1]:-}" == "$docker_daemon" ]] || return 1
  fi
  for ((index = 0; index + 1 < ${#arguments[@]}; index++)); do
    case "${arguments[index]}" in
      --pidfile)
        [[ "${arguments[index + 1]}" == "$state/dockerd.pid" ]] || return 1
        has_pidfile=true ;;
      --data-root)
        [[ "${arguments[index + 1]}" == "$state/data" ]] || return 1
        has_data_root=true ;;
      --cgroup-parent)
        [[ "${arguments[index + 1]}" == "$cgroup_parent" ]] || return 1
        has_cgroup=true ;;
    esac
  done
  [[ "$has_pidfile" == true && "$has_data_root" == true && "$has_cgroup" == true ]] || return 1
  read -r process_stat < "/proc/$candidate/stat" || return 1
  process_stat="${process_stat##*) }"
  read -r -a stat_fields <<< "$process_stat"
  [[ "${stat_fields[19]:-}" =~ ^[0-9]+$ ]] || return 1
  if [[ -n "$owned_pid" ]]; then
    [[ "$candidate" == "$owned_pid" && "${stat_fields[19]}" == "$owned_starttime" ]] || return 1
  fi
  observed_starttime="${stat_fields[19]}"
}

launcher_pid=''
cleanup() {
  local result=$?
  local daemon_pid="$owned_pid"
  trap - EXIT
  if [[ -z "$daemon_pid" && -s "$state/dockerd.pid" ]]; then
    read -r daemon_pid < "$state/dockerd.pid" || true
  fi
  if is_owned_daemon "$daemon_pid"; then
      owned_pid="$daemon_pid"
      owned_starttime="$observed_starttime"
      sudo -n "$BASH" -c 'kill -TERM "$1"' -- "$daemon_pid" || true
      for _ in $(seq 1 20); do
        is_owned_daemon "$daemon_pid" || break
        sleep 1
      done
      if is_owned_daemon "$daemon_pid"; then
        sudo -n "$BASH" -c 'kill -KILL "$1"' -- "$daemon_pid" || true
      fi
  fi
  if [[ -n "$launcher_pid" && -r "/proc/$launcher_pid/status" ]] &&
    [[ "$(awk '/^PPid:/ { print $2 }' "/proc/$launcher_pid/status")" == "$$" ]]; then
    kill -TERM "$launcher_pid" 2>/dev/null || true
  fi
  if [[ "$result" -ne 0 ]]; then
    tail -n 80 "$state/dockerd.log" >&2
  fi
  echo "Kata job runtime diagnostics: $state/dockerd.log"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

{
  # nixpkgs still prefixes its libexec directory, retaining its pinned runc;
  # this next directory supplies the matching runc-v2 shim before the base image.
  sudo -n env "PATH=$containerd_bin:$PATH" "DOCKER_TMPDIR=$state/tmp" "$docker_daemon" \
    --config-file "$state/daemon.json" \
    --host "$docker_host" --group "$(id -g)" \
    --data-root "$state/data" --exec-root "$state/exec" --pidfile "$state/dockerd.pid" \
    --storage-driver overlay2 --exec-opt native.cgroupdriver=cgroupfs --cgroup-parent "$cgroup_parent" \
    --bridge none --iptables=false --ip6tables=false --ip-forward=false \
    --ip-masq=false --userland-proxy=false --shutdown-timeout 15
} > "$state/dockerd.log" 2>&1 &
launcher_pid=$!

ready=false
startup_deadline=$((SECONDS + 90))
while ((SECONDS < startup_deadline)); do
  if ! kill -0 "$launcher_pid" 2>/dev/null; then
    echo 'The private Kata Docker runtime exited before readiness' >&2
    exit 1
  fi
  if [[ "$(timeout 2 "$docker_cli" --host "$docker_host" --config "$docker_config" info --format '{{.DockerRootDir}}' 2>/dev/null)" == "$state/data" ]]; then
    daemon_pid=''
    read -r daemon_pid < "$state/dockerd.pid" || true
    if ! is_owned_daemon "$daemon_pid"; then
      echo 'The private Kata Docker PID does not identify this job runtime' >&2
      exit 1
    fi
    owned_pid="$daemon_pid"
    owned_starttime="$observed_starttime"
    daemon_cgroup="$(awk -F: '$1 == "0" && $2 == "" { print $3 }' "/proc/$daemon_pid/cgroup")"
    if [[ "$daemon_cgroup" != "$cgroup_parent" && "$daemon_cgroup" != "$cgroup_parent/"* ]] ||
      [[ "$(timeout 2 "$docker_cli" --host "$docker_host" --config "$docker_config" info --format '{{.CgroupDriver}}:{{.CgroupVersion}}')" != cgroupfs:2 ]]; then
      echo 'The private Kata Docker runtime escaped its bounded cgroup-v2 parent' >&2
      exit 1
    fi
    ready=true
    break
  fi
  sleep 1
done
if [[ "$ready" != true ]]; then
  echo 'The private Kata Docker runtime did not become ready within its startup bound' >&2
  exit 1
fi

# Moby 28 can auto-attach to a system containerd. Require its generated private
# configuration and socket before allowing the upstream packager to run.
sudo -n "$(command -v python3)" - "$state" "$daemon_pid" <<'CONTAINERD_RECEIPT'
import os
from pathlib import Path
import stat
import sys
import tomllib

base = Path(sys.argv[1])
owner = os.stat('/proc/' + sys.argv[2]).st_uid
config_path = base / 'exec/containerd/containerd.toml'
socket_path = base / 'exec/containerd/containerd.sock'
system_socket = Path('/run/containerd/containerd.sock')
if system_socket.exists() or system_socket.is_symlink():
    raise SystemExit('Refusing an unexpected system containerd socket')
config = tomllib.loads(config_path.read_text())
expected = {
    'root': str(base / 'data/containerd/daemon'),
    'state': str(base / 'exec/containerd/daemon'),
}
for key, value in expected.items():
    if config.get(key) != value:
        raise SystemExit('Managed containerd ' + key + ' escaped private job storage')
if config.get('grpc', {}).get('address') != str(socket_path):
    raise SystemExit('Managed containerd address escaped its private job socket')
for path, expected_type in [(config_path, stat.S_ISREG), (socket_path, stat.S_ISSOCK)]:
    metadata = path.lstat()
    if metadata.st_uid != owner or not expected_type(metadata.st_mode):
        raise SystemExit('Managed containerd receipt has unexpected ownership or file type')
print('Verified private containerd configuration and socket')
CONTAINERD_RECEIPT

PATH="$state/bin:$PATH" "$@"
