#!/bin/bash
set -euo pipefail
mount -t proc proc /proc
mount -t sysfs sysfs /sys
if ! mountpoint -q /dev; then
  mount -t devtmpfs devtmpfs /dev
fi
mkdir -p /dev/pts /run /tmp
ln -sfn /proc/self/fd /dev/fd
ln -sfn /proc/self/fd/0 /dev/stdin
ln -sfn /proc/self/fd/1 /dev/stdout
ln -sfn /proc/self/fd/2 /dev/stderr
chown 1000:1000 /dev/vsock
mount -t devpts devpts /dev/pts
mount -t tmpfs -o mode=0755 tmpfs /run
mount -t tmpfs -o mode=1777 tmpfs /tmp
ip link set lo up
ip link set eth0 up
ip address add 10.250.0.2/30 dev eth0
ip route add default via 10.250.0.1
export HOME=/home/nanoagent NANOAGENT_HOME=/home/nanoagent NANOAGENT_WORKSPACE=/workspace
export CARGO_HOME=/home/nanoagent/.cargo CODEX_HOME=/home/nanoagent/.codex
export CODEX_BINARY=/home/nanoagent/.local/bin/codex CODEX_BOOTSTRAP_COMMAND=/usr/local/bin/bootstrap-codex
export CODE_SERVER_BINARY=/home/nanoagent/.local/bin/code-server CODE_SERVER_BOOTSTRAP_COMMAND=/usr/local/bin/bootstrap-code-server
export BROWSER_BINARY=/usr/local/bin/launch-browser BROWSER_BOOTSTRAP_COMMAND=/usr/local/bin/bootstrap-browser
export BROWSER_ASSETS_DIRECTORY=/usr/share/nanoagent/novnc BROWSER_RUNTIME_MANIFEST=/usr/share/nanoagent/browser-runtime.manifest
export CHROMIUM_BINARY=/home/nanoagent/.local/bin/chromium
export TOOLCHAIN_BOOTSTRAP_COMMAND=/usr/local/bin/bootstrap-toolchain DEVELOPER_TOOLS_BOOTSTRAP_COMMAND=/usr/local/bin/bootstrap-developer-tools
export PATH=/home/nanoagent/.local/bin:/home/nanoagent/go/bin:/home/nanoagent/.cargo/bin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export GOROOT=/home/nanoagent/.local/go NPM_CONFIG_PREFIX=/home/nanoagent/.local BUN_INSTALL=/home/nanoagent/.local XDG_CACHE_HOME=/home/nanoagent/.cache
exec /usr/bin/tini -g -- /usr/local/bin/nanoagent guest-init
