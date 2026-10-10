#!/usr/bin/env bash
set -euo pipefail

readonly prefix="$HOME/.linuxbrew"
readonly receipt="$HOME/.local/share/nanoagent/developer-tools-ready"
work="$(mktemp -d "$HOME/.cache/developer-tools-test.XXXXXX")"
readonly work
readonly bootstrap="${1:-/usr/local/bin/bootstrap-developer-tools}"

cleanup() {
  if [[ -e "$work/g++" ]]; then
    mv -f -- "$work/g++" "$HOME/.local/bin/g++"
  fi
  if [[ -e "$work/go" || -L "$work/go" ]]; then
    rm -f -- "$HOME/.local/go"
    mv -- "$work/go" "$HOME/.local/go"
  fi
  local command
  for command in brew nvim fd lazygit gdu-go btm kubectl; do
    if [[ -e "$work/$command" || -L "$work/$command" ]]; then
      rm -f -- "$prefix/bin/$command"
      mv -- "$work/$command" "$prefix/bin/$command"
    fi
  done
  cp -- "$work/init.lua" "$HOME/.config/nvim/init.lua"
  cp -- "$work/receipt" "$receipt"
  rm -rf -- "$work"
}

test -s "$receipt"
cp -- "$receipt" "$work/receipt"
cp -- "$HOME/.config/nvim/init.lua" "$work/init.lua"
trap cleanup EXIT

# Upgrade untouched generated configs, while preserving edits and the plugin lockfile.
sha256sum "$HOME/.config/nvim/lazy-lock.json" > "$work/plugins.sha256"
sed 's/icons_enabled = true/icons_enabled = false/' "$work/init.lua" > "$HOME/.config/nvim/init.lua"
old_init_hash="$(sha256sum "$HOME/.config/nvim/init.lua" | cut -d ' ' -f 1)"
awk -v hash="$old_init_hash" 'NR == 2 { $1 = hash } { print }' "$work/receipt" > "$receipt"
"$bootstrap" --install-only
cmp -- /usr/share/nanoagent/astronvim-init.lua "$HOME/.config/nvim/init.lua"
sha256sum --check "$work/plugins.sha256"

printf '\nvim.g.user_config_preserved = true\n' >> "$HOME/.config/nvim/init.lua"
cp -- "$HOME/.config/nvim/init.lua" "$work/custom.lua"
sed '1s/.*/outdated installation/' "$work/receipt" > "$receipt"
"$bootstrap" --install-only
cmp -- "$work/custom.lua" "$HOME/.config/nvim/init.lua"
sha256sum --check "$work/plugins.sha256"
cp -- "$work/init.lua" "$HOME/.config/nvim/init.lua"

for command in brew nvim; do
  mv -- "$prefix/bin/$command" "$work/$command"
  printf '#!/usr/bin/env bash\nexit 97\n' > "$prefix/bin/$command"
  chmod 0755 "$prefix/bin/$command"
done

# Prepared homes must not spawn either package manager or editor on resume.
"$bootstrap" --install-only
cmp -- "$receipt" "$work/receipt"

printf 'outdated installation\n' > "$receipt"
if "$bootstrap" --install-only; then
  printf 'An outdated receipt incorrectly skipped installation\n' >&2
  exit 1
fi
test ! -e "$receipt"

for command in fd lazygit gdu-go btm kubectl; do
  cp -- "$work/receipt" "$receipt"
  mv -- "$prefix/bin/$command" "$work/$command"
  if "$bootstrap" --install-only; then
    printf 'A missing %s executable incorrectly skipped installation\n' "$command" >&2
    exit 1
  fi
  test ! -e "$receipt"
  mv -- "$work/$command" "$prefix/bin/$command"
done

cp -- "$work/receipt" "$receipt"
mv -- "$HOME/.local/bin/g++" "$work/g++"
printf '#!/usr/bin/env bash\nexit 97\n' > "$HOME/.local/bin/g++"
chmod 0755 "$HOME/.local/bin/g++"
if "$bootstrap" --install-only; then
  printf 'A stale C++ wrapper incorrectly reused its receipt\n' >&2
  exit 1
fi
test ! -e "$receipt"
mv -f -- "$work/g++" "$HOME/.local/bin/g++"

cp -- "$work/receipt" "$receipt"
if XDG_CONFIG_HOME="$work/config" "$bootstrap" --install-only; then
  printf 'A different Neovim configuration incorrectly reused its receipt\n' >&2
  exit 1
fi
test ! -e "$receipt"

cp -- "$work/receipt" "$receipt"
mv -- "$HOME/.local/go" "$work/go"
mkdir -p "$work/toolchain/go" "$work/toolchain/c/sysroot/usr/include"
touch "$work/toolchain/c/sysroot/usr/include/features.h"
ln -s "$work/toolchain/go" "$HOME/.local/go"
if "$bootstrap" --install-only; then
  printf 'A different toolchain incorrectly reused its C++ wrapper receipt\n' >&2
  exit 1
fi
test ! -e "$receipt"
printf 'Prepared homes skip installers; stale, incomplete, and changed-toolchain homes require successful installation.\n'
