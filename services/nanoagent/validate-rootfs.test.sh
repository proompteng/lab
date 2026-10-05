#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT
mkdir -p "${work}/rootfs/usr/bin"
printf 'small guest fixture\n' > "${work}/rootfs/usr/bin/fixture"
bash "${script_dir}/validate-rootfs.sh" "${work}/rootfs" "${work}/valid.txt"
test -s "${work}/valid.txt"

# 472 MiB passes the previous 480 MiB du check, but cannot preserve 16 MiB of
# headroom after ext4 metadata is allocated. Use nonzero data so it is not sparse.
dd if=/dev/zero bs=1048576 count=472 status=none | tr '\000' x > "${work}/rootfs/payload"
if bash "${script_dir}/validate-rootfs.sh" "${work}/rootfs" "${work}/invalid.txt" > "${work}/failure.log" 2>&1; then
  printf 'Oversized guest unexpectedly passed ext4 capacity validation\n' >&2
  exit 1
fi
grep -q 'Guest rootfs lacks Firecracker headroom' "${work}/failure.log"
test ! -e "${work}/invalid.txt"
printf 'Ext4 rootfs validation accepts a small image and rejects the former du false positive.\n'
