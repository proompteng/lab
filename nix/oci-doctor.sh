#!/usr/bin/env bash

fail() {
  printf 'oci-doctor: %s\n' "$*" >&2
  exit 1
}

have() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

print_version() {
  name="$1"
  shift
  output="$("$@" 2>/dev/null | head -n 1 || true)"
  [ -n "$output" ] || fail "$name did not print a version"
  printf '%-18s %s\n' "$name" "$output"
}

for cmd in buildctl buildkitd docker docker-buildx crane skopeo regctl cosign; do
  have "$cmd"
done

print_version buildctl buildctl --version
print_version buildkitd buildkitd --version
print_version docker-buildx docker-buildx version
print_version "docker buildx" docker buildx version
print_version crane crane version
print_version skopeo skopeo --version
print_version regctl regctl version
cosign_version="$(cosign version --json 2>/dev/null | jq -r '.gitVersion // .GitVersion // .version // empty' 2>/dev/null || true)"
if [ -z "$cosign_version" ]; then
  cosign_version="$(cosign version 2>/dev/null | awk '/GitVersion|Version/ {print $NF; exit}')"
fi
[ -n "$cosign_version" ] || fail "cosign did not print a version"
printf '%-18s %s\n' cosign "$cosign_version"

printf 'oci-doctor: ok\n'
