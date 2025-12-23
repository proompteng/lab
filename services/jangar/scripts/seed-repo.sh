#!/usr/bin/env bash
set -euo pipefail

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 1
  fi
}

resolve_repo_slug() {
  if [ -n "${CODEX_REPO_SLUG:-}" ]; then
    echo "$CODEX_REPO_SLUG"
    return
  fi

  if [ -n "${CODEX_REPO_URL:-}" ]; then
    local url="$CODEX_REPO_URL"
    url="${url%.git}"
    url="${url#https://github.com/}"
    url="${url#git@github.com:}"
    echo "$url"
    return
  fi

  echo ""
}

ensure_gh_auth() {
  if gh auth status -h github.com >/dev/null 2>&1; then
    return
  fi

  if [ -n "${GH_TOKEN:-}" ]; then
    printf '%s' "$GH_TOKEN" | gh auth login --with-token
    return
  fi

  echo "gh is not authenticated. Set GH_TOKEN or run 'gh auth login'." >&2
  exit 1
}

main() {
  require_cmd gh
  require_cmd git

  local repo_slug
  repo_slug="$(resolve_repo_slug)"
  if [ -z "$repo_slug" ]; then
    echo "missing repo slug. Set CODEX_REPO_SLUG or CODEX_REPO_URL." >&2
    exit 1
  fi

  local repo_dir="${CODEX_CWD:-/workspace/lab}"
  local repo_branch="${CODEX_REPO_REF:-main}"
  local repo_url="https://github.com/${repo_slug}.git"

  ensure_gh_auth
  gh auth setup-git >/dev/null 2>&1 || true

  if [ -d "$repo_dir/.git" ]; then
    git -C "$repo_dir" remote set-url origin "$repo_url"
    git -C "$repo_dir" fetch --prune origin
    if git -C "$repo_dir" show-ref --verify --quiet "refs/heads/${repo_branch}"; then
      git -C "$repo_dir" checkout "$repo_branch"
    else
      git -C "$repo_dir" checkout -B "$repo_branch" "origin/${repo_branch}"
    fi
    git -C "$repo_dir" reset --hard "origin/${repo_branch}"
  else
    rm -rf "$repo_dir"
    gh repo clone "$repo_slug" "$repo_dir"
    git -C "$repo_dir" checkout "$repo_branch" || true
  fi

  echo "seeded ${repo_slug} into ${repo_dir} at ${repo_branch}"
}

main "$@"
