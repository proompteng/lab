#!/usr/bin/env bash
set -euo pipefail

export HOME="${HOME:-/workspace/.agents-shell/home}"
mkdir -p "${HOME}" /workspace/.agents-shell

git config --global user.name "${AGENTS_SHELL_GIT_USER_NAME:-Greg Konush}"
git config --global user.email "${AGENTS_SHELL_GIT_USER_EMAIL:-greg@proompteng.ai}"
git config --global --add safe.directory /workspace/lab
git config --global init.defaultBranch main

if [[ -n "${GITHUB_TOKEN:-}" && -z "${GH_TOKEN:-}" ]]; then
  export GH_TOKEN="${GITHUB_TOKEN}"
fi
if [[ -n "${GH_TOKEN:-}" && -z "${GITHUB_TOKEN:-}" ]]; then
  export GITHUB_TOKEN="${GH_TOKEN}"
fi
if [[ -n "${GH_TOKEN:-}" ]]; then
  gh auth setup-git --hostname github.com
fi

exec bun run start:agents-shell
