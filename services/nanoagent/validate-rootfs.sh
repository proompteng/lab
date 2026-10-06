#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 2 || ! -d "$1" ]]; then
  printf 'Usage: %s <rootfs-directory> <receipt-file>\n' "$0" >&2
  exit 2
fi

rootfs="$1"
receipt="$2"
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

# Match the installed 512 MiB scratch. Allocating ext4 catches file rounding
# and metadata that du omits; no node extension or cached-parent growth is needed.
truncate -s 536870912 "${work}/rootfs.ext4"
mkfs.ext4 -F -q -m 0 \
  -E lazy_itable_init=0,lazy_journal_init=0 \
  -d "${rootfs}" "${work}/rootfs.ext4"
e2fsck -f -n "${work}/rootfs.ext4"
dumpe2fs -h "${work}/rootfs.ext4" > "${work}/filesystem.txt"
free_blocks="$(awk '/^Free blocks:/ { print $3 }' "${work}/filesystem.txt")"
block_size="$(awk '/^Block size:/ { print $3 }' "${work}/filesystem.txt")"
free_inodes="$(awk '/^Free inodes:/ { print $3 }' "${work}/filesystem.txt")"
[[ "${free_blocks}" =~ ^[0-9]+$ && "${block_size}" =~ ^[0-9]+$ && "${free_inodes}" =~ ^[0-9]+$ ]]
# Leave 16 MiB and 256 inodes after the capacity and metadata receipts are added.
if (( free_blocks * block_size < 16777216 + 2 * block_size || free_inodes < 258 )); then
  printf 'Guest rootfs lacks Firecracker headroom: %s free blocks, %s free inodes\n' \
    "${free_blocks}" "${free_inodes}" >&2
  exit 1
fi
printf 'filesystem_bytes=536870912\nfree_bytes_before_receipt=%s\nfree_inodes_before_receipt=%s\n' \
  "$((free_blocks * block_size))" "${free_inodes}" > "${receipt}"
cat "${receipt}"
