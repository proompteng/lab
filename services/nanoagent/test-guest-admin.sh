#!/usr/bin/env bash
set -euo pipefail

filesystem_metadata() {
  local runner=()
  if [[ "$(id -u)" != 0 ]]; then runner=(sudo -n); fi
  "${runner[@]}" python3 -B - <<'PY'
import errno, hashlib, json, os, stat

excluded = {"/dev", "/proc", "/sys", "/run", "/tmp", "/.dockerenv",
            "/etc/hostname", "/etc/hosts", "/etc/resolv.conf", "/etc/mtab",
            "/usr/share/nanoagent", "/etc/nanoagent-filesystem.sha256"}
entries = []
def fail(error):
    raise error

for root, directories, files in os.walk("/", onerror=fail):
    directories[:] = sorted(name for name in directories if os.path.join(root, name) not in excluded)
    for name in sorted(directories + files):
        path = os.path.join(root, name)
        if path in excluded:
            continue
        info = os.lstat(path)
        try:
            capability = os.getxattr(path, "security.capability", follow_symlinks=False).hex()
        except OSError as error:
            if error.errno not in (errno.ENODATA, errno.ENOTSUP):
                raise
            capability = ""
        entries.append([path, info.st_uid, info.st_gid, info.st_mode,
                        os.readlink(path) if stat.S_ISLNK(info.st_mode) else "", capability])
print(hashlib.sha256(json.dumps(sorted(entries), separators=(",", ":")).encode()).hexdigest())
PY
}

if [[ "${1:-}" == --metadata ]]; then
  filesystem_metadata
  exit 0
fi

case "${1:---filesystem}" in
  --filesystem|--runtime) ;;
  *) printf 'Usage: %s [--filesystem|--runtime]\n' "$0" >&2; exit 2 ;;
esac

test "$(id -u)" = 1000
test "$(sudo -n id -u)" = 0
if [[ "${1:-}" == --runtime ]]; then
  test "$(filesystem_metadata)" = "$(cat /etc/nanoagent-filesystem.sha256)"
  printf 'Guest filesystem ownership, modes, symlinks and capabilities match the build stage.\n'
fi
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
