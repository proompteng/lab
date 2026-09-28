#!/usr/bin/env bash
set -euo pipefail
trap 'echo "devbox boot failed at line $LINENO" >&2' ERR

state=/persist
export HOME=/root
mountpoint -q "$state" || { echo 'Persistent block filesystem is not mounted' >&2; exit 1; }
install -d -m 0700 "$state/nix" "$state/ssh" "$state/machine" "$state/metadata" "$state/docker" "$state/containerd"
rsync -a --ignore-existing /nix/ "$state/nix/"
install -d -m 0755 "$state/home"
devbox-seed-home /home/codex "$state/home/codex"

bind() {
  install -d "$2"
  mount --bind "$1" "$2"
}
bind "$state/nix" /nix
bind "$state/home" /home
bind "$state/docker" /var/lib/docker
bind "$state/containerd" /var/lib/containerd
bind "$state/metadata" /var/lib/devbox
mount -o remount,rw /sys/fs/cgroup

install -d -m 0700 -o 1000 -g 1000 /home/codex/.ssh
install -m 0600 -o 1000 -g 1000 /bootstrap/authorized_keys /home/codex/.ssh/authorized_keys
if [[ ! -s "$state/machine/id" ]]; then
  tr -d '-' < /proc/sys/kernel/random/uuid > "$state/machine/id"
fi
install -m 0444 "$state/machine/id" /etc/machine-id
for type in ed25519 rsa; do
  key="$state/ssh/ssh_host_${type}_key"
  if [[ ! -f "$key" ]]; then
    ssh-keygen -q -N '' -t "$type" -f "$key"
  fi
  install -m 0600 "$key" "/etc/ssh/ssh_host_${type}_key"
  install -m 0644 "$key.pub" "/etc/ssh/ssh_host_${type}_key.pub"
done
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
NIX_REMOTE=local /opt/devbox/toolchain/bin/nix-store --load-db < /opt/devbox/nix-registration
install -d /nix/var/nix/gcroots
ln -sfn "$(cat /opt/devbox/toolchain-path)" /nix/var/nix/gcroots/devbox-toolchain
export container=kata
exec /sbin/init
