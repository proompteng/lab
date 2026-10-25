#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
output="$(cd ../../../devices/galactic/omni && pwd)"
build_dir="$(mktemp -d)"
trap 'rm -rf "$build_dir"' EXIT
for arch in amd64 arm64; do
  GOWORK=off GOOS=linux GOARCH="$arch" CGO_ENABLED=0 go test -c -o "$build_dir/test-$arch" .
  GOWORK=off GOOS=linux GOARCH="$arch" CGO_ENABLED=0 go build -o "$build_dir/profile-$arch" .
  image=ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55
  docker run --rm --platform "linux/$arch" --network none --read-only --cap-drop ALL \
    --mount "type=bind,src=$build_dir,dst=/generate,readonly" --entrypoint "/generate/test-$arch" "$image"
  docker run --rm --platform "linux/$arch" --network none --read-only --cap-drop ALL \
    --mount "type=bind,src=$build_dir,dst=/generate,readonly" --entrypoint "/generate/profile-$arch" "$image" \
    > "$output/tengri-runner-$arch.json"
done
