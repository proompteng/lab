#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT
mkdir -p "${work}/rootfs/usr/bin"
printf 'small guest fixture\n' > "${work}/rootfs/usr/bin/fixture"
bash "${script_dir}/validate-rootfs.sh" "${work}/rootfs" "${work}/valid.txt"
test -s "${work}/valid.txt"
grep -Fxq 'filesystem_bytes=536870912' "${work}/valid.txt"

# Apparent size below 512 MiB cannot guarantee 16 MiB of ext4 headroom.
# Use nonzero data so file allocation is exercised rather than sparse holes.
free_bytes="$(awk -F= '/^free_bytes_before_receipt=/ { print $2 }' "${work}/valid.txt")"
payload_bytes="$((free_bytes - 16 * 1024 * 1024 + 65536))"
head -c "${payload_bytes}" /dev/zero | tr '\000' x > "${work}/rootfs/payload"
if bash "${script_dir}/validate-rootfs.sh" "${work}/rootfs" "${work}/invalid.txt" > "${work}/failure.log" 2>&1; then
  printf 'Oversized guest unexpectedly passed ext4 capacity validation\n' >&2
  exit 1
fi
grep -q 'Guest rootfs lacks Firecracker headroom' "${work}/failure.log"
test ! -e "${work}/invalid.txt"
printf 'Ext4 rootfs validation accepts small images and rejects insufficient headroom.\n'
