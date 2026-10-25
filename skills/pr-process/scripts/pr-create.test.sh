#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
SCRIPT="$SCRIPT_DIR/pr-create.sh"
TEST_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/pr-create-test.XXXXXX")
TEST_ROOT=$(cd "$TEST_ROOT" && pwd -P)
REPO_ROOT="$TEST_ROOT/repo"
CALLER_DIR="$REPO_ROOT/nested dir"
MOCK_BIN="$TEST_ROOT/bin"
ARGS_FILE="$TEST_ROOT/gh-args"
EDITOR_ARGS_FILE="$TEST_ROOT/editor-args"
TMP_DIR="$TEST_ROOT/tmp"

cleanup() {
  rm -rf -- "$TEST_ROOT"
}
trap cleanup EXIT

mkdir -p "$REPO_ROOT/.github" "$CALLER_DIR" "$MOCK_BIN" "$TMP_DIR"
printf '# Pull request template\n' >"$REPO_ROOT/.github/PULL_REQUEST_TEMPLATE.md"
printf '# Completed body\n' >"$CALLER_DIR/body file.md"

cat >"$MOCK_BIN/git" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [[ "$*" != 'rev-parse --show-toplevel' ]]; then
  echo "Unexpected git invocation: $*" >&2
  exit 1
fi

printf '%s\n' "$TEST_REPO_ROOT"
EOF

cat >"$MOCK_BIN/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == 'auth' ]]; then
  if [[ "${TEST_FAIL_AUTH_STATUS:-false}" == true ]]; then
    exit 17
  fi
  exit 0
fi

if [[ "${1:-}" != 'pr' || "${2:-}" != 'create' ]]; then
  echo "Unexpected gh invocation: $*" >&2
  exit 1
fi

printf '%s\n' "$@" >"$TEST_GH_ARGS_FILE"
EOF

cat >"$MOCK_BIN/editor" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$@" >"$TEST_EDITOR_ARGS_FILE"
for body_file; do
  :
done
printf '\nEdited body\n' >>"$body_file"
EOF

chmod +x "$MOCK_BIN/git" "$MOCK_BIN/gh" "$MOCK_BIN/editor"

run_helper() {
  local fail_auth_status=$1

  (
    cd "$CALLER_DIR"
    PATH="$MOCK_BIN:$PATH" \
      PR_BODY_PATH='body file.md' \
      TEST_FAIL_AUTH_STATUS="$fail_auth_status" \
      TEST_GH_ARGS_FILE="$ARGS_FILE" \
      TEST_REPO_ROOT="$REPO_ROOT" \
      "$SCRIPT" --title 'fix(test): preserve caller paths'
  )
}

run_interactive_helper() {
  (
    cd "$CALLER_DIR"
    PATH="$MOCK_BIN:$PATH" \
      TEST_EDITOR_ARGS_FILE="$EDITOR_ARGS_FILE" \
      TEST_GH_ARGS_FILE="$ARGS_FILE" \
      TEST_REPO_ROOT="$REPO_ROOT" \
      TMPDIR="$TMP_DIR" \
      VISUAL="$MOCK_BIN/editor --wait" \
      "$SCRIPT" --title 'fix(test): preserve editor arguments'
  )
}

assert_arg() {
  local line=$1
  local expected=$2
  local actual

  actual=$(sed -n "${line}p" "$ARGS_FILE")
  if [[ "$actual" != "$expected" ]]; then
    echo "Argument $line: expected '$expected', got '$actual'" >&2
    exit 1
  fi
}

run_helper false
assert_arg 1 'pr'
assert_arg 2 'create'
assert_arg 3 '--body-file'
assert_arg 4 "$CALLER_DIR/body file.md"
assert_arg 5 '--title'
assert_arg 6 'fix(test): preserve caller paths'

rm -f "$ARGS_FILE"
run_helper true
assert_arg 1 'pr'
assert_arg 2 'create'

rm -f "$ARGS_FILE"
run_interactive_helper
assert_arg 1 'pr'
assert_arg 2 'create'
assert_arg 3 '--body-file'
if [[ "$(sed -n '1p' "$EDITOR_ARGS_FILE")" != '--wait' ]]; then
  echo 'Editor did not receive its configured argument' >&2
  exit 1
fi
if [[ "$(sed -n '2p' "$EDITOR_ARGS_FILE")" != "$(sed -n '4p' "$ARGS_FILE")" ]]; then
  echo 'Editor and gh received different body paths' >&2
  exit 1
fi

echo 'pr-create tests passed'
