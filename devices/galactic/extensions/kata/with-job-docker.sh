#!/usr/bin/env bash

set -euo pipefail

if [[ $# -eq 0 ]]; then
  echo "usage: $0 <command> [args...]" >&2
  exit 2
fi
for command in docker dockerd sudo timeout; do
  command -v "$command" >/dev/null || { echo "required command is missing: $command" >&2; exit 1; }
done
[[ -d "$RUNNER_TEMP" ]] || { echo 'RUNNER_TEMP must be an existing job directory' >&2; exit 1; }

docker_cli="$(command -v docker)"
docker_daemon="$(command -v dockerd)"
state="$(mktemp -d "$RUNNER_TEMP/kata-docker.XXXXXX")"
readonly docker_cli docker_daemon state
chmod 00700 "$state"
mkdir -p "$state/bin" "$state/client" "$state/tmp"
printf '{}\n' > "$state/daemon.json"
printf '{}\n' > "$state/client/config.json"

# All state, including managed containerd/runc state, belongs to this job. The
# daemon has no bridge or iptables access; containers use the runner Pod's network
# namespace. ARC does not use hostNetwork, a host socket, or a Docker sidecar.
export DOCKER_HOST="unix://$state/docker.sock"
export DOCKER_CONFIG="$state/client"
export KATA_JOB_DOCKER_CLI="$docker_cli"
unset DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH BUILDX_BUILDER BUILDKIT_HOST
cat > "$state/bin/docker" <<'DOCKER_CLI'
#!/usr/bin/env bash
set -euo pipefail
if [[ $# -gt 0 ]]; then
  case "$1" in
    run|build)
      subcommand="$1"
      shift
      exec "$KATA_JOB_DOCKER_CLI" "$subcommand" --network=host "$@"
      ;;
    buildx)
      if [[ $# -gt 1 && "$2" == build ]]; then
        shift 2
        exec "$KATA_JOB_DOCKER_CLI" buildx build --network=host "$@"
      fi
      ;;
  esac
fi
exec "$KATA_JOB_DOCKER_CLI" "$@"
DOCKER_CLI
chmod 0755 "$state/bin/docker"

launcher_pid=''
cleanup() {
  local result=$?
  local daemon_pid=''
  trap - EXIT
  if [[ -s "$state/dockerd.pid" ]]; then
    read -r daemon_pid < "$state/dockerd.pid" || true
    if [[ "$daemon_pid" =~ ^[1-9][0-9]*$ && -d "/proc/$daemon_pid" ]]; then
      sudo -n "$BASH" -c 'kill -TERM "$1"' -- "$daemon_pid" || true
      for _ in $(seq 1 20); do
        [[ -d "/proc/$daemon_pid" ]] || break
        sleep 1
      done
      if [[ -d "/proc/$daemon_pid" ]]; then
        sudo -n "$BASH" -c 'kill -KILL "$1"' -- "$daemon_pid" || true
      fi
    fi
  fi
  if [[ -n "$launcher_pid" ]] && kill -0 "$launcher_pid" 2>/dev/null; then
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
  sudo -n env "PATH=$PATH" "DOCKER_TMPDIR=$state/tmp" "$docker_daemon" \
    --config-file "$state/daemon.json" \
    --host "$DOCKER_HOST" --group "$(id -g)" \
    --data-root "$state/data" --exec-root "$state/exec" --pidfile "$state/dockerd.pid" \
    --storage-driver overlay2 --exec-opt native.cgroupdriver=cgroupfs \
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
  if [[ "$(timeout 2 "$docker_cli" info --format '{{.DockerRootDir}}' 2>/dev/null)" == "$state/data" ]]; then
    ready=true
    break
  fi
  sleep 1
done
if [[ "$ready" != true ]]; then
  echo 'The private Kata Docker runtime did not become ready within its startup bound' >&2
  exit 1
fi

PATH="$state/bin:$PATH" "$@"
