#!/usr/bin/env bash
set -euo pipefail

readonly prefix="$HOME/.linuxbrew"
readonly receipt="$HOME/.local/share/nanoagent/developer-tools-ready"
readonly work="$(mktemp -d "$HOME/.cache/developer-tools-test.XXXXXX")"
readonly bootstrap="${1:-/usr/local/bin/bootstrap-developer-tools}"

cleanup() {
  local command
  for command in brew nvim fd; do
    if [[ -e "$work/$command" || -L "$work/$command" ]]; then
      rm -f -- "$prefix/bin/$command"
      mv -- "$work/$command" "$prefix/bin/$command"
    fi
  done
  cp -- "$work/receipt" "$receipt"
  rm -rf -- "$work"
}

test -s "$receipt"
cp -- "$receipt" "$work/receipt"
trap cleanup EXIT
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

cp -- "$work/receipt" "$receipt"
mv -- "$prefix/bin/fd" "$work/fd"
if "$bootstrap" --install-only; then
  printf 'A missing executable incorrectly skipped installation\n' >&2
  exit 1
fi
test ! -e "$receipt"
mv -- "$work/fd" "$prefix/bin/fd"

cp -- "$work/receipt" "$receipt"
if XDG_CONFIG_HOME="$work/config" "$bootstrap" --install-only; then
  printf 'A different Neovim configuration incorrectly reused its receipt\n' >&2
  exit 1
fi
test ! -e "$receipt"
printf 'Prepared homes skip installers; stale and incomplete homes require successful installation.\n'
