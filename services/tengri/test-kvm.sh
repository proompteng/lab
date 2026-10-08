#!/usr/bin/env bash
set -euo pipefail

: "${TENGRI_KVM_TEST_IMAGE:?set the native test image}"
: "${TENGRI_KVM_GUEST_IMAGE:?set the paired real guest boot image}"
: "${TENGRI_KVM_OUTPUT:?set an absolute local result directory}"
if ! [[ "$TENGRI_KVM_OUTPUT" == /* && "${TENGRI_KVM_SAMPLES:-3}" =~ ^[1-9][0-9]*$ ]] || \
  (( ${TENGRI_KVM_SAMPLES:-3} < 3 )); then
  printf 'KVM acceptance requires an absolute output directory and at least three cycles\n' >&2
  exit 2
fi
fixture_interface="$(ip -4 route get 1.1.1.1 | awk '{for (i=1; i<NF; i++) if ($i == "dev") {print $(i+1); exit}}')"
[[ "$fixture_interface" =~ ^[a-zA-Z0-9_.:-]+$ ]]
fixture_network_mtu="$(cat "/sys/class/net/${fixture_interface}/mtu")"
fixture_name="tengri-kvm-$(date -u +%Y%m%d%H%M%S)-${RANDOM}"
mkdir -p "$TENGRI_KVM_OUTPUT"
artifacts_volume="${fixture_name}-artifacts"
work_volume="${fixture_name}-work"
cleanup() {
  docker logs "$fixture_name" > "$TENGRI_KVM_OUTPUT/test.log" 2>&1 || true
  docker cp "$fixture_name:/work/result.json" "$TENGRI_KVM_OUTPUT/result.json" >/dev/null 2>&1 || true
  docker cp "$fixture_name:/work/slot/firecracker.log" "$TENGRI_KVM_OUTPUT/firecracker.log" >/dev/null 2>&1 || true
  docker rm --force "$fixture_name" >/dev/null 2>&1 || true
  docker volume rm "$artifacts_volume" "$work_volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM
docker volume create "$artifacts_volume" >/dev/null
docker volume create "$work_volume" >/dev/null
docker run --rm --user 0:0 --cap-drop ALL --read-only \
  --mount "type=volume,source=${artifacts_volume},target=/artifacts" \
  --entrypoint /bin/cp "$TENGRI_KVM_GUEST_IMAGE" /guest/rootfs.ext4 /guest/vmlinux /artifacts/
guest_digest="$(docker image inspect --format '{{.Id}}' "$TENGRI_KVM_GUEST_IMAGE")"
docker run --name "$fixture_name" --cpus=1 --memory=9g --memory-swap=9g --pids-limit=512 \
  --read-only --cap-drop ALL --cap-add NET_ADMIN --cap-add SETUID --cap-add SETGID \
  --security-opt no-new-privileges=true --device /dev/kvm --device /dev/net/tun \
  --dns 1.1.1.1 --dns 8.8.8.8 \
  --tmpfs /tmp:rw,nosuid,nodev,size=128m --tmpfs /run/tengri:rw,nosuid,nodev,size=1m,uid=0,gid=65532,mode=0770 \
  --mount "type=volume,source=${artifacts_volume},target=/guest,readonly" \
  --mount "type=volume,source=${work_volume},target=/work" \
  --env NANOAGENT_RPC_FIXTURE=/fixture/nanoagent-tests \
  --env "TENGRI_KVM_NETWORK_MTU=${fixture_network_mtu}" \
  --env "TENGRI_GUEST_IMAGE=${guest_digest}" --env "TENGRI_KVM_SAMPLES=${TENGRI_KVM_SAMPLES:-3}" \
  "$TENGRI_KVM_TEST_IMAGE"
