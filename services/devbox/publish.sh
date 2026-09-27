#!/usr/bin/env bash
set -euo pipefail
: "${GITHUB_SHA:?}" "${GITHUB_RUN_ID:?}"
[[ "$GITHUB_SHA" =~ ^[0-9a-f]{40}$ && "$GITHUB_RUN_ID" =~ ^[0-9]+$ ]] || exit 1
[[ "${GITHUB_REF:-}" == refs/heads/main ]]
tag="kargo-sha-$GITHUB_SHA-run-$GITHUB_RUN_ID"
artifacts=.artifacts/codex-devbox

case "${1:-}" in
  prepare)
    : "${SIGNING_IDENTITY:?}"
    mkdir -p "$artifacts"
    for name in codex-devbox codex-devbox-rootfs; do
      image="registry.ide-newton.ts.net/lab/$name"
      candidate="$image:release-$GITHUB_SHA-run-$GITHUB_RUN_ID"
      docker buildx imagetools create \
        --annotation "index:org.opencontainers.image.source=https://github.com/proompteng/lab" \
        --annotation "index:org.opencontainers.image.revision=$GITHUB_SHA" \
        --annotation "index:ai.proompteng.github-actions-run-id=$GITHUB_RUN_ID" \
        --annotation 'index:ai.proompteng.github-actions-build-conclusion=success' \
        --tag "$candidate" \
        "$image:build-$GITHUB_SHA-run-$GITHUB_RUN_ID-amd64" \
        "$image:build-$GITHUB_SHA-run-$GITHUB_RUN_ID-arm64"
      crane manifest "$candidate" > "$artifacts/$name-index.json"
      jq -e --arg sha "$GITHUB_SHA" --arg run "$GITHUB_RUN_ID" '
        .annotations["org.opencontainers.image.revision"] == $sha and
        .annotations["ai.proompteng.github-actions-run-id"] == $run and
        .annotations["ai.proompteng.github-actions-build-conclusion"] == "success" and
        any(.manifests[]; .platform.architecture == "amd64" and .platform.os == "linux") and
        any(.manifests[]; .platform.architecture == "arm64" and .platform.os == "linux")
      ' "$artifacts/$name-index.json" >/dev/null
      digest="$(crane digest "$candidate")"
      [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]
      cosign sign --yes "$image@$digest"
      cosign verify --certificate-identity "$SIGNING_IDENTITY" \
        --certificate-oidc-issuer https://token.actions.githubusercontent.com "$image@$digest" >/dev/null
      printf '%s\n' "$digest" > "$artifacts/$name.digest"
    done
    ;;
  expose)
    for name in codex-devbox codex-devbox-rootfs; do
      [[ "$(cat "$artifacts/$name.digest")" =~ ^sha256:[0-9a-f]{64}$ ]]
      jq -e --arg sha "$GITHUB_SHA" --arg run "$GITHUB_RUN_ID" \
        '.annotations["org.opencontainers.image.revision"] == $sha and .annotations["ai.proompteng.github-actions-run-id"] == $run' \
        "$artifacts/$name-index.json" >/dev/null
    done
    for name in codex-devbox codex-devbox-rootfs; do
      image="registry.ide-newton.ts.net/lab/$name"
      digest="$(cat "$artifacts/$name.digest")"
      error="$(mktemp)"
      if existing="$(crane digest "$image:$tag" 2>"$error")"; then
        [[ "$existing" == "$digest" ]]
      elif grep -Eiq 'MANIFEST_UNKNOWN|manifest unknown|manifest.*not found|404.*not found' "$error"; then
        crane tag "$image@$digest" "$tag"
      else
        cat "$error" >&2
        rm -f "$error"
        exit 1
      fi
      rm -f "$error"
      [[ "$(crane digest "$image:$tag")" == "$digest" ]]
    done
    ;;
  *) echo 'Usage: publish.sh prepare|expose' >&2; exit 2 ;;
esac
