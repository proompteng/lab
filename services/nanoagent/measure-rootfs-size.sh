#!/usr/bin/env bash
set -euo pipefail

# Build-only failure diagnostic. This never changes the production capacity gate
# or emits its validation receipt. Search above the rejected 1 GiB limit using
# the same ext4 settings and spare blocks/inodes as validate-rootfs.sh.
[[ "$#" == 1 && -d "$1" ]]
rootfs="$1"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT

fits() {
  rm -f "$work/rootfs.ext4"
  truncate -s "$(($1 * 4096))" "$work/rootfs.ext4"
  if ! mkfs.ext4 -F -q -m 0 -b 4096 -N 32768 -J size=16 \
    -E lazy_itable_init=0,lazy_journal_init=0 \
    -d "$rootfs" "$work/rootfs.ext4" > "$work/mkfs.log" 2>&1; then
    return 1
  fi
  dumpe2fs -h "$work/rootfs.ext4" > "$work/filesystem.txt" 2>/dev/null
  free_blocks="$(awk '/^Free blocks:/ { print $3 }' "$work/filesystem.txt")"
  free_inodes="$(awk '/^Free inodes:/ { print $3 }' "$work/filesystem.txt")"
  [[ "$free_blocks" =~ ^[0-9]+$ && "$free_inodes" =~ ^[0-9]+$ ]]
  (( free_blocks >= 4097 && free_inodes >= 257 ))
}

lower=262144
upper=524288
if fits "$lower"; then
  printf 'Rootfs already fits the production limit; size diagnosis is unnecessary.\n' >&2
  exit 1
fi
until fits "$upper"; do
  if (( upper >= 524288 )); then
    printf 'Rootfs size diagnosis could not fit the payload within 2 GiB.\n' >&2
    cat "$work/mkfs.log" >&2
    exit 1
  fi
  upper=$((upper * 2))
done
while (( upper - lower > 1 )); do
  middle=$(((upper + lower) / 2))
  if fits "$middle"; then upper="$middle"; else lower="$middle"; fi
done
fits "$upper"
e2fsck -f -n "$work/rootfs.ext4" >&2
printf 'minimum_required_rootfs_bytes=%s\nrequired_free_bytes_before_receipt=%s\nrequired_free_inodes_before_receipt=%s\n' \
  "$((upper * 4096))" "$((free_blocks * 4096))" "$free_inodes"
