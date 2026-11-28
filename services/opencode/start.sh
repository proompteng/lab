#!/usr/bin/env bash
set -euo pipefail
umask 077
mkdir -p "$HOME" "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$XDG_STATE_HOME" "$XDG_CACHE_HOME" /workspace
password_file="$HOME/server-password"
if [[ ! -s "$password_file" ]]; then
  openssl rand -hex 32 > "$password_file.tmp"
  mv "$password_file.tmp" "$password_file"
fi
export OPENCODE_SERVER_PASSWORD
OPENCODE_SERVER_PASSWORD="$(cat "$password_file")"
if [[ ! -d /workspace/lab/.git ]]; then
  # Never replace a partially initialized or user-created workspace.
  if [[ -e /workspace/lab ]]; then
    printf '%s\n' 'Refusing to replace existing /workspace/lab without .git' >&2
    exit 1
  fi
  git clone https://github.com/proompteng/lab.git /workspace/lab
fi
cd /workspace/lab
exec opencode serve --hostname 0.0.0.0 --port 4096
