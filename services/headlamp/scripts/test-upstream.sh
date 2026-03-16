#!/bin/sh

set -eu

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname "$0")" && pwd)"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

sh "$SCRIPT_DIR/fetch-upstream.sh" "$WORK_DIR"

sh "$SCRIPT_DIR/apply-upstream-patches.sh" "$WORK_DIR"

test ! -e "$WORK_DIR/frontend/src/lib/k8s/api/authError.ts"
if grep -R -n -E "handleClusterAuthError|navigate\\(createRouteURL\\('login'" "$WORK_DIR/frontend/src/lib/k8s/api"; then
  echo "unexpected frontend auth redirect hook present in patched upstream tree" >&2
  exit 1
fi

cd "$WORK_DIR/backend"
go test ./cmd -run 'Test(GetOrCreateConnection|EstablishClusterConnection|GetOrCreateConnection_HTTPWatchStream|Reconnect|Reconnect_WithToken|OIDCTokenRefreshMiddleware)'
go test ./pkg/auth -run 'Test(GetCookiePath|GetWebSocketCookiePath|GetBaseCookiePath|SetAndGetAuthCookie|GetAuthCookieChunked|ClearAuthCookie|SetTokenCookieClearsLegacyRootPathChunks|SetTokenCookie_UsesTokenExpiryForMaxAge|GetNewToken_PreHTTPFailures)'
