#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
config="$repo_root/argocd/applications/bayn/squid.conf"
manifest="$repo_root/argocd/applications/bayn/egress-proxy.yaml"
image="$(awk '/image: docker.io\/ubuntu\/squid@sha256:/ {print $2}' "$manifest")"
[[ "$image" =~ ^docker.io/ubuntu/squid@sha256:[0-9a-f]{64}$ ]]
docker info >/dev/null

scratch="$(mktemp -d)"
container="bayn-proxy-restart-$$"
cleanup() {
  docker rm --force "$container" >/dev/null 2>&1 || true
  rm -rf "$scratch"
}
trap cleanup EXIT
mkdir "$scratch/run"
chmod 777 "$scratch" "$scratch/run"
printf '1\n' >"$scratch/run/squid.pid"
chmod 666 "$scratch/run/squid.pid"

docker run --detach --name "$container" --network none --read-only \
  --user 13:13 --cap-drop ALL --security-opt no-new-privileges \
  --mount "type=bind,source=$config,target=/etc/squid/squid.conf,readonly" \
  --mount "type=bind,source=$scratch/run,target=/run/squid" \
  --tmpfs /var/log/squid:uid=13,gid=13,mode=0700 \
  --tmpfs /var/spool/squid:uid=13,gid=13,mode=0700 \
  --tmpfs /tmp:uid=13,gid=13,mode=0700 \
  --entrypoint /usr/sbin/squid "$image" -f /etc/squid/squid.conf -NYC >/dev/null

verify_proxy() {
  local ready=false
  for _ in {1..40}; do
    if [[ "$(docker inspect --format '{{.State.Running}}' "$container")" != true ]]; then
      docker logs "$container"
      return 1
    fi
    if docker exec "$container" bash -c 'exec 3<>/dev/tcp/127.0.0.1/3128; exec 4<>/dev/tcp/127.0.0.1/3129' 2>/dev/null; then
      ready=true
      break
    fi
    sleep 0.25
  done
  if [[ "$ready" != true ]]; then
    docker logs "$container"
    return 1
  fi
  docker exec "$container" bash -euc '
    for probe in 3128/example.com 3128/opencode.ai 3129/example.com 3129/api.typesafe.ai; do
      port="${probe%/*}"
      host="${probe#*/}"
      exec 3<>"/dev/tcp/127.0.0.1/$port"
      printf "CONNECT %s:443 HTTP/1.1\r\nHost: %s:443\r\n\r\n" "$host" "$host" >&3
      IFS= read -r -t 5 response <&3
      [[ "$response" == "HTTP/1.1 403 "* ]]
      exec 3<&- 3>&-
    done
  '
}

verify_proxy
docker kill --signal KILL "$container" >/dev/null
docker start "$container" >/dev/null
verify_proxy
printf 'PASS: pinned Squid starts with a stale PID 1 file, survives an abrupt restart, and enforces both listeners before destination DNS.\n'
