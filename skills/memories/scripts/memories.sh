#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: memories.sh save --task-name bumba-enrich-repo --content "Enrichment facts for services/bumba" --summary "Bumba repo facts" --tags "bumba,enrich"" >&2
  exit 1
fi

CMD="$1"
shift

case "$CMD" in
  save)
    exec bun run --filter memories save-memory "$@"
    ;;
  retrieve)
    exec bun run --filter memories retrieve-memory "$@"
    ;;
  *)
    echo "Unknown command: $CMD" >&2
    exit 1
    ;;
esac
