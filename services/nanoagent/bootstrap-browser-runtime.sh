#!/usr/bin/env bash
set -euo pipefail
umask 077

manifest="${1:?browser runtime manifest is required}"
[[ -s "$manifest" ]]
browser_root="$HOME/.tengri/browser"
runtime_key="$(sha256sum "$manifest" | cut -d ' ' -f 1)"
runtime_root="$browser_root/libraries-$runtime_key"
mkdir -p "$browser_root"
if [[ ! -f "$runtime_root/.verified" ]]; then
  temporary="$(mktemp -d "$browser_root/.libraries.XXXXXX")"
  trap 'rm -rf -- "$temporary"' EXIT HUP INT TERM
  mkdir -p "$temporary/packages" "$temporary/runtime"
  download() {
    local url="$1" digest="$2" destination="$3" algorithm value
    [[ "$url" == https://archive.ubuntu.com/ubuntu/pool/* || "$url" == https://security.ubuntu.com/ubuntu/pool/* || "$url" == https://ports.ubuntu.com/ubuntu-ports/pool/* ]]
    algorithm="${digest%%:*}"
    value="${digest#*:}"
    case "$algorithm" in
      SHA256) [[ "$value" =~ ^[0-9a-f]{64}$ ]]; algorithm=sha256sum ;;
      SHA512) [[ "$value" =~ ^[0-9a-f]{128}$ ]]; algorithm=sha512sum ;;
      *) return 1 ;;
    esac
    curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error \
      --retry 3 --retry-all-errors --connect-timeout 15 --max-time 180 "$url" --output "$destination"
    printf '%s  %s\n' "$value" "$destination" | "$algorithm" --check --status -
  }
  jobs=()
  sequence=0
  while read -r url digest extra; do
    [[ -n "$url" && -n "$digest" && -z "$extra" ]]
    ((sequence+=1))
    download "$url" "$digest" "$temporary/packages/$sequence.deb" &
    jobs+=("$!")
    if (( ${#jobs[@]} == 8 )); then
      for job in "${jobs[@]}"; do wait "$job"; done
      jobs=()
    fi
  done < "$manifest"
  for job in "${jobs[@]}"; do wait "$job"; done
  for package in "$temporary/packages/"*.deb; do dpkg-deb --extract "$package" "$temporary/runtime"; done
  [[ -x "$temporary/runtime/usr/bin/Xtigervnc" && -x "$temporary/runtime/usr/bin/xdotool" && -x "$temporary/runtime/usr/bin/scrot" ]]
  printf '%s\n' "$runtime_key" > "$temporary/runtime/.verified"
  mv "$temporary/runtime" "$runtime_root"
fi
[[ "$(<"$runtime_root/.verified")" == "$runtime_key" ]]
printf '%s\n' "$runtime_root" > "$browser_root/.runtime-path.$$"
mv -f "$browser_root/.runtime-path.$$" "$browser_root/runtime-path"
