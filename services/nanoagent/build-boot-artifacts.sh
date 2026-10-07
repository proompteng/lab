#!/bin/bash
set -euo pipefail

case "${1:?target architecture is required}" in
  amd64)
    guest_arch=x86_64
    kernel_sha=645688b5933cb257f7d4fa71eb246669233e8c2db8378217c99cf891541fe3d5
    ;;
  arm64)
    guest_arch=aarch64
    kernel_sha=b2054e82c9d1120519882c39485a17b29657b77c93ed8c9d412996de6ba9711c
    ;;
  *) exit 1 ;;
esac

mkdir -p /guest
curl -fsSL --retry 3 --connect-timeout 15 --max-time 300 \
  -o /guest/vmlinux \
  "https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/20260819-0a745def42dd-0/${guest_arch}/vmlinux-6.18.41"
printf '%s  /guest/vmlinux\n' "$kernel_sha" | sha256sum --check
cp /rootfs-validation.txt /rootfs/usr/share/nanoagent/rootfs-validation.txt
# Credentials and resolver state are injected into each private copy before boot.
rm -f /rootfs/etc/resolv.conf /rootfs/etc/tengri-slot.json
truncate -s 1073741824 /guest/rootfs.ext4
mkfs.ext4 -F -q -m 0 -b 4096 -N 32768 -J size=16 \
  -E lazy_itable_init=0,lazy_journal_init=0,root_owner=0:0 \
  -d /rootfs /guest/rootfs.ext4
e2fsck -f -n /guest/rootfs.ext4
chmod 0644 /guest/rootfs.ext4 /guest/vmlinux
sha256sum /guest/rootfs.ext4 /guest/vmlinux > /guest/SHA256SUMS
