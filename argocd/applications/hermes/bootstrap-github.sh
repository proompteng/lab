#!/bin/sh
set -eu

umask 077

gh_version=${GH_CLI_VERSION:-2.96.0}
gh_archive_name="gh_${gh_version}_linux_amd64.tar.gz"
gh_archive_sha256=${GH_CLI_ARCHIVE_SHA256:-83d5c2ccad5498f58bf6368acb1ab32588cf43ab3a4b1c301bf36328b1c8bd60}
gh_archive_url=${GH_CLI_ARCHIVE_URL:-https://github.com/cli/cli/releases/download/v${gh_version}/${gh_archive_name}}
gh_cache_dir=${GH_CLI_CACHE_DIR:-${HOME:?HOME is required}/.cache/hermes-tools}
gh_install_path=${GH_CLI_INSTALL_PATH:-/opt/tools/gh}
gh_config_dir=${GH_CONFIG_DIR:?GH_CONFIG_DIR is required}
gh_hosts_path=${gh_config_dir}/hosts.yml
gh_auth_stage_dir=${gh_config_dir}/.bootstrap.$$
git_config_path=${HERMES_GIT_CONFIG_PATH:-${HOME}/.gitconfig}
python_bin=${HERMES_PYTHON_BIN:-/opt/hermes/.venv/bin/python}
archive_path=${gh_cache_dir}/${gh_archive_name}
archive_tmp=${archive_path}.tmp.$$
extract_dir=${TMPDIR:-/tmp}/hermes-gh.$$
git_config_tmp=${git_config_path}.tmp.$$

case "$gh_version" in
  ''|*[!0-9.]*|.*|*.)
    echo "invalid GitHub CLI version: $gh_version" >&2
    exit 1
    ;;
esac
case "$gh_archive_sha256" in
  *[!0-9a-f]*|'')
    echo 'invalid GitHub CLI archive checksum' >&2
    exit 1
    ;;
esac
if [ "${#gh_archive_sha256}" -ne 64 ]; then
  echo 'invalid GitHub CLI archive checksum length' >&2
  exit 1
fi

cleanup() {
  rm -f -- "$archive_tmp" "$git_config_tmp"
  rm -rf -- "$extract_dir" "$gh_auth_stage_dir"
}
trap cleanup EXIT HUP INT TERM

gh_install_dir=$(dirname "$gh_install_path")
install -d -m 0700 "$gh_cache_dir" "$(dirname "$git_config_path")"
if [ ! -d "$gh_install_dir" ]; then
  install -d -m 0700 "$gh_install_dir"
fi
if [ ! -w "$gh_install_dir" ]; then
  echo "GitHub CLI install directory is not writable: $gh_install_dir" >&2
  exit 1
fi
if [ ! -d "$gh_config_dir" ]; then
  install -d -m 0700 "$gh_config_dir"
fi
if [ ! -w "$gh_config_dir" ]; then
  echo "GitHub CLI config directory is not writable: $gh_config_dir" >&2
  exit 1
fi
if [ -z "${GH_TOKEN:-}" ]; then
  echo 'GH_TOKEN is required for GitHub CLI bootstrap' >&2
  exit 1
fi
# This volume is per-Pod and the gateway has not started yet. Clear any file
# left by a failed init attempt so GitHub CLI never tries to migrate a
# partially initialized or read-only auth file on retry.
rm -f -- "$gh_hosts_path"

archive_is_valid() {
  [ -f "$archive_path" ] && printf '%s  %s\n' "$gh_archive_sha256" "$archive_path" | sha256sum -c - >/dev/null 2>&1
}

if ! archive_is_valid; then
  rm -f -- "$archive_path" "$archive_tmp"
  "$python_bin" - "$gh_archive_url" "$archive_tmp" <<'PY'
import os
import pathlib
import sys
import urllib.request

url, destination = sys.argv[1:]
maximum_bytes = 128 * 1024 * 1024
request = urllib.request.Request(url, headers={"User-Agent": "hermes-github-bootstrap/1"})
written = 0
with urllib.request.urlopen(request, timeout=120) as response:
    if response.status not in (None, 200):
        raise RuntimeError(f"GitHub CLI download returned HTTP {response.status}")
    with pathlib.Path(destination).open("xb") as target:
        while chunk := response.read(1024 * 1024):
            written += len(chunk)
            if written > maximum_bytes:
                raise RuntimeError("GitHub CLI archive exceeds the 128 MiB limit")
            target.write(chunk)
        target.flush()
        os.fsync(target.fileno())
if written == 0:
    raise RuntimeError("GitHub CLI download was empty")
PY
  printf '%s  %s\n' "$gh_archive_sha256" "$archive_tmp" | sha256sum -c - >/dev/null
  mv -- "$archive_tmp" "$archive_path"
fi

printf '%s  %s\n' "$gh_archive_sha256" "$archive_path" | sha256sum -c - >/dev/null
install -d -m 0700 "$extract_dir"
"$python_bin" - "$archive_path" "$extract_dir/gh" "$gh_version" <<'PY'
import pathlib
import shutil
import sys
import tarfile

archive_path, destination_path, version = sys.argv[1:]
member_name = f"gh_{version}_linux_amd64/bin/gh"
with tarfile.open(archive_path, "r:gz") as archive:
    member = archive.getmember(member_name)
    if not member.isfile() or member.size <= 0 or member.size > 128 * 1024 * 1024:
        raise RuntimeError("GitHub CLI archive contains an invalid gh binary")
    source = archive.extractfile(member)
    if source is None:
        raise RuntimeError("GitHub CLI binary could not be extracted")
    with source, pathlib.Path(destination_path).open("xb") as destination:
        shutil.copyfileobj(source, destination)
PY
install -m 0555 "$extract_dir/gh" "$gh_install_path"
"$gh_install_path" --version | grep -F "gh version $gh_version" >/dev/null

install -d -m 0700 "$gh_auth_stage_dir"
printf '%s' "$GH_TOKEN" | env -u GH_TOKEN -u GITHUB_TOKEN \
  GH_CONFIG_DIR="$gh_auth_stage_dir" GH_PROMPT_DISABLED=1 \
  "$gh_install_path" auth login \
    --hostname github.com \
    --git-protocol https \
    --with-token \
    --insecure-storage
if [ ! -s "$gh_auth_stage_dir/hosts.yml" ]; then
  echo 'GitHub CLI did not create its authentication file' >&2
  exit 1
fi
chmod 0600 "$gh_auth_stage_dir/hosts.yml"
github_login=$(env -u GH_TOKEN -u GITHUB_TOKEN GH_CONFIG_DIR="$gh_auth_stage_dir" \
  "$gh_install_path" api user --jq .login)
if [ "$github_login" != tuslagch ]; then
  echo "GitHub CLI authenticated as unexpected account: $github_login" >&2
  exit 1
fi
github_permission=$(env -u GH_TOKEN -u GITHUB_TOKEN GH_CONFIG_DIR="$gh_auth_stage_dir" \
  "$gh_install_path" repo view proompteng/lab --json viewerPermission --jq .viewerPermission)
if [ "$github_permission" != ADMIN ]; then
  echo "tuslagch lacks ADMIN permission on proompteng/lab: $github_permission" >&2
  exit 1
fi
mv -f -- "$gh_auth_stage_dir/hosts.yml" "$gh_hosts_path"
rm -rf -- "$gh_auth_stage_dir"

: >"$git_config_tmp"
chmod 0600 "$git_config_tmp"
git config --file "$git_config_tmp" user.name tuslagch
git config --file "$git_config_tmp" user.email 241203724+tuslagch@users.noreply.github.com
git config --file "$git_config_tmp" init.defaultBranch main
git config --file "$git_config_tmp" fetch.prune true
git config --file "$git_config_tmp" pull.ff only
git config --file "$git_config_tmp" push.default current
git config --file "$git_config_tmp" push.autoSetupRemote true
git config --file "$git_config_tmp" commit.gpgsign false
git config --file "$git_config_tmp" --add credential.https://github.com.helper ''
git config --file "$git_config_tmp" --add credential.https://github.com.helper "!$gh_install_path auth git-credential"
git config --file "$git_config_tmp" --add credential.https://gist.github.com.helper ''
git config --file "$git_config_tmp" --add credential.https://gist.github.com.helper "!$gh_install_path auth git-credential"
mv -- "$git_config_tmp" "$git_config_path"

printf 'github_bootstrap_ready=true gh_version=%s git_user=tuslagch repo_permission=ADMIN\n' "$gh_version"
