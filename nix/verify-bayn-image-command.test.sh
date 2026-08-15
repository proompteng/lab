#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d)"
cleanup() {
  rm -rf "${work}"
}
trap cleanup EXIT

root="${work}/layer-root"
mkdir -p \
  "${root}/bin" \
  "${root}/app/services/bayn/dist" \
  "${root}/nix/store/test-bayn-forward-performance/bin" \
  "${root}/nix/store/test-bayn-runtime/app/services/bayn/dist" \
  "${root}/nix/store/test-node/bin"

cat > "${root}/nix/store/test-bayn-forward-performance/bin/bayn-forward-performance" <<'EOF'
#!/bin/sh
set -eu
root="${BAYN_IMAGE_ROOT:-}"
exec "$root/bin/node" "$root/app/services/bayn/dist/forward-performance-command.js" "$@"
EOF
chmod 0555 "${root}/nix/store/test-bayn-forward-performance/bin/bayn-forward-performance"

cat > "${root}/nix/store/test-bayn-runtime/app/services/bayn/dist/forward-performance-command.js" <<'EOF'
if (process.argv[2] === '--help') console.log('Usage: bayn-forward-performance [--help]')
else process.exitCode = 2
EOF
chmod 0444 "${root}/nix/store/test-bayn-runtime/app/services/bayn/dist/forward-performance-command.js"
: > "${root}/nix/store/test-bayn-runtime/app/services/bayn/dist/restate-execution-server.js"
chmod 0444 "${root}/nix/store/test-bayn-runtime/app/services/bayn/dist/restate-execution-server.js"
printf '#!/bin/sh\nexit 99\n' > "${root}/nix/store/test-node/bin/node"
chmod 0555 "${root}/nix/store/test-node/bin/node"

ln -s /nix/store/test-bayn-forward-performance/bin/bayn-forward-performance "${root}/bin/bayn-forward-performance"
ln -s /nix/store/test-node/bin/node "${root}/bin/node"
ln -s /nix/store/test-bayn-runtime/app/services/bayn/dist/forward-performance-command.js \
  "${root}/app/services/bayn/dist/forward-performance-command.js"
ln -s /nix/store/test-bayn-runtime/app/services/bayn/dist/restate-execution-server.js \
  "${root}/app/services/bayn/dist/restate-execution-server.js"

tar -C "${root}" -cf "${work}/layer.tar" .
cat > "${work}/manifest.json" <<'EOF'
[{"Config":"config.json","RepoTags":["bayn:test"],"Layers":["layer.tar"]}]
EOF
printf '{}\n' > "${work}/config.json"
tar -C "${work}" -cf "${work}/bayn.tar" manifest.json config.json layer.tar

output="$(
  BAYN_VERIFY_ALLOW_NON_NIX_ARCHIVE=true \
    bash "${repo_root}/nix/verify-bayn-image-command.sh" "${work}/bayn.tar"
)"
test "${output}" = 'Usage: bayn-forward-performance [--help]'
