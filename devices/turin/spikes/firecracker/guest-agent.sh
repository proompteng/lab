#!/usr/bin/env bash
set -Eeuo pipefail

readonly mmds_address='169.254.169.254'

log() {
  printf 'MICROVM_AGENT %s\n' "$*"
}

log 'bootstrap-start'

for _ in $(seq 1 60); do
  if ip link show eth0 >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

ip route replace default via 172.16.0.1 dev eth0
ip route replace "${mmds_address}" dev eth0

token=''
for _ in $(seq 1 60); do
  if token=$(curl --fail --silent --show-error --max-time 2 \
    --request PUT \
    --header 'X-metadata-token-ttl-seconds: 300' \
    "http://${mmds_address}/latest/api/token"); then
    break
  fi
  sleep 1
done

if [[ -z "${token}" ]]; then
  log 'bootstrap-failed reason=mmds-token-unavailable'
  exit 1
fi

mmds_get() {
  curl --fail --silent --show-error --max-time 3 \
    --header "X-metadata-token: ${token}" \
    "http://${mmds_address}/$1"
}

nonce="$(mmds_get bootstrap/nonce)"
controller_url="$(mmds_get bootstrap/controller-url)"
microvm_id="$(mmds_get bootstrap/microvm-id)"
readonly nonce controller_url microvm_id

egress='failed'
http_status='000'
if http_status=$(curl --silent --show-error --ipv4 --max-time 15 \
  --output /dev/null --write-out '%{http_code}' https://aws.amazon.com/firecracker/); then
  egress='ok'
fi

printf '{"microvm_id":"%s","nonce":"%s","mmds_v2":"ok","network_egress":"%s","network_http_status":"%s"}\n' \
  "${microvm_id}" "${nonce}" "${egress}" "${http_status}" >/run/nanoagent.ready

curl --fail --silent --show-error --max-time 5 \
  --request POST \
  --header 'Content-Type: application/json' \
  --header "X-Bootstrap-Nonce: ${nonce}" \
  --data-binary @/run/nanoagent.ready \
  "${controller_url}"

log "ready microvm_id=${microvm_id} mmds_v2=ok network_egress=${egress} http_status=${http_status}"

exec sleep infinity
