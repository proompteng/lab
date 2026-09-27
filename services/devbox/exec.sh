#!/usr/bin/env bash
set -euo pipefail
root="$(readlink -f /run/devbox-root)"
[[ "$root" == /persist/roots/* && -f "$root/.image-complete" ]]
exec chroot "$root" "$@"
