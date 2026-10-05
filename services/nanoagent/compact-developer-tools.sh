#!/usr/bin/env bash
set -euo pipefail

# Build-only: keep the manager checkout and current version metadata, without
# carrying old commits and reflogs into every fresh persistent home. Never run
# this against a guest's existing Homebrew repository.
repository="$HOME/.linuxbrew/Homebrew"
printf 'developer_architecture=%s\n' "$(uname -m)"
du --bytes --max-depth=2 "$HOME/.linuxbrew" "$HOME/.local/share/nvim"
find "$HOME/.local/share/nvim" -type d -name .git -prune -exec du --bytes --summarize {} +
find "$HOME/.linuxbrew" "$HOME/.local/share/nvim" -type f -printf '%s %p\n' | sort -nr | sed -n '1,30p'
temporary="$(mktemp -d)"
trap 'rm -rf -- "$temporary"' EXIT
"$HOME/.linuxbrew/bin/brew" --version > "$temporary/brew-version"
"$HOME/.linuxbrew/bin/brew" list --versions > "$temporary/brew-packages"
find "$HOME/.linuxbrew" -name .git -prune -o -type f -print0 | \
  sort -z | xargs -0 sha256sum > "$temporary/runtime.sha256"
test -s "$temporary/runtime.sha256"
python3 - "$temporary/runtime.sha256" <<'PY'
import collections
import os
import sys

groups = collections.defaultdict(list)
with open(sys.argv[1]) as manifest:
    for line in manifest:
        digest, path = line.rstrip("\n").split("  ", 1)
        metadata = os.stat(path)
        if metadata.st_size >= 1024 * 1024:
            groups[digest].append((path, metadata.st_size, metadata.st_dev, metadata.st_ino))
for files in groups.values():
    if len(files) > 1:
        inodes = {(item[2], item[3]) for item in files}
        redundant = (len(inodes) - 1) * files[0][1]
        print(f"duplicate_runtime_bytes={redundant} paths=" + " | ".join(item[0] for item in files))
PY
head="$(git -C "$repository" rev-parse HEAD)"
branch="$(git -C "$repository" symbolic-ref --quiet --short HEAD || true)"
tag="$(git -C "$repository" describe --tags --exact-match 2>/dev/null || true)"
origin_head="$(git -C "$repository" symbolic-ref --quiet refs/remotes/origin/HEAD || true)"
[[ -n "$branch" || -n "$tag" ]]
printf 'homebrew_history_before_bytes=%s\n' "$(du -sb "$repository/.git" | cut -f1)"
git clone --quiet --depth 1 --single-branch --no-tags --branch "${branch:-$tag}" \
  "file://$repository" "$temporary/checkout"
# Keep current local and remote branch tips used by Homebrew's updater, with
# their history bounded to one commit as well.
git -C "$temporary/checkout" fetch --quiet --depth 1 --update-head-ok --no-tags origin \
  '+refs/heads/*:refs/heads/*' '+refs/remotes/*:refs/remotes/*'
if [[ -n "$tag" ]]; then
  git -C "$temporary/checkout" fetch --quiet --depth 1 origin "refs/tags/$tag:refs/tags/$tag"
  test "$(git -C "$temporary/checkout" rev-parse "refs/tags/$tag")" = "$(git -C "$repository" rev-parse "refs/tags/$tag")"
fi
if [[ -n "$origin_head" ]]; then
  git -C "$temporary/checkout" symbolic-ref refs/remotes/origin/HEAD "$origin_head"
else
  git -C "$temporary/checkout" update-ref --no-deref -d refs/remotes/origin/HEAD
fi
test "$(git -C "$temporary/checkout" rev-parse HEAD)" = "$head"
# Preserve the upstream URL, fetch refspec and branch configuration rather than
# leaving the temporary local clone as the manager's update source.
cp "$repository/.git/config" "$temporary/checkout/.git/config"
mv "$repository/.git" "$temporary/original-history"
mv "$temporary/checkout/.git" "$repository/.git"
test "$(git -C "$repository" rev-parse HEAD)" = "$head"
test "$(git -C "$repository" symbolic-ref --quiet --short HEAD || true)" = "$branch"
test "$(git -C "$repository" describe --tags --exact-match 2>/dev/null || true)" = "$tag"
git -C "$repository" diff --exit-code --quiet
sha256sum --check --status "$temporary/runtime.sha256"
"$HOME/.linuxbrew/bin/brew" --version | cmp - "$temporary/brew-version"
"$HOME/.linuxbrew/bin/brew" list --versions | cmp - "$temporary/brew-packages"
printf 'homebrew_history_after_bytes=%s\n' "$(du -sb "$repository/.git" | cut -f1)"
du --bytes --summarize "$HOME/.cache/Homebrew"
"$HOME/.linuxbrew/bin/brew" doctor
