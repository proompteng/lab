#!/usr/bin/env bash
set -euo pipefail

: "${TENGRI_KVM_TEST_IMAGE:?set the native test image}"
: "${TENGRI_KVM_GUEST_IMAGE:?set the paired real guest boot image}"
: "${TENGRI_KVM_OUTPUT:?set an absolute local result directory}"
[[ "$TENGRI_KVM_OUTPUT" == /* && "${TENGRI_KVM_SAMPLES:-50}" =~ ^[1-9][0-9]*$ ]]
egress_interface="$(awk '$2 == "00000000" && $8 == "00000000" {print $1; exit}' /proc/net/route)"
: "${egress_interface:?native KVM fixture requires an IPv4 default route}"
fixture_mtu="$(cat "/sys/class/net/${egress_interface}/mtu")"
[[ "$fixture_mtu" =~ ^[0-9]+$ ]] || {
  echo 'Cannot determine the native KVM fixture egress MTU' >&2
  exit 1
}
fixture_name="tengri-kvm-$(date -u +%Y%m%d%H%M%S)-${RANDOM}"
mkdir -p "$TENGRI_KVM_OUTPUT"
artifacts_volume="${fixture_name}-artifacts"
work_volume="${fixture_name}-work"
fixture_network_id=''
cleanup() {
  docker logs "$fixture_name" > "$TENGRI_KVM_OUTPUT/test.log" 2>&1 || true
  docker cp "$fixture_name:/work/result.json" "$TENGRI_KVM_OUTPUT/result.json" >/dev/null 2>&1 || true
  docker cp "$fixture_name:/work/slot/firecracker.log" "$TENGRI_KVM_OUTPUT/firecracker.log" >/dev/null 2>&1 || true
  docker rm --force "$fixture_name" >/dev/null 2>&1 || true
  docker volume rm "$artifacts_volume" "$work_volume" >/dev/null 2>&1 || true
  if [[ -n "$fixture_network_id" ]]; then
    docker network rm "$fixture_network_id" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM
created_network_id="$(docker network create --driver bridge \
  --opt "com.docker.network.driver.mtu=${fixture_mtu}" "$fixture_name")"
fixture_network_id="$created_network_id"
docker volume create "$artifacts_volume" >/dev/null
docker volume create "$work_volume" >/dev/null
docker run --rm --user 0:0 --cap-drop ALL --read-only \
  --mount "type=volume,source=${artifacts_volume},target=/artifacts" \
  --entrypoint /bin/cp "$TENGRI_KVM_GUEST_IMAGE" /guest/rootfs.ext4 /guest/vmlinux /artifacts/
guest_digest="$(docker image inspect --format '{{.Id}}' "$TENGRI_KVM_GUEST_IMAGE")"
docker run --name "$fixture_name" --cpus=1 --memory=9g --memory-swap=9g --pids-limit=512 \
  --read-only --cap-drop ALL --cap-add NET_ADMIN --cap-add SETUID --cap-add SETGID \
  --security-opt no-new-privileges=true --device /dev/kvm --device /dev/net/tun \
  --network "$fixture_network_id" \
  --dns 1.1.1.1 --dns 8.8.8.8 \
  --tmpfs /tmp:rw,nosuid,nodev,size=128m --tmpfs /run/tengri:rw,nosuid,nodev,size=1m,uid=0,gid=65532,mode=0770 \
  --mount "type=volume,source=${artifacts_volume},target=/guest,readonly" \
  --mount "type=volume,source=${work_volume},target=/work" \
  --env NANOAGENT_RPC_FIXTURE=/fixture/nanoagent-tests \
  --env "TENGRI_GUEST_IMAGE=${guest_digest}" --env "TENGRI_KVM_SAMPLES=${TENGRI_KVM_SAMPLES:-50}" \
  "$TENGRI_KVM_TEST_IMAGE"
