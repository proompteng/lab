#!/usr/bin/env bash
set -euo pipefail

readonly PLAYWRIGHT_VERSION='1.59.1'
readonly PLAYWRIGHT_SHA256='22304c3d9106ed8372ff58656f645a93bc3a2b17df8567f1413079a730d8d6fa'

case "${1:-}" in
  --validate-manifest) exit 0 ;;
  --install-only) ;;
  *) printf 'bootstrap-browser: expected --install-only or --validate-manifest\n' >&2; exit 1 ;;
esac
[[ "$(uname -s)" == Linux && -n "${HOME:-}" && "$HOME" == /* ]]
umask 077
browser_root="$HOME/.tengri/browser"
package_root="$browser_root/playwright-$PLAYWRIGHT_VERSION"
export PLAYWRIGHT_BROWSERS_PATH="$browser_root/engines"
mkdir -p "$browser_root" "$HOME/.local/bin"
if [[ -n "${BROWSER_RUNTIME_MANIFEST:-}" ]]; then
  /usr/local/bin/bootstrap-browser-runtime "$BROWSER_RUNTIME_MANIFEST"
fi
if [[ ! -f "$package_root/.verified" ]]; then
  browser_temporary="$(mktemp -d "$browser_root/.install.XXXXXX")"
  trap 'rm -rf -- "$browser_temporary"' EXIT HUP INT TERM
  curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error \
    --retry 3 --retry-all-errors --connect-timeout 15 --max-time 180 \
    "https://registry.npmjs.org/playwright-core/-/playwright-core-$PLAYWRIGHT_VERSION.tgz" \
    --output "$browser_temporary/playwright.tgz"
  printf '%s  %s\n' "$PLAYWRIGHT_SHA256" "$browser_temporary/playwright.tgz" | sha256sum --check --status -
  tar -xzf "$browser_temporary/playwright.tgz" -C "$browser_temporary" --no-same-owner --no-same-permissions
  printf '%s\n' "$PLAYWRIGHT_SHA256" > "$browser_temporary/package/.verified"
  mv "$browser_temporary/package" "$package_root"
fi
[[ "$(<"$package_root/.verified")" == "$PLAYWRIGHT_SHA256" ]]
node "$package_root/cli.js" install chromium --no-shell
browser_binary="$(node -e 'process.stdout.write(require(process.argv[1]).chromium.executablePath())' "$package_root")"
[[ -x "$browser_binary" ]]
ln -s "$browser_binary" "$HOME/.local/bin/.chromium.$$"
mv -f "$HOME/.local/bin/.chromium.$$" "$HOME/.local/bin/chromium"
