#!/bin/bash
set -euo pipefail
mount -t proc proc /proc
mount -t sysfs sysfs /sys
if ! mountpoint -q /dev; then
  mount -t devtmpfs devtmpfs /dev
fi
mkdir -p /dev/pts /run /tmp
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
export TOOLCHAIN_BOOTSTRAP_COMMAND=/usr/local/bin/bootstrap-toolchain DEVELOPER_TOOLS_BOOTSTRAP_COMMAND=/usr/local/bin/bootstrap-developer-tools
export PATH=/home/nanoagent/.local/bin:/home/nanoagent/go/bin:/home/nanoagent/.cargo/bin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export GOROOT=/home/nanoagent/.local/go NPM_CONFIG_PREFIX=/home/nanoagent/.local BUN_INSTALL=/home/nanoagent/.local XDG_CACHE_HOME=/home/nanoagent/.cache
exec /usr/bin/tini -g -- /usr/local/bin/nanoagent guest-init
