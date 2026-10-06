#!/bin/sh
set -eu

# Build-only checks; fixtures and their backups never enter the extension.
test "$#" = 1
test "$(stat -c '%s' "$1")" = 1073741824
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
e2fsck -f -n "$1"
dumpe2fs -h "$1" > "$work/filesystem.txt"
grep -Eq '^Block size: +4096$' "$work/filesystem.txt"
grep -Eq '^Block count: +262144$' "$work/filesystem.txt"
grep -Eq '^Inode count: +32768$' "$work/filesystem.txt"
grep -Eq '^Total journal size: +16M$' "$work/filesystem.txt"

# Prove offline growth preserves a cached parent payload and backup recovery.
mkdir "$work/rootfs"
printf 'cached parent payload\n' > "$work/rootfs/payload"
truncate -s 512M "$work/parent.ext4"
mkfs.ext4 -F -q -m 0 -b 4096 -N 32768 -J size=16 \
  -E lazy_itable_init=0,lazy_journal_init=0 -d "$work/rootfs" "$work/parent.ext4"
cp --sparse=always "$work/parent.ext4" "$work/backup.ext4"
truncate -s 1G "$work/parent.ext4"
resize2fs "$work/parent.ext4"
e2fsck -f -n "$work/parent.ext4"
debugfs -R "dump /payload $work/recovered" "$work/parent.ext4"
cmp "$work/rootfs/payload" "$work/recovered"
dumpe2fs -h "$work/parent.ext4" > "$work/grown.txt"
grep -Eq '^Block count: +262144$' "$work/grown.txt"
cp --sparse=always "$work/backup.ext4" "$work/parent.ext4"
cmp "$work/backup.ext4" "$work/parent.ext4"
e2fsck -f -n "$work/parent.ext4"
printf 'Scratch geometry, offline cached-parent growth, payload preservation, and backup restore passed.\n'
