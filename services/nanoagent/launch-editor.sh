#!/bin/sh
set -eu
# Lua bytecode caches are regenerable; keep their many small writes off Ceph.
XDG_CACHE_HOME="/tmp/tengri-editor-cache-$(id -u)"
export XDG_CACHE_HOME
exec /opt/tengri/editor/nvim/bin/nvim "$@"
