#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d)"
image_ref="bayn-verifier-test:run-$$"
temporary_image_ids=()
cleanup() {
  for image_id in "${temporary_image_ids[@]}"; do
    docker image rm --force "${image_id}" >/dev/null 2>&1 || true
  done
  rm -rf "${work}"
}
trap cleanup EXIT

if ! command -v docker >/dev/null || ! docker info >/dev/null 2>&1; then
  echo 'Bayn image command regression requires an isolated Docker daemon.' >&2
  exit 1
fi

case "$(docker info --format '{{.Architecture}}')" in
  amd64 | x86_64)
    go_arch='amd64'
    ;;
  arm64 | aarch64)
    go_arch='arm64'
    ;;
  *)
    echo 'Bayn image command regression does not support this Docker architecture.' >&2
    exit 1
    ;;
esac

cat > "${work}/runtime.go" <<'EOF'
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func main() {
	switch filepath.Base(os.Args[0]) {
	case "bayn-forward-performance":
		if exists("/wrapper-fail") {
			os.Exit(42)
		}
		args := append([]string{"/bin/node", "/app/services/bayn/dist/forward-performance-command.js"}, os.Args[1:]...)
		if err := syscall.Exec(args[0], args, os.Environ()); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(127)
		}
	case "node":
		if exists("/node-fail") {
			os.Exit(99)
		}
		if len(os.Args) == 3 && os.Args[1] == "/app/services/bayn/dist/forward-performance-command.js" && os.Args[2] == "--help" {
			fmt.Println("Usage: bayn-forward-performance [--help]")
			return
		}
		os.Exit(2)
	default:
		os.Exit(2)
	}
}
EOF
CGO_ENABLED=0 GOOS=linux GOARCH="${go_arch}" go build -trimpath -ldflags='-s -w' -o "${work}/runtime" "${work}/runtime.go"

root="${work}/layer-root"
mkdir -p \
  "${root}/bin" \
  "${root}/app/services/bayn/dist" \
  "${root}/nix/store/test-bayn-forward-performance/bin" \
  "${root}/nix/store/test-bayn-runtime/app/services/bayn/dist" \
  "${root}/nix/store/test-node/bin"

install -m 0555 "${work}/runtime" \
  "${root}/nix/store/test-bayn-forward-performance/bin/bayn-forward-performance"
install -m 0555 "${work}/runtime" "${root}/nix/store/test-node/bin/node"
: > "${root}/nix/store/test-bayn-runtime/app/services/bayn/dist/forward-performance-command.js"
: > "${root}/nix/store/test-bayn-runtime/app/services/bayn/dist/restate-execution-server.js"
chmod 0444 \
  "${root}/nix/store/test-bayn-runtime/app/services/bayn/dist/forward-performance-command.js" \
  "${root}/nix/store/test-bayn-runtime/app/services/bayn/dist/restate-execution-server.js"

ln -s /nix/store/test-bayn-forward-performance/bin/bayn-forward-performance "${root}/bin/bayn-forward-performance"
ln -s /nix/store/test-node/bin/node "${root}/bin/node"
ln -s /nix/store/test-bayn-runtime/app/services/bayn/dist/forward-performance-command.js \
  "${root}/app/services/bayn/dist/forward-performance-command.js"
ln -s /nix/store/test-bayn-runtime/app/services/bayn/dist/restate-execution-server.js \
  "${root}/app/services/bayn/dist/restate-execution-server.js"

pack_image() {
  tar -C "${root}" -cf "${work}/rootfs.tar" .
  local image_id
  image_id="$(docker import --change 'ENTRYPOINT ["/bin/bayn-forward-performance"]' "${work}/rootfs.tar" "${image_ref}")"
  temporary_image_ids+=("${image_id}")
  docker save --output "${work}/bayn.tar" "${image_ref}"
}

verify_image() {
  BAYN_VERIFY_ALLOW_NON_NIX_ARCHIVE=true \
    bash "${repo_root}/nix/verify-bayn-image-command.sh" "${work}/bayn.tar"
}

pack_image
test "$(verify_image)" = 'Usage: bayn-forward-performance [--help]'

chmod u+w "${root}/nix/store/test-bayn-forward-performance/bin/bayn-forward-performance"
cat > "${root}/nix/store/test-bayn-forward-performance/bin/bayn-forward-performance" <<'EOF'
#!/bin/sh
printf '%s\n' 'Usage: bayn-forward-performance [--help]'
EOF
chmod 0555 "${root}/nix/store/test-bayn-forward-performance/bin/bayn-forward-performance"
pack_image
if verify_image >/dev/null 2>&1; then
  echo 'Bayn image verification used the host interpreter for an incomplete image.' >&2
  exit 1
fi

install -m 0555 "${work}/runtime" \
  "${root}/nix/store/test-bayn-forward-performance/bin/bayn-forward-performance"
touch "${root}/wrapper-fail"
pack_image
if verify_image >/dev/null 2>&1; then
  echo 'Bayn image verification accepted a broken forward-performance wrapper.' >&2
  exit 1
fi
rm "${root}/wrapper-fail"

touch "${root}/node-fail"
pack_image
if verify_image >/dev/null 2>&1; then
  echo 'Bayn image verification accepted a broken in-image Node runtime.' >&2
  exit 1
fi
