#!/usr/bin/env bash
set -Eeuo pipefail

case "${1:-}" in
  3.11.*) options=(--extended-verify) ;;
  4.1.*|5.0.*) options=(--force --extended-verify) ;;
  *) printf 'Unsupported Cassandra rehearsal version: %s\n' "${1:-missing}" >&2; exit 1 ;;
esac
# This helper runs only against isolated, disposable restore data. Cassandra 4+
# disables verify unless explicitly enabled; do not mutate repair status or invoke
# the disk failure policy, and propagate every native verification error.
exec nodetool verify "${options[@]}" temporal
