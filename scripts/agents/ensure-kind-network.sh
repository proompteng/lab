#!/usr/bin/env bash
set -euo pipefail

# Kind uses a Docker bridge network named "kind". In some environments (notably long-lived
# self-hosted runners), Docker can exhaust its default IPv4 address pools, causing:
#   "all predefined address pools have been fully subnetted"
# when creating the network.
#
# Workaround: pre-create the "kind" network with an explicit IPv4 subnet (and IPv6),
# which avoids allocating from Docker's default pools.

NETWORK_NAME="${KIND_DOCKER_NETWORK_NAME:-kind}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required to ensure the kind network" >&2
  exit 1
fi

if docker network inspect "${NETWORK_NAME}" >/dev/null 2>&1; then
  echo "Docker network '${NETWORK_NAME}' already exists."
  exit 0
fi

echo "Creating Docker network '${NETWORK_NAME}' with explicit subnets..."

candidate_pairs=(
  "10.250.0.0/16 fd00:10:250::/64"
  "10.251.0.0/16 fd00:10:251::/64"
  "10.252.0.0/16 fd00:10:252::/64"
  "10.253.0.0/16 fd00:10:253::/64"
  "172.30.0.0/16 fd00:172:30::/64"
  "172.31.0.0/16 fd00:172:31::/64"
)

for pair in "${candidate_pairs[@]}"; do
  v4="$(awk '{print $1}' <<<"${pair}")"
  v6="$(awk '{print $2}' <<<"${pair}")"
  echo "Trying ${v4} + ${v6}..."
  if docker network create \
    -d=bridge \
    -o com.docker.network.bridge.enable_ip_masquerade=true \
    -o com.docker.network.driver.mtu=1500 \
    --subnet "${v4}" \
    --ipv6 \
    --subnet "${v6}" \
    "${NETWORK_NAME}" >/dev/null; then
    echo "Created Docker network '${NETWORK_NAME}'."
    exit 0
  fi
done

echo "Failed to create Docker network '${NETWORK_NAME}' with all candidate subnets." >&2
docker network ls >&2 || true
exit 1

