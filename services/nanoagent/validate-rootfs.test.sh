#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT
mkdir -p "${work}/rootfs/usr/bin"
printf 'small guest fixture\n' > "${work}/rootfs/usr/bin/fixture"
bash "${script_dir}/validate-rootfs.sh" "${work}/rootfs" "${work}/valid.txt"
test -s "${work}/valid.txt"

# Nonzero data prevents sparse files from understating ext4 allocation.
dd if=/dev/zero bs=1048576 count=984 status=none | tr '\000' x > "${work}/rootfs/payload"
if bash "${script_dir}/validate-rootfs.sh" "${work}/rootfs" "${work}/invalid.txt" > "${work}/failure.log" 2>&1; then
  printf 'Oversized guest unexpectedly passed ext4 capacity validation\n' >&2
  exit 1
fi
grep -q 'Guest rootfs lacks Firecracker headroom' "${work}/failure.log"
test ! -e "${work}/invalid.txt"
printf 'Ext4 rootfs validation preserves the required writable headroom.\n'
