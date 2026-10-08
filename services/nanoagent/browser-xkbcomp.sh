#!/usr/bin/env bash
set -euo pipefail
runtime_root="$(<"$HOME/.tengri/browser/runtime-path")"
[[ "$runtime_root" == "$HOME/.tengri/browser"/libraries-* && -f "$runtime_root/.verified" ]]
exec "$runtime_root/usr/bin/xkbcomp" "$@"
