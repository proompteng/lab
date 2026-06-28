#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${ATTIC_TOKEN:-}" ]]; then
  echo "ATTIC_TOKEN is required to push to Attic." >&2
  exit 2
fi

cache_name="${ATTIC_CACHE_NAME:-lab}"
cache_endpoint="${ATTIC_CACHE_ENDPOINT:-http://attic.attic.svc.cluster.local}"
server_name="${ATTIC_SERVER_NAME:-lab-ci}"
batch_size="${ATTIC_PUSH_BATCH_SIZE:-1}"
push_jobs="${ATTIC_PUSH_JOBS:-1}"
push_no_closure="${ATTIC_PUSH_NO_CLOSURE:-false}"

if [[ "$#" -eq 0 ]]; then
  echo "Usage: cache-push <store-path> [<store-path> ...]" >&2
  exit 2
fi

if ! [[ "${batch_size}" =~ ^[1-9][0-9]*$ ]]; then
  echo "ATTIC_PUSH_BATCH_SIZE must be a positive integer, got: ${batch_size}" >&2
  exit 2
fi

if ! [[ "${push_jobs}" =~ ^[1-9][0-9]*$ ]]; then
  echo "ATTIC_PUSH_JOBS must be a positive integer, got: ${push_jobs}" >&2
  exit 2
fi

case "${push_no_closure}" in
  1 | true | TRUE | yes | YES)
    push_no_closure_enabled=true
    push_mode="specified paths only"
    ;;
  0 | false | FALSE | no | NO)
    push_no_closure_enabled=false
    push_mode="closures"
    ;;
  *)
    echo "ATTIC_PUSH_NO_CLOSURE must be true or false, got: ${push_no_closure}" >&2
    exit 2
    ;;
esac

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

echo "Pushing ${#paths[@]} path(s) to Attic cache ${cache_name} in batches of ${batch_size} with ${push_jobs} upload job(s), mode: ${push_mode}."
for ((start = 0; start < ${#paths[@]}; start += batch_size)); do
  batch=("${paths[@]:start:batch_size}")
  echo "Pushing batch $((start / batch_size + 1)) with ${#batch[@]} path(s)."
  push_args=(push --jobs "${push_jobs}")
  if [[ "${push_no_closure_enabled}" == true ]]; then
    push_args+=(--no-closure)
  fi
  push_args+=("${server_name}:${cache_name}" "${batch[@]}")
  attic "${push_args[@]}"
done
