#!/usr/bin/env bash
set -euo pipefail
root="$(readlink -f /run/devbox-root)"
[[ "$root" == /persist/roots/* && -f "$root/.image-complete" ]] || exit 1
exec chroot "$root" "$@"
