#!/usr/bin/env bash
set -euo pipefail

readonly INSTALLER_COMMIT='35da6871c4be7d7fdab2fd505fb7fa667926a2a5'
readonly INSTALLER_SHA256='5f333bbe53bc490e51e7ccb1df8779b3dd6ee73a1a7379efda216edb08ccb148'
readonly FORMULAE=(neovim tree-sitter-cli gh fd fzf tmux make cmake pkgconf gcc)
installer=''

fail() { printf 'bootstrap-developer-tools: %s\n' "$*" >&2; exit 1; }
cleanup() { if [[ -n "$installer" ]]; then rm -f -- "$installer"; fi; }

install_tools() {
  [[ "$(uname -s)" == Linux ]] || fail 'developer tools require Linux'
  case "$(uname -m)" in x86_64|aarch64|arm64) ;; *) fail 'unsupported architecture' ;; esac
  [[ "$(id -u)" != 0 ]] || fail 'Homebrew must run as the guest user'
  [[ -n "${HOME:-}" && "$HOME" == /* ]] || fail 'HOME must be an absolute path'
  local prefix="$HOME/.linuxbrew"
  local config="${XDG_CONFIG_HOME:-$HOME/.config}/nvim"
  local receipt="$HOME/.local/share/nanoagent/developer-tools-ready"
  local fingerprint
  fingerprint="$(sha256sum "${BASH_SOURCE[0]}" /usr/share/nanoagent/astronvim-init.lua)"
  fingerprint+=$'\n'"$config"$'\n'"${XDG_DATA_HOME:-$HOME/.local/share}/nvim"
  [[ "${#prefix}" -le 26 ]] || fail 'Homebrew prefix exceeds the supported Linux bottle relocation length'
  export HOMEBREW_NO_ANALYTICS=1 HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_SUDO=1
  export HOMEBREW_CACHE="$HOME/.cache/Homebrew"
  umask 022
  mkdir -p "$HOME/.cache" "$HOME/.local/bin"
  if [[ -f "$receipt" && "$(cat "$receipt")" == "$fingerprint" ]] && tools_present "$prefix" "$config"; then
    return
  fi
  rm -f -- "$receipt"
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
  local installed
  installed="$("$prefix/bin/brew" list --formula --versions)"
  local missing=()
  for formula in "${FORMULAE[@]}"; do
    if ! grep -q "^$formula " <<< "$installed"; then
      missing+=("$formula")
    fi
  done
  if (( ${#missing[@]} )); then
    "$prefix/bin/brew" install --formula --force-bottle "${missing[@]}"
  fi
  local cpp_compilers=("$prefix"/opt/gcc/bin/g++-*)
  [[ "${#cpp_compilers[@]}" == 1 && -x "${cpp_compilers[0]}" ]] || fail 'Homebrew C++ compiler is unavailable or ambiguous'
  local c_root
  c_root="$(dirname "$(readlink -f "$HOME/.local/go")")/c"
  local triplet
  case "$(uname -m)" in
    x86_64) triplet=x86_64-linux-gnu ;;
    aarch64|arm64) triplet=aarch64-linux-gnu ;;
  esac
  [[ -f "$c_root/sysroot/usr/include/features.h" ]] || fail 'persistent C development headers are unavailable'
  local cpp_wrapper
  cpp_wrapper="$(mktemp "$HOME/.local/bin/.cpp-wrapper.XXXXXX")"
  {
    printf '#!/usr/bin/env bash\n'
    printf 'exec %q --sysroot=%q -idirafter %q -idirafter %q -B%q "$@"\n' \
      "${cpp_compilers[0]}" "$c_root/sysroot" "$c_root/sysroot/usr/include" \
      "$c_root/sysroot/usr/include/$triplet" "$c_root/sysroot/usr/lib/$triplet/"
  } > "$cpp_wrapper"
  chmod 0700 "$cpp_wrapper"
  mv -Tf "$cpp_wrapper" "$HOME/.local/bin/g++"
  ln -sfn "$HOME/.local/bin/g++" "$HOME/.local/bin/c++"
  for command in nvim tree-sitter gh fd fzf tmux make cmake pkg-config; do
    [[ -x "$prefix/bin/$command" ]] || fail "developer command is missing: $command"
  done
  if ! "$prefix/bin/nvim" --headless -u NONE '+lua assert(vim.fn.has("nvim-0.11") == 1)' \
    '+if v:errmsg != "" | cquit 1 | endif' +qa; then
    HOMEBREW_NO_ASK=1 "$prefix/bin/brew" upgrade --formula --force-bottle neovim
    "$prefix/bin/nvim" --headless -u NONE '+lua assert(vim.fn.has("nvim-0.11") == 1)' \
      '+if v:errmsg != "" | cquit 1 | endif' +qa
  fi
  mkdir -p "$config"
  if [[ ! -e "$config/init.lua" && ! -e "$config/init.vim" ]]; then
    local init
    init="$(mktemp "$config/.init.XXXXXX")"
    install -m 0644 /usr/share/nanoagent/astronvim-init.lua "$init"
    mv -Tf "$init" "$config/init.lua"
  fi
  if cmp -s /usr/share/nanoagent/astronvim-init.lua "$config/init.lua"; then
    "$prefix/bin/nvim" --headless \
      "+lua require('lazy').install({wait=true,show=false}); for name,plugin in pairs(require('lazy.core.config').plugins) do assert(plugin._.installed,name .. ' is missing'); for _,task in ipairs(plugin._.tasks or {}) do assert(not task:has_errors(),name .. ' failed installation') end end" \
      "+lua assert(require('astronvim').version() == 'v6.1.0'); assert(vim.v.errmsg == '',vim.v.errmsg)" \
      '+if v:errmsg != "" | cquit 1 | endif' +qa
  fi
  mkdir -p "$(dirname "$receipt")"
  local staging
  staging="$(mktemp "${receipt}.XXXXXX")"
  printf '%s\n' "$fingerprint" > "$staging"
  mv -Tf "$staging" "$receipt"
}

tools_present() {
  local prefix="$1" config="$2" command
  [[ -x "$prefix/bin/brew" && "$(stat -c %u "$prefix")" == "$(id -u)" ]] || return 1
  for command in nvim tree-sitter gh fd fzf tmux make cmake pkg-config; do
    [[ -x "$prefix/bin/$command" ]] || return 1
  done
  [[ -x "$HOME/.local/bin/g++" && -x "$HOME/.local/bin/c++" ]] || return 1
  local compilers=("$prefix"/opt/gcc/bin/g++-*)
  [[ "${#compilers[@]}" == 1 && -x "${compilers[0]}" ]] || return 1
  [[ -f "$HOME/.local/go/../c/sysroot/usr/include/features.h" ]] || return 1
  [[ -e "$config/init.lua" || -e "$config/init.vim" ]] || return 1
  if cmp -s /usr/share/nanoagent/astronvim-init.lua "$config/init.lua"; then
    local data="${XDG_DATA_HOME:-$HOME/.local/share}/nvim/lazy"
    [[ -f "$config/lazy-lock.json" && -d "$data/lazy.nvim" && -d "$data/AstroNvim" ]] || return 1
  fi
}

case "${1:-}" in
  --install-only) install_tools ;;
  *) fail 'expected --install-only' ;;
esac
