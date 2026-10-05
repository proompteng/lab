#!/usr/bin/env bash
set -euo pipefail

readonly SEED_ROOT='/usr/share/nanoagent'
fail() { printf 'bootstrap-developer-tools: %s\n' "$*" >&2; exit 1; }
temporary_directory=''
cleanup() { if [[ -n "$temporary_directory" ]]; then rm -rf -- "$temporary_directory"; fi; }

seed_archive() {
  local archive="$1" destination="$2" staging_root="$2"
  [[ "$destination" != "$HOME" ]] || staging_root="$HOME/.tengri"
  temporary_directory="$(mktemp -d "$staging_root/.developer-seed.XXXXXX")"
  tar --extract --xz --file "$archive" --directory "$temporary_directory" \
    --no-same-owner --no-same-permissions
  # Link complete staged files atomically, preserving existing files and directory
  # metadata. A killed copy cannot leave a partially written executable in HOME.
  cp -a --link --no-clobber --no-preserve=mode,ownership,timestamps \
    "$temporary_directory/." "$destination/"
  cleanup
  temporary_directory=''
}

[[ "${1:-}" == --install-only ]] || fail 'expected --install-only'
# Homebrew bottles, symlinks and compiled plugin paths are relocated at image time.
[[ "${HOME:-}" == /home/nanoagent ]] || fail 'the image seed requires HOME=/home/nanoagent'
[[ "$(id -u)" != 0 ]] || fail 'the image seed must run as the guest user'
umask 022
mkdir -p "$HOME/.tengri"
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

receipt="$HOME/.tengri/developer-tools-seed.sha256"
expected="$(cat "$SEED_ROOT/developer-tools.tar.xz.sha256")"
prefix="$HOME/.linuxbrew"
needs_seed=false
for command in brew nvim tree-sitter gh fd fzf tmux make cmake pkg-config; do
  [[ -x "$prefix/bin/$command" ]] || needs_seed=true
done
[[ -x "$HOME/.local/bin/g++" && -x "$HOME/.local/bin/c++" ]] || needs_seed=true
if [[ "$needs_seed" == true || ! -f "$receipt" || "$(cat "$receipt")" != "$expected" ]]; then
  (cd "$SEED_ROOT" && sha256sum --check --status developer-tools.tar.xz.sha256)
  seed_archive "$SEED_ROOT/developer-tools.tar.xz" "$HOME"
fi

config="${XDG_CONFIG_HOME:-$HOME/.config}/nvim"
data="${XDG_DATA_HOME:-$HOME/.local/share}/nvim"
# Seed the default editor only when no user configuration is present. Keep its
# lockfile with the matching preinstalled data; never run Lazy/Mason at startup.
if [[ ! -e "$config/init.lua" && ! -L "$config/init.lua" && ! -e "$config/init.vim" && ! -L "$config/init.vim" ]]; then
  mkdir -p "$config" "$data"
  seed_archive "$SEED_ROOT/astronvim.tar.xz" "$data"
  temporary_directory="$(mktemp -d "$config/.developer-seed.XXXXXX")"
  install -m 0644 "$SEED_ROOT/astronvim-lazy-lock.json" "$temporary_directory/lazy-lock.json"
  install -m 0644 "$SEED_ROOT/astronvim-init.lua" "$temporary_directory/init.lua"
  cp -a --link --no-clobber --no-preserve=mode,ownership,timestamps "$temporary_directory/." "$config/"
  cleanup
  temporary_directory=''
fi

[[ "$(stat -c %u "$prefix")" == "$(id -u)" ]] || fail 'Homebrew prefix has a different owner'
for command in brew nvim tree-sitter gh fd fzf tmux make cmake pkg-config; do
  [[ -x "$prefix/bin/$command" ]] || fail "developer command is missing: $command"
done
[[ -x "$HOME/.local/bin/g++" && -x "$HOME/.local/bin/c++" ]] || fail 'C++ compiler is missing'
"$prefix/bin/nvim" --headless -u NONE '+lua assert(vim.fn.has("nvim-0.11") == 1)' \
  '+if v:errmsg != "" | cquit 1 | endif' +qa

temporary_receipt="$(mktemp "$HOME/.tengri/.developer-tools-seed.XXXXXX")"
printf '%s\n' "$expected" > "$temporary_receipt"
mv -Tf "$temporary_receipt" "$receipt"
