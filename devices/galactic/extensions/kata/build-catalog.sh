#!/usr/bin/env bash

set -euo pipefail

usage() {
  echo "usage: $0 <upstream-catalog:tag> <kata-extension:tag@sha256:digest> <output-dir>" >&2
}

if [[ $# -ne 3 || "$1" != *:* || "$2" != *:*@sha256:* ]]; then
  usage
  exit 2
fi

for command in crane tar; do
  if ! command -v "$command" >/dev/null; then
    echo "required command is missing: $command" >&2
    exit 1
  fi
done

readonly upstream_catalog="$1"
readonly kata_extension="$2"
readonly requested_output_dir="$3"
readonly kata_tagged_ref="${kata_extension%@sha256:*}"
readonly kata_repository="${kata_tagged_ref%:*}"

install -d "$requested_output_dir"
output_dir="$(cd "$requested_output_dir" && pwd -P)"
readonly output_dir

work_dir="$(mktemp -d)"
cleanup() {
  rm -rf -- "$work_dir"
}
trap cleanup EXIT

crane export "$upstream_catalog" "$work_dir/upstream.tar"
tar -xOf "$work_dir/upstream.tar" image-digests >"$output_dir/image-digests"
tar -xOf "$work_dir/upstream.tar" descriptions.yaml >"$output_dir/descriptions.yaml"

if grep -Fq "${kata_repository}:" "$output_dir/image-digests"; then
  echo 'the upstream catalog unexpectedly already contains the custom Kata extension' >&2
  exit 1
fi

printf '%s\n' "$kata_extension" >>"$output_dir/image-digests"
LC_ALL=C sort -o "$output_dir/image-digests" "$output_dir/image-digests"

cat >>"$output_dir/descriptions.yaml" <<EOF
$kata_extension:
  author: proompteng
  description: |
    Kata Containers 4.1.0 runtime-rs with QEMU, Cloud Hypervisor, Firecracker, and Dragonball handlers.
EOF

tar \
  --format=ustar \
  --mtime='UTC 1970-01-01' \
  --owner=0 \
  --group=0 \
  --numeric-owner \
  -C "$output_dir" \
  -cf "$output_dir/catalog.tar" \
  descriptions.yaml \
  image-digests

printf '%s\n' "$output_dir/catalog.tar"
