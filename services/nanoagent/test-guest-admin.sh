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
cleanup() {
  sudo -n umount "$admin_mount" 2>/dev/null || true
  sudo -n ip link delete tengri-admin 2>/dev/null || true
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
  sudo -n ip link add tengri-admin type dummy
  sudo -n ip link delete tengri-admin
fi
printf 'Guest administrator checks passed (%s).\n' "${1:---filesystem}"
