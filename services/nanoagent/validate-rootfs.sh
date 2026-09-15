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

# Match the 512 MiB, 4 KiB-block, 32768-inode filesystem shipped by the Kata
# extension. Allocating ext4 catches file rounding and metadata that du omits.
truncate -s 536870912 "${work}/rootfs.ext4"
mkfs.ext4 -F -q -m 0 -b 4096 -N 32768 -J size=16 \
  -E lazy_itable_init=0,lazy_journal_init=0 \
  -d "${rootfs}" "${work}/rootfs.ext4"
e2fsck -f -n "${work}/rootfs.ext4"
dumpe2fs -h "${work}/rootfs.ext4" > "${work}/filesystem.txt"
free_blocks="$(awk '/^Free blocks:/ { print $3 }' "${work}/filesystem.txt")"
free_inodes="$(awk '/^Free inodes:/ { print $3 }' "${work}/filesystem.txt")"
[[ "${free_blocks}" =~ ^[0-9]+$ && "${free_inodes}" =~ ^[0-9]+$ ]]
# Leave 16 MiB and 256 inodes after the final receipt is copied into the image.
if (( free_blocks < 4097 || free_inodes < 257 )); then
  printf 'Guest rootfs lacks Firecracker headroom: %s free blocks, %s free inodes\n' \
    "${free_blocks}" "${free_inodes}" >&2
  exit 1
fi
printf 'filesystem_bytes=536870912\nfree_bytes_before_receipt=%s\nfree_inodes_before_receipt=%s\n' \
  "$((free_blocks * 4096))" "${free_inodes}" > "${receipt}"
cat "${receipt}"
