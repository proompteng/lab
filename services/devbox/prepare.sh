#!/usr/bin/env bash
set -euo pipefail
export HOME=/root
# shellcheck source=services/devbox/profile.sh
source /etc/profile.d/devbox.sh
revision="$(cat /opt/devbox/source-revision)"
[[ "$revision" =~ ^[0-9a-f]{40}$ ]]
install -d -o codex -g codex /home/codex/src /home/codex/.cargo /home/codex/.codex /home/codex/.local/bin
repo=/home/codex/src/lab
if [[ ! -d "$repo/.git" ]]; then
  if [[ -e "$repo" ]]; then
    echo 'Refusing to replace a workspace without Git metadata' >&2
    exit 1
  fi
  stage="$(mktemp -d /home/codex/src/.lab-initialize.XXXXXX)"
  trap 'rm -rf -- "$stage"' EXIT
  chown codex:codex "$stage"
  runuser -u codex -- git clone --filter=blob:none https://github.com/proompteng/lab.git "$stage"
  runuser -u codex -- git -C "$stage" checkout --detach "$revision"
  cp -a /opt/lab-seed/node_modules "$stage/node_modules"
  chown -R codex:codex "$stage/node_modules"
  mv "$stage" "$repo"
  trap - EXIT
fi
if [[ ! -f /home/codex/.codex/AGENTS.md ]]; then
  printf 'poteto mode and pstack. no subagents\n' > /home/codex/.codex/AGENTS.md
  chown codex:codex /home/codex/.codex/AGENTS.md
fi
if [[ ! -f /home/codex/.devbox-initialized ]]; then
  runuser -l codex -c 'cd ~/src/lab && devbox-install-deps'
  runuser -l codex -c 'cd ~/src/lab && nix develop --command toolchain-doctor'
  touch /home/codex/.devbox-initialized
  chown codex:codex /home/codex/.devbox-initialized
fi
runuser -l codex -c 'export XDG_RUNTIME_DIR=/run/user/1000; codex app-server daemon bootstrap && codex app-server daemon start'
printf '%s\n' "$revision" > /var/lib/devbox/last-ready.tmp
mv /var/lib/devbox/last-ready.tmp /var/lib/devbox/last-ready
touch /run/devbox-ready
