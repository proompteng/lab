#!/usr/bin/env bash
set -euo pipefail

if ! command -v git >/dev/null 2>&1; then
  echo "Missing git CLI" >&2
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "Missing gh CLI" >&2
  exit 1
fi

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || {
  echo "Run this helper from inside a Git repository" >&2
  exit 1
}

TEMPLATE="$REPO_ROOT/.github/PULL_REQUEST_TEMPLATE.md"
if [[ ! -f "$TEMPLATE" ]]; then
  echo "Missing PR template at $TEMPLATE" >&2
  exit 1
fi

BODY_WAS_PROVIDED=false
if [[ -n "${PR_BODY_PATH:-}" ]]; then
  BODY_FILE=$PR_BODY_PATH
  if [[ -f "$BODY_FILE" ]]; then
    BODY_WAS_PROVIDED=true
  else
    cp "$TEMPLATE" "$BODY_FILE"
  fi
else
  BODY_FILE=$(mktemp "${TMPDIR:-/tmp}/pr-body.XXXXXX")
  cp "$TEMPLATE" "$BODY_FILE"
fi

if [[ "$BODY_WAS_PROVIDED" == false ]]; then
  EDITOR_COMMAND=${VISUAL:-${EDITOR:-}}
  if [[ -z "$EDITOR_COMMAND" ]]; then
    echo "Edit the PR body at $BODY_FILE, then rerun with PR_BODY_PATH set to that file" >&2
    exit 2
  fi

  "$EDITOR_COMMAND" "$BODY_FILE"
fi

if [[ ! -s "$BODY_FILE" ]]; then
  echo "PR body is empty: $BODY_FILE" >&2
  exit 1
fi

if cmp -s "$TEMPLATE" "$BODY_FILE"; then
  echo "Refusing to create a PR from the unchanged template: $BODY_FILE" >&2
  exit 1
fi

gh auth status >/dev/null
cd "$REPO_ROOT"
exec gh pr create --body-file "$BODY_FILE" "$@"
