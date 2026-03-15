#!/bin/sh

set -eu

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname "$0")" && pwd)"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

sh "$SCRIPT_DIR/fetch-upstream.sh" "$WORK_DIR"

sh "$SCRIPT_DIR/apply-upstream-patches.sh" "$WORK_DIR"

cd "$WORK_DIR/backend"
go test ./cmd -run 'Test(GetOrCreateConnection|EstablishClusterConnection|GetOrCreateConnection_HTTPWatchStream|Reconnect|Reconnect_WithToken)'
