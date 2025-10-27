#!/usr/bin/env zsh
# shellcheck shell=bash
# Helper to create a worktree from main with dependency installs and Codex boot.
# The file is sourced from ~/.zshrc; keep the function idempotent.

create_tree() {
  local branch=$1
  if [ -z "$branch" ]; then
    echo "Usage: create_tree <branch-name>" >&2
    return 1
  fi

  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "create_tree: not inside a git repository" >&2
    return 1
  fi

  local repo_root worktrees_dir target_path
  repo_root=$(git rev-parse --show-toplevel) || {
    echo "create_tree: failed to resolve repository root" >&2
    return 1
  }
  worktrees_dir="$repo_root/.worktrees"

  if ! mkdir -p "$worktrees_dir"; then
    echo "create_tree: failed to ensure $worktrees_dir exists" >&2
    return 1
  fi

  target_path="$worktrees_dir/$branch"

  if [ -e "$target_path" ]; then
    echo "create_tree: target path already exists at $target_path" >&2
    return 1
  fi

  if ! git fetch origin main; then
    echo "create_tree: git fetch failed" >&2
    return 1
  fi

  local has_remote_branch=0
  local start_point="origin/main"
  if git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
    if git fetch origin "$branch" >/dev/null 2>&1; then
      has_remote_branch=1
      start_point="origin/$branch"
    fi
  fi

  if git show-ref --verify --quiet "refs/heads/$branch"; then
    if ! git worktree add "$target_path" "$branch"; then
      echo "create_tree: git worktree add failed" >&2
      return 1
    fi
  else
    if ! git worktree add "$target_path" -b "$branch" "$start_point"; then
      echo "create_tree: git worktree add failed" >&2
      return 1
    fi
  fi

  if [ "$has_remote_branch" -eq 1 ]; then
    if ! git -C "$target_path" branch --set-upstream-to="origin/$branch" "$branch"; then
      echo "create_tree: failed to set upstream to origin/$branch" >&2
      return 1
    fi
    if ! git -C "$target_path" pull --ff-only; then
      if ! git -C "$target_path" reset --hard "origin/$branch"; then
        echo "create_tree: failed to sync with origin/$branch" >&2
        return 1
      fi
    fi
  else
    git -C "$target_path" config branch."$branch".remote origin
    git -C "$target_path" config branch."$branch".merge "refs/heads/$branch"
    echo "create_tree: origin/$branch not found; configured tracking for first push" >&2
  fi

  if command -v pnpm >/dev/null 2>&1; then
    (cd "$target_path" && pnpm install) || {
      echo "create_tree: pnpm install failed" >&2
      return 1
    }
  else
    echo "create_tree: pnpm not found; skipping pnpm install" >&2
  fi

  if command -v bun >/dev/null 2>&1; then
    (cd "$target_path" && bun install) || {
      echo "create_tree: bun install failed" >&2
      return 1
    }
  else
    echo "create_tree: bun not found; skipping bun install" >&2
  fi

  echo "create_tree: worktree created at $target_path"
  cd "$target_path" || return 1
}
