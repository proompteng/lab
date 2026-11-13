#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

[[ "${GITHUB_REF:-}" == 'refs/heads/main' ]] || fail 'Bayn publication requires the main branch.'
case "${GITHUB_EVENT_NAME:-}" in
  push|workflow_dispatch) ;;
  *) fail 'Bayn publication requires a main push or an explicit recovery dispatch.' ;;
esac
[[ "${GITHUB_SHA:-}" =~ ^[0-9a-f]{40}$ && "$GITHUB_SHA" != 0000000000000000000000000000000000000000 ]] ||
  fail 'Bayn publication requires an exact source commit.'
[[ "$(git rev-parse HEAD)" == "$GITHUB_SHA" ]] || fail 'The checkout does not match the publication source.'

if [[ "$GITHUB_EVENT_NAME" == 'workflow_dispatch' ]]; then
  [[ "${BAYN_EXPECTED_MAIN_SHA:-}" == "$GITHUB_SHA" ]] || fail 'Recovery source does not match the expected main commit.'
  # Recheck before discovery as well as admission. Do not substitute a newer checkout or reuse old validation.
  current_main="$(git ls-remote --exit-code origin refs/heads/main)"
  [[ "$current_main" == "$GITHUB_SHA"$'\trefs/heads/main' ]] || fail 'Recovery source is no longer current main.'
fi
