#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
case "${1:---check}" in --check|--write) ;; *) printf 'Expected --check or --write\n' >&2; exit 2 ;; esac
exec python3 tests/platform_fixture.py qualify "${1:---check}"
