#!/bin/sh

set -eu

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname "$0")" && pwd)"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

sh "$SCRIPT_DIR/fetch-upstream.sh" "$WORK_DIR"

sh "$SCRIPT_DIR/apply-upstream-patches.sh" "$WORK_DIR"

test ! -e "$WORK_DIR/frontend/src/lib/k8s/api/authError.ts"
! grep -R -n -E "handleClusterAuthError|navigate\\(createRouteURL\\('login'" "$WORK_DIR/frontend/src/lib/k8s/api"

cd "$WORK_DIR/backend"
go test ./cmd -run 'Test(GetOrCreateConnection|EstablishClusterConnection|GetOrCreateConnection_HTTPWatchStream|Reconnect|Reconnect_WithToken|OIDCTokenRefreshMiddleware)'
go test ./pkg/auth -run 'Test(GetCookiePath|GetWebSocketCookiePath|SetAndGetAuthCookie|GetAuthCookieChunked|ClearAuthCookie|SetTokenCookie_UsesTokenExpiryForMaxAge|GetNewToken_PreHTTPFailures)'
