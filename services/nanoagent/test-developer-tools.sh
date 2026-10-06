#!/usr/bin/env bash
set -euo pipefail

# Run inside the native guest image as UID 1000, with network disabled and an
# empty /home/nanoagent mount. The build smoke stage also starts with a clean home.
[[ "$(id -u)" == 1000 && "$HOME" == /home/nanoagent ]]
[[ ! -e "$HOME/.linuxbrew" && ! -e "$HOME/.config/nvim/init.lua" ]]
started="$(date +%s%N)"
bootstrap-spire-agent --install-only
spire_done="$(date +%s%N)"
bootstrap-toolchain --install-only
toolchain_done="$(date +%s%N)"
bootstrap-developer-tools --install-only
seed_done="$(date +%s%N)"
bootstrap-codex --install-only
bootstrap-code-server --install-only
runtime_tools_done="$(date +%s%N)"
# Installed by the guest image; the profile itself is linted from the repository.
# shellcheck source=/dev/null
. /etc/profile.d/tengri-development.sh
test "$EDITOR" = nvim
test "$(node --version)" = v24.11.1
test "$(gcc -dumpfullversion)" = 13.3.0
test "$(codex --version)" = 'codex-cli 0.159.2'
code-server --version > /tmp/offline-code-server-version
spire-agent --version
for command in brew tree-sitter gh fd fzf tmux make cmake pkg-config; do
  command -v "$command"
done
nvim --headless \
  '+lua assert(require("astronvim").version() == "v6.1.0"); for name,plugin in pairs(require("lazy.core.config").plugins) do assert(plugin._.installed,name .. " is missing") end' \
  '+if v:errmsg != "" | cquit 1 | endif' +qa
test "$(stat -c %u "$HOME/.linuxbrew" "$HOME/.local/share/nvim" \
  "$HOME/.config/nvim/init.lua" "$HOME/.config/nvim/lazy-lock.json" | sort -u)" = 1000
test -w "$HOME/.config/nvim/init.lua" && test -w "$HOME/.config/nvim/lazy-lock.json"
printf '#include <iostream>\nint main(){std::cout << "cpp-ok";}\n' > /tmp/seed-cpp.cpp
g++ /tmp/seed-cpp.cpp -o /tmp/seed-cpp
test "$(/tmp/seed-cpp)" = cpp-ok

# An existing home can select another GCC version through opt/gcc. Use the real
# native compiler behind an alternate filename to exercise that path offline.
gcc_link="$(readlink "$HOME/.linuxbrew/opt/gcc")"
cpp_compilers=("$HOME"/.linuxbrew/opt/gcc/bin/g++-*)
real_cpp="$(readlink -f "${cpp_compilers[0]}")"
mkdir -p "$HOME/.tengri/cpp-compat/bin"
printf '#!/bin/bash\nexec %q "$@"\n' "$real_cpp" > "$HOME/.tengri/cpp-compat/bin/g++-compat"
chmod 0700 "$HOME/.tengri/cpp-compat/bin/g++-compat"
ln -sfn "$HOME/.tengri/cpp-compat" "$HOME/.linuxbrew/opt/gcc"
g++ /tmp/seed-cpp.cpp -o /tmp/seed-cpp-compat
test "$(/tmp/seed-cpp-compat)" = cpp-ok
ln -sfn "$gcc_link" "$HOME/.linuxbrew/opt/gcc"

# Simulate an existing home and an interrupted seed. Preserve files, modes and
# links while filling a missing tool from the image without running Homebrew.
printf 'user shell settings\n' > "$HOME/.bashrc"
printf 'vim.g.user_config_preserved = true\n' > "$HOME/.config/nvim/init.lua"
printf 'user lockfile\n' > "$HOME/.config/nvim/lazy-lock.json"
printf 'user plugin data\n' > "$HOME/.local/share/nvim/user-data"
printf 'user brew settings\n' > "$HOME/.linuxbrew/user-settings"
printf 'user git settings\n' > "$HOME/.linuxbrew/Homebrew/.git/user-settings"
mkdir -p "$HOME/.codex" "$HOME/.tengri/vscode/User"
printf 'retained session fixture\n' > "$HOME/.codex/retained-session-fixture"
printf '{"editor.fontSize":15}\n' > "$HOME/.tengri/vscode/User/settings.json"
# An existing full manager must not acquire the baked shallow-history marker.
rm "$HOME/.linuxbrew/Homebrew/.git/shallow"
chmod 0700 "$HOME/.linuxbrew"
ln -s /tmp/user-link "$HOME/.linuxbrew/user-link"
sha256sum "$HOME/.bashrc" "$HOME/.config/nvim/"* "$HOME/.local/share/nvim/user-data" \
  "$HOME/.linuxbrew/user-settings" "$HOME/.linuxbrew/Homebrew/.git/user-settings" > /tmp/developer-home.sha256
sha256sum "$HOME/.codex/retained-session-fixture" "$HOME/.tengri/vscode/User/settings.json" \
  >> /tmp/developer-home.sha256
# A complete pre-seed home has no receipt. Deny package verification to prove it
# is adopted without reading/extracting the developer package on first resume.
rm "$HOME/.tengri/developer-tools-seed.sha256"
mkdir -p "$HOME/.tengri/no-seed-bin"
printf '#!/bin/bash\nexit 97\n' > "$HOME/.tengri/no-seed-bin/sha256sum"
chmod 0700 "$HOME/.tengri/no-seed-bin/sha256sum"
legacy_started="$(date +%s%N)"
PATH="$HOME/.tengri/no-seed-bin:$PATH" bootstrap-developer-tools --install-only
legacy_done="$(date +%s%N)"
test -f "$HOME/.tengri/developer-tools-seed.sha256"
sha256sum --check /tmp/developer-home.sha256
rm "$HOME/.tengri/developer-tools-seed.sha256" "$HOME/.linuxbrew/bin/fd"
bootstrap-developer-tools --install-only
test -x "$HOME/.linuxbrew/bin/fd"
test ! -e "$HOME/.linuxbrew/Homebrew/.git/shallow"
# A missing command is repaired locally even when the seed receipt exists.
rm "$HOME/.linuxbrew/bin/fd"
bootstrap-developer-tools --install-only
test -x "$HOME/.linuxbrew/bin/fd"
test ! -e "$HOME/.linuxbrew/Homebrew/.git/shallow"
test "$(stat -c %a "$HOME/.linuxbrew")" = 700
test "$(readlink "$HOME/.linuxbrew/user-link")" = /tmp/user-link
sha256sum --check /tmp/developer-home.sha256
restart_started="$(date +%s%N)"
NANOAGENT_TOOL_SEED_ROOT=/missing-image-seeds bootstrap-spire-agent --install-only
bootstrap-toolchain --install-only
developer_restart_started="$(date +%s%N)"
bootstrap-developer-tools --install-only
developer_restart_done="$(date +%s%N)"
NANOAGENT_TOOL_SEED_ROOT=/missing-image-seeds bootstrap-codex --install-only
NANOAGENT_TOOL_SEED_ROOT=/missing-image-seeds bootstrap-code-server --install-only
restart_done="$(date +%s%N)"
sha256sum --check /tmp/developer-home.sha256
nvim --headless '+lua assert(vim.g.user_config_preserved)' '+if v:errmsg != "" | cquit 1 | endif' +qa

# Fresh homes fail closed when image packages are absent or corrupt, without a
# downloader or a partially published executable. Existing installs above need
# no seed at all and retain their original manifest and versioned directory.
bad_seeds="$HOME/.tengri/invalid-image-seeds"
mkdir -p "$bad_seeds"
for tool in spire-agent codex code-server; do
  IFS= read -r archive < <("bootstrap-$tool" --archive-manifest)
  for failure in missing corrupt; do
    bad_home="$HOME/.tengri/$tool-$failure-home"
    if [[ "$failure" == corrupt ]]; then
      printf 'invalid archive\n' > "$bad_seeds/$archive"
      printf '%064d  %s\n' 0 "$archive" > "$bad_seeds/$archive.sha256"
    fi
    if env HOME="$bad_home" NANOAGENT_TOOL_SEED_ROOT="$bad_seeds" \
      "bootstrap-$tool" --install-only > /tmp/invalid-image-seed.log 2>&1; then
      printf 'bootstrap-%s accepted a %s image package\n' "$tool" "$failure" >&2
      exit 1
    fi
    test ! -e "$bad_home/.local/bin/$tool"
    test -z "$(find "$bad_home" -name '.install.*' -print -quit)"
  done
done

# Respect custom XDG locations, including an existing Vim configuration.
mkdir -p "$HOME/.custom-config/nvim"
printf 'let g:user_config_preserved = 1\n' > "$HOME/.custom-config/nvim/init.vim"
XDG_CONFIG_HOME="$HOME/.custom-config" XDG_DATA_HOME="$HOME/.custom-data" bootstrap-developer-tools --install-only
test ! -e "$HOME/.custom-config/nvim/init.lua"
test ! -e "$HOME/.custom-data/nvim"
XDG_CONFIG_HOME="$HOME/.fresh-config" XDG_DATA_HOME="$HOME/.fresh-data" bootstrap-developer-tools --install-only
test -f "$HOME/.fresh-config/nvim/lazy-lock.json"
test -d "$HOME/.fresh-data/nvim/lazy/lazy.nvim"
XDG_CONFIG_HOME="$HOME/.fresh-config" XDG_DATA_HOME="$HOME/.fresh-data" nvim --headless \
  '+lua assert(require("astronvim").version() == "v6.1.0")' '+if v:errmsg != "" | cquit 1 | endif' +qa
printf 'offline_spire_seed_ms=%s\noffline_toolchain_ms=%s\noffline_developer_seed_ms=%s\noffline_fresh_tools_ms=%s\noffline_legacy_developer_resume_ms=%s\noffline_developer_restart_ms=%s\noffline_retained_home_resume_ms=%s\n' \
  "$(((spire_done-started)/1000000))" "$(((toolchain_done-spire_done)/1000000))" \
  "$(((seed_done-toolchain_done)/1000000))" "$(((runtime_tools_done-started)/1000000))" \
  "$(((legacy_done-legacy_started)/1000000))" \
  "$(((developer_restart_done-developer_restart_started)/1000000))" \
  "$(((restart_done-restart_started)/1000000))"
