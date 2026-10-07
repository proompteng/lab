#!/usr/bin/env bash
set -euo pipefail

case "${1:---filesystem}" in
  --filesystem|--runtime) ;;
  *) printf 'Usage: %s [--filesystem|--runtime]\n' "$0" >&2; exit 2 ;;
esac

test "$(id -u)" = 1000
test "$(sudo -n id -u)" = 0
admin_etc_file="$(sudo -n mktemp /etc/tengri-admin.XXXXXX)"
admin_local_file="$(sudo -n mktemp /usr/local/tengri-admin.XXXXXX)"
admin_mount="$(mktemp -d /tmp/tengri-admin-mount.XXXXXX)"
admin_address=198.18.0.254/32
admin_address_added=false
cleanup() {
  sudo -n umount "$admin_mount" 2>/dev/null || true
  if [[ "$admin_address_added" == true ]]; then
    sudo -n ip address delete "$admin_address" dev lo
  fi
  sudo -n rm -f "$admin_etc_file" "$admin_local_file"
  rmdir "$admin_mount"
}
trap cleanup EXIT
sudo -n bash -c 'printf "guest-admin\n" > "$1"; printf "guest-admin\n" > "$2"' \
  bash "$admin_etc_file" "$admin_local_file"
sudo -n chmod 0644 "$admin_etc_file" "$admin_local_file"
test "$(cat "$admin_etc_file")" = guest-admin
test "$(cat "$admin_local_file")" = guest-admin

sudo -n apt-get update -o Acquire::Retries=3
sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends hello
test "$(/usr/bin/hello)" = 'Hello, world!'
sudo -n apt-get purge --yes hello
sudo -n apt-get clean
sudo -n bash -c 'rm -rf /home/nanoagent/.cache/apt/lists/* /home/nanoagent/.cache/apt/archives/*'

if [[ "${1:-}" == --runtime ]]; then
  sudo -n mount -t tmpfs -o size=1m,mode=1777 tmpfs "$admin_mount"
  printf 'mounted\n' > "$admin_mount/guest-test"
  test "$(cat "$admin_mount/guest-test")" = mounted
  sudo -n umount "$admin_mount"
  sudo -n ip address add "$admin_address" dev lo
  admin_address_added=true
  ip -4 -o address show dev lo | awk '{print $4}' | grep -Fxq "$admin_address"
  sudo -n ip address delete "$admin_address" dev lo
  admin_address_added=false
fi
printf 'Guest administrator checks passed (%s).\n' "${1:---filesystem}"
