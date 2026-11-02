#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
for command in entry-timing-export capital-study matched-entry-study jev-signal-study jev-abstention-report verify-jev-plan native-arrival-coverage; do
  help="$(node "$repo_root/services/bayn/dist/research/$command.js" --help)"
  if [[ "$help" != "Usage: node dist/research/$command.js "* || "$help" == *$'\n'* ]]; then
    printf 'Expected only %s help, received:\n%s\n' "$command" "$help" >&2
    exit 1
  fi
done
