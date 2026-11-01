#!/usr/bin/env bash
set -euo pipefail
umask 077

archive="${1:?browser runtime archive is required}"
[[ -s "$archive" ]]
browser_root="$HOME/.tengri/browser"
runtime_key="$(sha256sum "$archive" | cut -d ' ' -f 1)"
runtime_root="$browser_root/libraries-$runtime_key"
mkdir -p "$browser_root"
if [[ ! -f "$runtime_root/.verified" ]]; then
  temporary="$(mktemp -d "$browser_root/.libraries.XXXXXX")"
  trap 'rm -rf -- "$temporary"' EXIT HUP INT TERM
  mkdir -p "$temporary/runtime"
  tar --extract --xz --file "$archive" --directory "$temporary/runtime" --no-same-owner --no-same-permissions
  [[ -x "$temporary/runtime/usr/bin/Xtigervnc" && -x "$temporary/runtime/usr/bin/xdotool" && -x "$temporary/runtime/usr/bin/scrot" && -x "$temporary/runtime/usr/bin/xclip" ]]
  printf '%s\n' "$runtime_key" > "$temporary/runtime/.verified"
  mv "$temporary/runtime" "$runtime_root"
fi
[[ "$(<"$runtime_root/.verified")" == "$runtime_key" ]]
printf '%s\n' "$runtime_root" > "$browser_root/.runtime-path.$$"
mv -f "$browser_root/.runtime-path.$$" "$browser_root/runtime-path"
