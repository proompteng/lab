#!/usr/bin/env bash
set -euo pipefail

readonly SEED_ROOT='/usr/share/nanoagent'
fail() { printf 'bootstrap-developer-tools: %s\n' "$*" >&2; exit 1; }
temporary_directory=''
cleanup() { if [[ -n "$temporary_directory" ]]; then rm -rf -- "$temporary_directory"; fi; }

cpp_wrapper_contents() {
  local prefix="$1" c_root="$2" triplet="$3"
  printf '#!/usr/bin/env bash\n'
  printf 'compilers=(%q/opt/gcc/bin/g++-*)\n' "$prefix"
  # These expressions are emitted into the generated wrapper.
  # shellcheck disable=SC2016
  printf '[[ "${#compilers[@]}" == 1 && -x "${compilers[0]}" ]] || exit 1\n'
  # shellcheck disable=SC2016
  printf 'exec "${compilers[0]}" --sysroot=%q -idirafter %q -idirafter %q -B%q "$@"\n' \
    "$c_root/sysroot" "$c_root/sysroot/usr/include" \
    "$c_root/sysroot/usr/include/$triplet" "$c_root/sysroot/usr/lib/$triplet/"
}

managed_cpp_wrapper() {
  local content="$1" previous_root line compiler previous
  [[ "$content" == "$(cpp_wrapper_contents "$prefix" "$c_root" "$triplet")" ]] && return 0
  line="${content##*$'\n'}"
  previous_root="${line#* --sysroot=}"
  previous_root="${previous_root%% -idirafter *}"
  previous_root="${previous_root%/sysroot}"
  [[ "$previous_root" == "$HOME"/.tengri/toolchains/*/c ]] || return 1
  [[ "$content" == "$(cpp_wrapper_contents "$prefix" "$previous_root" "$triplet")" ]] && return 0
  # Before offline seeds, Nanoagent emitted the selected GCC filename directly.
  compiler="${line#exec }"
  compiler="${compiler%% --sysroot=*}"
  [[ "$compiler" == "$prefix"/opt/gcc/bin/g++-* && "${compiler##*/g++-}" =~ ^[0-9]+$ ]] || return 1
  previous="$(printf '#!/usr/bin/env bash\nexec %q --sysroot=%q -idirafter %q -idirafter %q -B%q "$@"\n' \
    "$compiler" "$previous_root/sysroot" "$previous_root/sysroot/usr/include" \
    "$previous_root/sysroot/usr/include/$triplet" "$previous_root/sysroot/usr/lib/$triplet/")"
  [[ "$content" == "$previous" ]]
}

tools_present() {
  local command
  [[ "$(stat -c %u "$prefix")" == "$(id -u)" ]] || return 1
  for command in brew nvim tree-sitter gh fd fzf tmux make cmake pkg-config; do
    [[ -x "$prefix/bin/$command" ]] || return 1
  done
  [[ -x "$HOME/.local/bin/g++" && -x "$HOME/.local/bin/c++" ]] || return 1
  [[ "$(readlink -f "$HOME/.local/bin/c++")" == "$(readlink -f "$HOME/.local/bin/g++")" ]] || return 1
  local compilers=("$prefix"/opt/gcc/bin/g++-*)
  [[ "${#compilers[@]}" == 1 && -x "${compilers[0]}" ]] || return 1
  [[ "$(<"$HOME/.local/bin/g++")" == "$(cpp_wrapper_contents "$prefix" "$c_root" "$triplet")" ]] || return 1
  [[ -f "$c_root/sysroot/usr/include/features.h" ]] || return 1
  [[ -e "$config/init.lua" || -e "$config/init.vim" ]] || return 1
  if cmp -s "$SEED_ROOT/astronvim-init.lua" "$config/init.lua"; then
    [[ -f "$config/lazy-lock.json" && -d "$data/lazy/lazy.nvim" && -d "$data/lazy/AstroNvim" ]] || return 1
  fi
}

seed_archive() {
  local archive="$1" destination="$2" staging_root="$2"
  local exclusions=()
  if [[ "$destination" == "$HOME" && ( -e "$HOME/.linuxbrew/Homebrew/.git" || -L "$HOME/.linuxbrew/Homebrew/.git" ) ]]; then
    # An existing manager keeps its own history and update metadata, including
    # a full repository's absence of the image's shallow-history marker.
    exclusions+=(--exclude='.linuxbrew/Homebrew/.git')
  fi
  [[ "$destination" != "$HOME" ]] || staging_root="$HOME/.tengri"
  temporary_directory="$(mktemp -d "$staging_root/.developer-seed.XXXXXX")"
  tar --extract --xz --file "$archive" --directory "$temporary_directory" \
    --no-same-owner --no-same-permissions "${exclusions[@]}"
  if [[ "$destination" == "$HOME" && -d "$temporary_directory/.linuxbrew/Homebrew/.git" ]]; then
    # Publish a new manager's complete Git metadata atomically. A killed file
    # copy must not leave partial metadata that a retry treats as a user repo.
    mkdir -p "$HOME/.linuxbrew/Homebrew"
    mv --no-clobber --no-target-directory "$temporary_directory/.linuxbrew/Homebrew/.git" \
      "$HOME/.linuxbrew/Homebrew/.git"
    rm -rf -- "$temporary_directory/.linuxbrew/Homebrew/.git"
  fi
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
pending="$HOME/.tengri/developer-tools-seed.pending"
expected="$(cat "$SEED_ROOT/developer-tools.tar.xz.sha256")"
prefix="$HOME/.linuxbrew"
config="${XDG_CONFIG_HOME:-$HOME/.config}/nvim"
data="${XDG_DATA_HOME:-$HOME/.local/share}/nvim"
go_root="$(readlink -f "$HOME/.local/go")"
c_root="${go_root%/*}/c"
case "$(uname -m)" in
  x86_64) triplet=x86_64-linux-gnu ;;
  aarch64|arm64) triplet=aarch64-linux-gnu ;;
  *) fail 'unsupported architecture' ;;
esac
ready_receipt="$HOME/.local/share/nanoagent/developer-tools-ready"
fingerprint="$(sha256sum "${BASH_SOURCE[0]}" "$SEED_ROOT/astronvim-init.lua")"
fingerprint+=$'\n'"$expected"$'\n'"$config"$'\n'"$data"$'\n'"$c_root"
if [[ ! -e "$pending" && ! -L "$pending" && -f "$receipt" && "$(<"$receipt")" == "$expected" &&
      -f "$ready_receipt" && "$(<"$ready_receipt")" == "$fingerprint" ]] && tools_present; then
  exit 0
fi
rm -f -- "$ready_receipt"

seeds_verified=false
needs_seed=false
for command in brew nvim tree-sitter gh fd fzf tmux make cmake pkg-config; do
  [[ -x "$prefix/bin/$command" ]] || needs_seed=true
done
# A complete retained home predating image seeds needs no archive extraction.
# Recheck a changed image receipt, and always repair missing commands locally.
if [[ "$needs_seed" == true || -e "$pending" || -L "$pending" || ( -f "$receipt" && "$(cat "$receipt")" != "$expected" ) ]]; then
  (cd "$SEED_ROOT" && sha256sum --check --status developer-tools.tar.xz.sha256)
  seeds_verified=true
  # Retain an interrupted seed marker until all files and the receipt are
  # complete. Executable links alone cannot prove a killed copy finished.
  temporary_receipt="$(mktemp "$HOME/.tengri/.developer-tools-seed.XXXXXX")"
  printf '%s\n' "$expected" > "$temporary_receipt"
  mv -Tf "$temporary_receipt" "$pending"
  seed_archive "$SEED_ROOT/developer-tools.tar.xz" "$HOME"
fi

# Seed the default editor only when no user configuration is present. Keep its
# lockfile with the matching preinstalled data; never run Lazy/Mason at startup.
if [[ ! -e "$config/init.lua" && ! -L "$config/init.lua" && ! -e "$config/init.vim" && ! -L "$config/init.vim" ]] ||
    { cmp -s "$SEED_ROOT/astronvim-init.lua" "$config/init.lua" &&
      [[ ! -f "$config/lazy-lock.json" || ! -d "$data/lazy/lazy.nvim" || ! -d "$data/lazy/AstroNvim" ]]; }; then
  [[ "$seeds_verified" == true ]] || (cd "$SEED_ROOT" && sha256sum --check --status developer-tools.tar.xz.sha256)
  mkdir -p "$config" "$data"
  seed_archive "$SEED_ROOT/astronvim.tar.xz" "$data"
  temporary_directory="$(mktemp -d "$config/.developer-seed.XXXXXX")"
  install -m 0644 "$SEED_ROOT/astronvim-lazy-lock.json" "$temporary_directory/lazy-lock.json"
  install -m 0644 "$SEED_ROOT/astronvim-init.lua" "$temporary_directory/init.lua"
  cp -a --link --no-clobber --no-preserve=mode,ownership,timestamps "$temporary_directory/." "$config/"
  cleanup
  temporary_directory=''
fi

cpp_compilers=("$prefix"/opt/gcc/bin/g++-*)
[[ "${#cpp_compilers[@]}" == 1 && -x "${cpp_compilers[0]}" ]] || fail 'Homebrew C++ compiler is unavailable or ambiguous'
[[ -f "$c_root/sysroot/usr/include/features.h" ]] || fail 'persistent C development headers are unavailable'
# Refresh only recognized Nanoagent wrappers. Unrelated user files and links
# are preserved, and incomplete or incompatible tools fail startup visibly.
if [[ -e "$HOME/.local/bin/g++" || -L "$HOME/.local/bin/g++" ]]; then
  if [[ -L "$HOME/.local/bin/g++" ]] || ! managed_cpp_wrapper "$(<"$HOME/.local/bin/g++")"; then
    fail 'custom g++ wrapper was preserved; a Nanoagent-managed wrapper is required'
  fi
fi
if [[ -e "$HOME/.local/bin/c++" || -L "$HOME/.local/bin/c++" ]]; then
  [[ -L "$HOME/.local/bin/c++" && "$(readlink "$HOME/.local/bin/c++")" == "$HOME/.local/bin/g++" ]] ||
    fail 'custom c++ file or link was preserved; the Nanoagent g++ link is required'
fi
# Retain dynamic Homebrew opt/gcc selection while rebinding the pinned C sysroot.
mkdir -p "$HOME/.local/bin"
cpp_wrapper="$(mktemp "$HOME/.local/bin/.cpp-wrapper.XXXXXX")"
cpp_wrapper_contents "$prefix" "$c_root" "$triplet" > "$cpp_wrapper"
chmod 0700 "$cpp_wrapper"
mv -Tf "$cpp_wrapper" "$HOME/.local/bin/g++"
ln -sfn "$HOME/.local/bin/g++" "$HOME/.local/bin/c++"
tools_present || fail 'developer tools are incomplete or incompatible'
"$prefix/bin/nvim" --headless -u NONE '+lua assert(vim.fn.has("nvim-0.11") == 1)' \
  '+if v:errmsg != "" | cquit 1 | endif' +qa

temporary_receipt="$(mktemp "$HOME/.tengri/.developer-tools-seed.XXXXXX")"
printf '%s\n' "$expected" > "$temporary_receipt"
mv -Tf "$temporary_receipt" "$receipt"
rm -f -- "$pending"

mkdir -p "$(dirname "$ready_receipt")"
temporary_receipt="$(mktemp "${ready_receipt}.XXXXXX")"
printf '%s\n' "$fingerprint" > "$temporary_receipt"
mv -Tf "$temporary_receipt" "$ready_receipt"
