#!/usr/bin/env bash
set -euo pipefail

# Kind uses a Docker bridge network named "kind". In some environments (notably long-lived
# self-hosted runners), Docker can exhaust its default IPv4 address pools, causing:
#   "all predefined address pools have been fully subnetted"
# when creating the network.
#
# Workaround: pre-create the "kind" network with an explicit IPv4 subnet (and IPv6),
# which avoids allocating from Docker's default pools.
#
# IMPORTANT (self-hosted ARC runners):
# Some ARC runner deployments run pods with `hostNetwork: true` + Docker-in-Docker. In that
# setup, multiple concurrent jobs can create bridge networks in the *host* network namespace.
# If those bridges reuse the same subnet, Linux routing becomes ambiguous (multiple equal routes
# for the same CIDR) and Kind's API server port-forward becomes flaky/unreachable.
#
# To avoid that, when the network name is not the default "kind", we derive a per-network
# /24 (and matching IPv6 /64) from the network name + run metadata. This reduces collisions
# without requiring cluster-level changes.

NETWORK_NAME="${KIND_DOCKER_NETWORK_NAME:-kind}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required to ensure the kind network" >&2
  exit 1
fi

# On ARC runners, Docker-in-Docker can take a few seconds to start and create the socket.
# Fail fast with a clear message if Docker never comes up.
docker_wait_seconds="${DOCKER_WAIT_SECONDS:-30}"
for _ in $(seq 1 "${docker_wait_seconds}"); do
  if docker info >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! docker info >/dev/null 2>&1; then
  echo "Docker daemon is not reachable (DOCKER_HOST=${DOCKER_HOST:-<unset>})." >&2
  ls -la /var/run >&2 || true
  exit 1
fi

if docker network inspect "${NETWORK_NAME}" >/dev/null 2>&1; then
  echo "Docker network '${NETWORK_NAME}' already exists."
  exit 0
fi

echo "Creating Docker network '${NETWORK_NAME}' with explicit subnets..."

v4_override="${KIND_DOCKER_NETWORK_V4_SUBNET:-}"
v6_override="${KIND_DOCKER_NETWORK_V6_SUBNET:-}"

candidate_pairs=()

if [[ -n "${v4_override}" || -n "${v6_override}" ]]; then
  if [[ -z "${v4_override}" || -z "${v6_override}" ]]; then
    echo "Both KIND_DOCKER_NETWORK_V4_SUBNET and KIND_DOCKER_NETWORK_V6_SUBNET must be set together." >&2
    exit 1
  fi
  candidate_pairs+=("${v4_override} ${v6_override}")
elif [[ "${NETWORK_NAME}" != "kind" ]]; then
  # Generate up to N deterministic candidates derived from the network name and GitHub run metadata.
  # We prefer /24s under 10.100.0.0/16 to minimize the chance of colliding with k8s pod/service CIDRs.
  seed_base="${NETWORK_NAME}-${GITHUB_RUN_ID:-0}-${GITHUB_RUN_ATTEMPT:-0}"
  for attempt in $(seq 0 39); do
    seed="${seed_base}-${attempt}"
    crc="$(printf '%s' "${seed}" | cksum | awk '{print $1}')"
    a="$((100 + (crc % 100)))"           # 100..199
    b="$(((crc / 100) % 256))"           # 0..255
    v4="10.${a}.${b}.0/24"
    a_hex="$(printf '%04x' "${a}")"
    b_hex="$(printf '%04x' "${b}")"
    v6="fd00:10:${a_hex}:${b_hex}::/64"
    candidate_pairs+=("${v4} ${v6}")
  done
else
  # Backwards-compatible defaults for the shared "kind" network.
  candidate_pairs+=(
    "10.250.0.0/16 fd00:10:250::/64"
    "10.251.0.0/16 fd00:10:251::/64"
    "10.252.0.0/16 fd00:10:252::/64"
    "10.253.0.0/16 fd00:10:253::/64"
    "172.30.0.0/16 fd00:172:30::/64"
    "172.31.0.0/16 fd00:172:31::/64"
  )
fi

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
