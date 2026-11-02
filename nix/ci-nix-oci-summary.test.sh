#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
fixture="$(mktemp -d)"
trap 'rm -rf "${fixture}"' EXIT
mkdir "${fixture}/logs"

check_counts() {
  : > "${fixture}/step-summary.md"
  NIX_OCI_LOG_DIR="${fixture}/logs" GITHUB_STEP_SUMMARY="${fixture}/step-summary.md" \
    "${BASH}" "${repo_root}/nix/ci-nix-oci-summary.sh" > "${fixture}/stdout.md"
  if ! grep -Fqx "| Attic download failures | $1 |" "${fixture}/stdout.md" ||
    ! grep -Fqx "| cache.nixos.org download failures | $2 |" "${fixture}/stdout.md"; then
    printf 'Expected Attic failures=%s and public-cache failures=%s\n' "$1" "$2" >&2
    cat "${fixture}/stdout.md" >&2
    exit 1
  fi
  cmp "${fixture}/stdout.md" "${fixture}/step-summary.md"
}

cat > "${fixture}/logs/build.log" <<'EOF'
warning: error: unable to download 'https://cache.nixos.org/nar/fixture.nar.xz': HTTP error 200 (curl error: Failure when receiving data from the peer); retrying from offset 456312 in 319 ms
warning: error: unable to download 'https://cache.nixos.org/nar/fixture.nar.zst': Failed sending data to the peer (55) OpenSSL SSL_read: SSL_ERROR_SYSCALL, errno 0; retrying in 256 ms
warning: error: unable to download 'http://attic.attic.svc.cluster.local/lab/nar/fixture.nar': HTTP error 200 (curl error: Transferred a partial file); retrying in 300 ms
warning: error: unable to download 'https://attic.ide-newton.ts.net/lab/nar/fixture.nar': HTTP error 503; retrying in 300 ms
EOF
check_counts 0 0

cat > "${fixture}/logs/download.log" <<'EOF'
error: unable to download 'http://attic.attic.svc.cluster.local/lab/nar/fixture.nar': HTTP error 200 (curl error: Transferred a partial file)
       error: unable to download 'https://attic.ide-newton.ts.net/lab/nar/fixture.nar': HTTP error 503
error: unable to download 'https://cache.nixos.org/nar/fixture.nar.xz': HTTP error 503
       error: unable to download 'https://cache.nixos.org/nar/fixture.nar.zst': Failed sending data to the peer
EOF
check_counts 2 2

rm "${fixture}/logs/build.log" "${fixture}/logs/download.log"
check_counts 0 0
printf 'Nix cache summaries exclude retry warnings and retain terminal failures.\n'
