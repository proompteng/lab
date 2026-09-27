#!/usr/bin/env bash
set -euo pipefail

: "${DEVBOX_ROOTFS_IMAGE:?Set the immutable root filesystem image}"
if [[ ! "$DEVBOX_ROOTFS_IMAGE" =~ ^registry\.ide-newton\.ts\.net/lab/codex-devbox-rootfs@sha256:[a-f0-9]{64}$ ]]; then
  echo 'DEVBOX_ROOTFS_IMAGE must be an immutable devbox root filesystem reference' >&2
  exit 1
fi
state=/persist
mountpoint -q "$state" || { echo 'Persistent block filesystem is not mounted' >&2; exit 1; }
digest="${DEVBOX_ROOTFS_IMAGE##*@sha256:}"
root="$state/roots/$digest"
install -d -m 0700 "$state/roots" "$state/nix" "$state/ssh"
for pending in "$state/roots"/.extract.*; do
  [[ -d "$pending" && ! -L "$pending" ]] || continue
  rm -rf -- "$pending"
done
if [[ ! -f "$root/.image-complete" ]]; then
  stage="$(mktemp -d "$state/roots/.extract.XXXXXX")"
  trap 'rm -rf -- "$stage"' EXIT
  crane export "$DEVBOX_ROOTFS_IMAGE" - | tar --extract --preserve-permissions --file - --directory "$stage"
  test -x "$stage/sbin/init"
  test -x "$stage/usr/local/sbin/devbox-prepare"
  test -f "$stage/opt/devbox/nix-registration"
  printf '%s\n' "$DEVBOX_ROOTFS_IMAGE" > "$stage/.image-complete"
  mv "$stage" "$root"
  trap - EXIT
fi
[[ "$(cat "$root/.image-complete")" == "$DEVBOX_ROOTFS_IMAGE" ]]
chmod 0755 "$root"

rsync -a --ignore-existing "$root/nix/" "$state/nix/"
if [[ ! -d "$state/home" ]]; then
  cp -a "$root/home" "$state/home"
fi
install -d "$state/docker" "$state/machine" "$state/metadata" "$state/home/codex/.ssh" "$root/run" "$root/dev" "$root/proc" "$root/sys"
/usr/local/bin/devbox-prune-roots "$state" "$digest"
printf '%s\n' "$digest" > "$root/etc/devbox-generation"
chmod 0700 "$state/home/codex/.ssh"
install -m 0600 /bootstrap/authorized_keys "$state/home/codex/.ssh/authorized_keys"
chown -R 1000:1000 "$state/home/codex/.ssh"

bind() {
  install -d "$2"
  mount --bind "$1" "$2"
}
bind "$state/nix" "$root/nix"
bind "$state/home" "$root/home"
bind "$state/docker" "$root/var/lib/docker"
bind "$state/metadata" "$root/var/lib/devbox"
for path in dev proc sys run; do
  mount --rbind "/$path" "$root/$path"
  mount --make-rslave "$root/$path"
done
mount -o remount,rw "$root/sys/fs/cgroup"
rm -f "$root/etc/resolv.conf"
install -m 0644 /etc/resolv.conf "$root/etc/resolv.conf"
if [[ ! -s "$state/machine/id" ]]; then
  tr -d '-' < /proc/sys/kernel/random/uuid > "$state/machine/id"
fi
install -m 0444 "$state/machine/id" "$root/etc/machine-id"
for type in ed25519 rsa; do
  if [[ ! -f "$state/ssh/ssh_host_${type}_key" ]]; then
    chroot "$root" /usr/bin/ssh-keygen -q -N '' -t "$type" -f "/etc/ssh/ssh_host_${type}_key"
    cp -a "$root/etc/ssh/ssh_host_${type}_key"* "$state/ssh/"
  fi
  cp -a "$state/ssh/ssh_host_${type}_key"* "$root/etc/ssh/"
done
chroot "$root" /usr/bin/env NIX_REMOTE=local /opt/devbox/toolchain/bin/nix-store --load-db < "$root/opt/devbox/nix-registration"
install -d "$state/nix/var/nix/gcroots"
ln -sfn "$(cat "$root/opt/devbox/toolchain-path")" "$state/nix/var/nix/gcroots/devbox-toolchain"
ln -sfn "$root" /run/devbox-root
export container=kata
exec chroot "$root" /sbin/init
