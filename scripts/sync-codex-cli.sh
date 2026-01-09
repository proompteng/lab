#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_WORKSPACE="lab"
DEFAULT_REMOTE_HOME='/home/coder'
DEFAULT_LOCAL_AUTH="$HOME/.codex/auth.json"
DEFAULT_CONFIG_TEMPLATE="$SCRIPT_DIR/codex-config-template.toml"
DEFAULT_REMOTE_AUTH="${DEFAULT_REMOTE_HOME}/.codex/auth.json"
DEFAULT_REMOTE_CONFIG="${DEFAULT_REMOTE_HOME}/.codex/config.toml"
DEFAULT_LOCAL_REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

usage() {
  cat <<'USAGE'
Usage: sync-codex-cli.sh [options]

Options:
  -w, --workspace NAME     Coder workspace name (default: proompteng)
  -a, --auth PATH          Local auth.json path (default: ~/.codex/auth.json)
  -c, --config PATH        Local config template path (default: scripts/codex-config-template.toml)
  -r, --repo PATH          Local repo root to sync skills from (default: repo containing this script)
      --remote-auth PATH   Remote auth destination (default: ~/.codex/auth.json)
      --remote-config PATH Remote config destination (default: ~/.codex/config.toml)
      --remote-home PATH   Remote home directory (default: /home/coder)
      --remote-repo PATH   Remote repo directory (default: <remote-home>/github.com/lab)
  -h, --help               Show this help message and exit
USAGE
}

shell_escape() {
  printf '%q' "$1"
}

workspace="$DEFAULT_WORKSPACE"
local_auth="$DEFAULT_LOCAL_AUTH"
template_path="$DEFAULT_CONFIG_TEMPLATE"
remote_auth="$DEFAULT_REMOTE_AUTH"
remote_config="$DEFAULT_REMOTE_CONFIG"
remote_home="$DEFAULT_REMOTE_HOME"
remote_repo=""
local_repo_root="$DEFAULT_LOCAL_REPO_ROOT"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -w|--workspace)
      workspace="$2"
      shift 2
      ;;
    -a|--auth)
      local_auth="$2"
      shift 2
      ;;
    -c|--config)
      template_path="$2"
      shift 2
      ;;
    -r|--repo)
      local_repo_root="$2"
      shift 2
      ;;
    --remote-auth)
      remote_auth="$2"
      shift 2
      ;;
    --remote-config)
      remote_config="$2"
      shift 2
      ;;
    --remote-home)
      remote_home="$2"
      shift 2
      ;;
    --remote-repo)
      remote_repo="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ ! -f "$local_auth" ]]; then
  echo "Missing local auth file: $local_auth" >&2
  exit 1
fi

if [[ ! -f "$template_path" ]]; then
  echo "Missing config template: $template_path" >&2
  exit 1
fi

if ! command -v coder >/dev/null 2>&1; then
  echo "coder CLI not found in PATH" >&2
  exit 1
fi

if ! command -v rsync >/dev/null 2>&1; then
  echo "rsync is required" >&2
  exit 1
fi

if ! command -v ssh >/dev/null 2>&1; then
  echo "OpenSSH ssh client is required" >&2
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI not found in PATH; install it to sync GitHub auth" >&2
  exit 1
fi

gh_token="$(gh auth token -h github.com 2>/dev/null || true)"
if [[ -z "$gh_token" ]]; then
  echo "Missing GitHub token for github.com; run 'gh auth login -h github.com -s repo,workflow' first" >&2
  exit 1
fi

if [[ -z "$remote_repo" ]]; then
  remote_repo="${remote_home%/}/github.com/lab"
fi

remote_auth_dir="${remote_auth%/*}"
if [[ "$remote_auth_dir" == "$remote_auth" ]]; then
  echo "Unable to determine remote directory from auth target: $remote_auth" >&2
  exit 1
fi

remote_config_dir="${remote_config%/*}"
if [[ "$remote_config_dir" == "$remote_config" ]]; then
  echo "Unable to determine remote directory from config target: $remote_config" >&2
  exit 1
fi

echo "Preparing to sync Codex CLI files to workspace '$workspace'"

coder_host="coder.${workspace}"
if ! ssh -G "$coder_host" >/dev/null 2>&1; then
  echo "SSH host entry '$coder_host' not found. Run 'coder config-ssh --yes' to configure SSH access." >&2
  exit 1
fi

ssh_opts=(-o BatchMode=yes -o ConnectTimeout=10)

init_cmd="set -euo pipefail; mkdir -p $(shell_escape "$remote_auth_dir") $(shell_escape "$remote_config_dir"); rm -f $(shell_escape "$remote_auth") $(shell_escape "$remote_config")"
# shellcheck disable=SC2029
ssh "${ssh_opts[@]}" "$coder_host" "$init_cmd"

if ! ssh "${ssh_opts[@]}" "$coder_host" "command -v gh >/dev/null 2>&1"; then
  echo "gh CLI not found on workspace '$workspace'; install it before syncing GitHub auth" >&2
  exit 1
fi

echo "Copying auth.json to $(shell_escape "$workspace:$remote_auth")"
RSYNC_RSH="ssh -o BatchMode=yes -o ConnectTimeout=10" rsync -av --progress "$local_auth" "$coder_host:$remote_auth"

# shellcheck disable=SC2029
ssh "${ssh_opts[@]}" "$coder_host" "chmod 600 $(shell_escape "$remote_auth")"

tmp_config=""
trap 'if [[ -n "$tmp_config" && -f "$tmp_config" ]]; then rm -f "$tmp_config"; fi' EXIT

local_home="$(cd "$HOME" && pwd)"
local_repo="${local_home%/}/github.com/lab"
remote_config_payload=$(cat "$template_path")
remote_config_payload=${remote_config_payload//$'\r'/}
remote_config_payload=${remote_config_payload//"{{REMOTE_PROJECT}}"/"$remote_repo"}
remote_config_payload=${remote_config_payload//"{{REMOTE_HOME}}"/"$remote_home"}
remote_config_payload=${remote_config_payload//"{{LOCAL_PROJECT}}"/"$remote_repo"}
remote_config_payload=${remote_config_payload//"{{LOCAL_HOME}}"/"$remote_home"}
remote_config_payload=${remote_config_payload//"{{LOCAL_PROJECT_PATH}}"/"$local_repo"}
remote_config_payload=${remote_config_payload//"{{LOCAL_HOME_PATH}}"/"$local_home"}
if [[ "$remote_config_payload" != *$'\n' ]]; then
  remote_config_payload+=$'\n'
fi

tmp_config=$(mktemp)
printf '%s' "$remote_config_payload" >"$tmp_config"

echo "Copying config.toml to $(shell_escape "$workspace:$remote_config")"
RSYNC_RSH="ssh -o BatchMode=yes -o ConnectTimeout=10" rsync -av --progress "$tmp_config" "$coder_host:$remote_config"

# shellcheck disable=SC2029
ssh "${ssh_opts[@]}" "$coder_host" "chmod 600 $(shell_escape "$remote_config")"

local_skills_dir="${local_repo_root%/}/skills"
remote_skills_dir="${remote_home%/}/.codex/skills"
if [[ -d "$local_skills_dir" ]]; then
  # shellcheck disable=SC2029
  ssh "${ssh_opts[@]}" "$coder_host" "mkdir -p $(shell_escape "$remote_skills_dir")"
  echo "Syncing skills to $(shell_escape "$workspace:$remote_skills_dir")"
  RSYNC_RSH="ssh -o BatchMode=yes -o ConnectTimeout=10" rsync -av --progress "$local_skills_dir"/ "$coder_host:$remote_skills_dir"/
else
  echo "No local skills directory found at $local_skills_dir; skipping skills sync"
fi

echo "Syncing GitHub CLI auth to $(shell_escape "$workspace")"
printf '%s' "$gh_token" | ssh "${ssh_opts[@]}" "$coder_host" "gh auth login -h github.com --with-token >/dev/null 2>&1"

ssh "${ssh_opts[@]}" "$coder_host" bash -s <<'REMOTE'
set -euo pipefail
codex_marker="# Managed by sync-codex-cli codex wrapper"
for rc in ~/.profile ~/.bashrc ~/.zshrc; do
  touch "${rc}"
  tmp="$(mktemp)"
  awk -v marker="$codex_marker" '
    BEGIN { skip = 0 }
    $0 == marker { skip = 1; next }
    skip {
      if ($0 ~ /^}\s*$/) { skip = 0 }
      next
    }
    /^alias codex=.*/ { next }
    /^shopt -s expand_aliases/ { next }
    { print }
  ' "${rc}" > "${tmp}"
  mv "${tmp}" "${rc}"
done
REMOTE

echo "Codex auth, config, skills, and GitHub auth synced to $workspace"
