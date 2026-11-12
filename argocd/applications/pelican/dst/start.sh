#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# An alternate cluster is used only for isolated, explicitly offline validation.
cluster_name=${1:-server}
[[ "$cluster_name" =~ ^[a-zA-Z0-9_-]+$ ]] || exit 64
root=$PWD
cluster="$root/DoNotStarveTogether/config/$cluster_name"
test -f "$cluster/cluster.ini"
if ! grep -Eq '^[[:space:]]*offline_cluster[[:space:]]*=[[:space:]]*true[[:space:]]*$' "$cluster/cluster.ini"; then
  if [[ ! -s "$cluster/cluster_token.txt" ]]; then
    printf '%s\n' 'Klei token required: upload cluster_token.txt to DoNotStarveTogether/config/server, then start again.' >&2
    exit 64
  fi
fi

runtime=$(mktemp -d /tmp/dst-console.XXXXXX)
mkfifo "$runtime/master" "$runtime/caves"
exec 3<>"$runtime/master" 4<>"$runtime/caves" 5<&0
master_pid= caves_pid= console_pid=
cleanup() {
  trap - EXIT INT TERM
  [[ -z "$console_pid" ]] || kill "$console_pid" 2>/dev/null || true
  printf 'c_shutdown()\n' >&3 || true
  printf 'c_shutdown()\n' >&4 || true
  # Give both shards a bounded opportunity to save before terminating stragglers.
  for _ in {1..25}; do
    alive=false
    for pid in "$master_pid" "$caves_pid"; do
      if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then alive=true; fi
    done
    "$alive" || break
    sleep 1
  done
  for pid in "$master_pid" "$caves_pid"; do
    [[ -z "$pid" ]] || kill -TERM "$pid" 2>/dev/null || true
  done
  exec 3>&- 4>&- 5<&-
  rm -rf -- "$runtime"
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
cd "$root/bin64"
common=(-console -bind_ip 0.0.0.0 -persistent_storage_root "$root/DoNotStarveTogether" -conf_dir config -cluster "$cluster_name")
./dontstarve_dedicated_server_nullrenderer_x64 "${common[@]}" -port 10999 -shard Master <&3 3>&- 4>&- 5<&- &
master_pid=$!
./dontstarve_dedicated_server_nullrenderer_x64 "${common[@]}" -port 11000 -shard Caves <&4 3>&- 4>&- 5<&- &
caves_pid=$!
while IFS= read -r command; do printf '%s\n' "$command" >&3; done <&5 &
console_pid=$!

# Either shard exiting stops the pair; a failed cave must not leave a half-world running.
set +e
wait -n "$master_pid" "$caves_pid"
result=$?
set -e
exit "$result"
