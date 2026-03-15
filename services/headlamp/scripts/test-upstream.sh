#!/bin/sh

set -eu

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname "$0")" && pwd)"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

sh "$SCRIPT_DIR/fetch-upstream.sh" "$WORK_DIR"

sh "$SCRIPT_DIR/apply-upstream-patches.sh" "$WORK_DIR"

cd "$WORK_DIR/backend"
go test ./cmd -run 'Test(GetOrCreateConnection|EstablishClusterConnection|GetOrCreateConnection_HTTPWatchStream|Reconnect|Reconnect_WithToken|OIDCTokenRefreshMiddleware)'
go test ./pkg/auth -run 'Test(GetCookiePath|GetWebSocketCookiePath|SetAndGetAuthCookie|GetAuthCookieChunked|ClearAuthCookie|SetTokenCookie_UsesTokenExpiryForMaxAge|GetNewToken_PreHTTPFailures)'

if command -v npm >/dev/null 2>&1; then
  cd "$WORK_DIR/frontend"
  npm ci
  npm test -- --run src/lib/k8s/api/authError.test.ts
fi
