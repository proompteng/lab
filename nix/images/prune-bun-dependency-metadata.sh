#!/usr/bin/env bash
set -euo pipefail

closure="${1:?dependency closure directory is required}"
test -d "${closure}/node_modules"
find "${closure}" -type d -name node_modules -prune -o -type f -exec rm -f {} +
