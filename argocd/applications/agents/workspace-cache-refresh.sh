#!/usr/bin/env bash
set -euo pipefail
umask 022

root="${1:?workspace cache directory is required}"
repository=https://github.com/proompteng/lab.git
mirror="$root/git/proompteng/lab.git"
bun_cache="$root/bun-cache"
worktree="$root/.bun-worktree"

github_auth="Authorization: Basic $(printf 'x-access-token:%s' "${GITHUB_TOKEN:?github-token is required}" | base64 | tr -d '\n')"
trap 'rm -rf -- "$worktree"' EXIT

# One writer per node. Alternate between two slots so interruptions cannot change the
# published snapshot and in-flight readers can finish on the previous one.
inactive_slot() {
  local live="$1"
  if [[ $(readlink "$live") == "${live##*/}.0" ]]; then
    printf '%s.1\n' "$live"
  else
    printf '%s.0\n' "$live"
  fi
}

publish() {
  local staged="$1" live="$2"
  ln -sfn "${staged##*/}" "$live.next"
  # Rename the link itself in place instead of following the live symlink into its directory.
  bun -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' "$live.next" "$live"
}

git_cache() {
  # Scope HTTP auth to the upstream without writing credentials to the mirror config.
  WORKSPACE_CACHE_GIT_AUTH="$github_auth" git \
    "--config-env=http.$repository.extraHeader=WORKSPACE_CACHE_GIT_AUTH" \
    -c pack.threads=1 -c pack.windowMemory=128m -c maintenance.autoDetach=false -c gc.autoDetach=false "$@"
}

mkdir -p "$(dirname "$mirror")"
staged_mirror=$(inactive_slot "$mirror")
rm -rf -- "$staged_mirror"
if [[ -f "$mirror/.refreshed" ]]; then
  # The local clone hardlinks immutable objects, but keeps its own refs and config.
  git_cache clone --mirror --local "$mirror" "$staged_mirror"
  git_cache -C "$staged_mirror" remote set-url origin "$repository"
  git_cache -C "$staged_mirror" fetch --atomic --prune origin
else
  git_cache clone --mirror "$repository" "$staged_mirror"
fi
revision=$(git_cache -C "$staged_mirror" rev-parse --verify 'refs/heads/main^{commit}')
touch "$staged_mirror/.refreshed"
publish "$staged_mirror" "$mirror"

# Prewarm only the first-turn context retrieval closure, not the entire monorepo.
lock=$(git_cache -C "$mirror" rev-parse --verify "$revision:bun.lock")
bun_version=$(bun --version)
key="$bun_version $lock"
rm -rf -- "$worktree"
if [[ -f "$bun_cache/.key" && $(cat "$bun_cache/.key") == "$key" ]]; then
  exit 0
fi
staged_bun=$(inactive_slot "$bun_cache")
rm -rf -- "$staged_bun"
mkdir -p "$staged_bun" "$worktree"
git_cache -C "$mirror" ls-tree -r -z --name-only "$revision" > "$worktree/paths"
inputs=()
while IFS= read -r -d '' path; do
  case "$path" in
    bun.lock | package.json | */package.json | bunfig.toml | .npmrc | patches/*) inputs+=("$path") ;;
  esac
done < "$worktree/paths"
git_cache -C "$mirror" archive "$revision" -- "${inputs[@]}" | tar -x -C "$worktree"
(
  cd "$worktree"
  env -u GITHUB_TOKEN BUN_INSTALL_CACHE_DIR="$staged_bun" \
    bun install --frozen-lockfile --prefer-offline --ignore-scripts --production --omit=peer --filter memories
)
printf '%s\n' "$key" > "$staged_bun/.key"
publish "$staged_bun" "$bun_cache"
