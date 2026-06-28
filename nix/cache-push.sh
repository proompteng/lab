#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${ATTIC_TOKEN:-}" ]]; then
  echo "ATTIC_TOKEN is required to push to Attic." >&2
  exit 2
fi

cache_name="${ATTIC_CACHE_NAME:-lab}"
cache_endpoint="${ATTIC_CACHE_ENDPOINT:-http://attic.attic.svc.cluster.local}"
server_name="${ATTIC_SERVER_NAME:-lab-ci}"

if [[ "$#" -eq 0 ]]; then
  echo "Usage: cache-push <store-path> [<store-path> ...]" >&2
  exit 2
fi

paths=()
for path in "$@"; do
  if [[ ! -e "${path}" ]]; then
    echo "Store path does not exist: ${path}" >&2
    exit 1
  fi
  paths+=("${path}")
done

echo "Logging in to Attic endpoint ${cache_endpoint} for cache ${cache_name}."
attic login --set-default "${server_name}" "${cache_endpoint}" "${ATTIC_TOKEN}" >/dev/null

echo "Pushing ${#paths[@]} path(s) to Attic cache ${cache_name}."
attic push "${server_name}:${cache_name}" "${paths[@]}"
