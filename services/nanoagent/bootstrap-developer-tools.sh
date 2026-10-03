#!/usr/bin/env bash
set -euo pipefail

readonly INSTALLER_COMMIT='35da6871c4be7d7fdab2fd505fb7fa667926a2a5'
readonly INSTALLER_SHA256='5f333bbe53bc490e51e7ccb1df8779b3dd6ee73a1a7379efda216edb08ccb148'
readonly FORMULAE=(neovim gh fd fzf tmux make cmake pkgconf gcc)
installer=''

fail() { printf 'bootstrap-developer-tools: %s\n' "$*" >&2; exit 1; }
cleanup() { if [[ -n "$installer" ]]; then rm -f -- "$installer"; fi; }

install_tools() {
  [[ "$(uname -s)" == Linux ]] || fail 'developer tools require Linux'
  case "$(uname -m)" in x86_64|aarch64|arm64) ;; *) fail 'unsupported architecture' ;; esac
  [[ "$(id -u)" != 0 ]] || fail 'Homebrew must run as the guest user'
  [[ -n "${HOME:-}" && "$HOME" == /* ]] || fail 'HOME must be an absolute path'
  local prefix="$HOME/.linuxbrew"
  [[ "${#prefix}" -le 26 ]] || fail 'Homebrew prefix exceeds the supported Linux bottle relocation length'
  export HOMEBREW_NO_ANALYTICS=1 HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_SUDO=1
  export HOMEBREW_CACHE="$HOME/.cache/Homebrew"
  umask 022
  mkdir -p "$HOME/.cache" "$HOME/.local/bin"
  if [[ ! -x "$prefix/bin/brew" ]]; then
    installer="$(mktemp "$HOME/.cache/homebrew-install.XXXXXX")"
    trap cleanup EXIT HUP INT TERM
    curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error \
      --retry 3 --retry-all-errors --connect-timeout 15 --max-time 120 \
      --output "$installer" \
      "https://raw.githubusercontent.com/Homebrew/install/$INSTALLER_COMMIT/install.sh"
    printf '%s  %s\n' "$INSTALLER_SHA256" "$installer" | sha256sum --check --status -
    NONINTERACTIVE=1 /bin/bash "$installer" --path="$prefix"
    cleanup
    installer=''
    trap - EXIT HUP INT TERM
  fi
  [[ "$(stat -c %u "$prefix")" == "$(id -u)" ]] || fail 'Homebrew prefix has a different owner'
  eval "$("$prefix/bin/brew" shellenv bash)"
  # Preserve the pinned language toolchains ahead of optional Homebrew packages.
  export PATH="$HOME/.local/bin:$HOME/go/bin:$HOME/.cargo/bin:$PATH"
  local missing=()
  for formula in "${FORMULAE[@]}"; do
    if ! "$prefix/bin/brew" list --versions "$formula" >/dev/null 2>&1; then
      missing+=("$formula")
    fi
  done
  if (( ${#missing[@]} )); then
    "$prefix/bin/brew" install --formula --force-bottle "${missing[@]}"
  fi
  local cpp_compilers=("$prefix"/opt/gcc/bin/g++-*)
  [[ "${#cpp_compilers[@]}" == 1 && -x "${cpp_compilers[0]}" ]] || fail 'Homebrew C++ compiler is unavailable or ambiguous'
  ln -sfn "${cpp_compilers[0]}" "$HOME/.local/bin/g++"
  ln -sfn "${cpp_compilers[0]}" "$HOME/.local/bin/c++"
  for command in nvim gh fd fzf tmux make cmake pkg-config; do
    [[ -x "$prefix/bin/$command" ]] || fail "developer command is missing: $command"
  done
  "$prefix/bin/nvim" --headless -u NONE '+lua assert(vim.fn.has("nvim-0.10") == 1)' +qa
  local config="${XDG_CONFIG_HOME:-$HOME/.config}/nvim"
  mkdir -p "$config"
  if [[ ! -e "$config/init.lua" && ! -e "$config/init.vim" ]]; then
    printf '%s\n' \
      'vim.opt.number = true' \
      'vim.opt.termguicolors = true' \
      'vim.opt.mouse = "a"' \
      'vim.opt.undofile = true' \
      'vim.fn.mkdir(vim.fn.stdpath("state") .. "/undo", "p")' \
      'vim.opt.undodir = vim.fn.stdpath("state") .. "/undo"' \
      > "$config/init.lua"
  fi
}

case "${1:-}" in
  --install-only) install_tools ;;
  *) fail 'expected --install-only' ;;
esac
