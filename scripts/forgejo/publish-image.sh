#!/usr/bin/env bash
set -euo pipefail

mode=${1:?usage: publish-image.sh prepare|publish}
[[ "$mode" == prepare || "$mode" == publish ]] || exit 1
[[ "${GITHUB_REF:?}" == refs/heads/main ]] || exit 1
[[ "${GITHUB_SHA:?}" =~ ^[0-9a-f]{40}$ ]] || exit 1
[[ "$(git rev-parse HEAD)" == "$GITHUB_SHA" ]] || exit 1
readonly source_sha=$GITHUB_SHA
source_timestamp=$(git show -s --format=%cI HEAD)
readonly source_timestamp
readonly source_url=https://github.com/proompteng/lab
readonly image_repo=registry.registry.svc.cluster.local/lab/forgejo
readonly public_repo=registry.ide-newton.ts.net/lab/forgejo
readonly release=argocd/applications/forgejo/upstream-image.json
source_repo=$(jq -er .repository "$release")
source_digest=$(jq -er .indexDigest "$release")
version=$(jq -er .version "$release")
readonly source_repo source_digest version
[[ "$source_repo" == code.forgejo.org/forgejo/forgejo ]] || exit 1
[[ "$source_digest" =~ ^sha256:[0-9a-f]{64}$ ]] || exit 1
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || exit 1
readonly source_ref=$source_repo@$source_digest
readonly preparation_ref=$image_repo:prepared-$source_sha
readonly publication_ref=$image_repo:kargo-sha-$source_sha
readonly evidence=forgejo-image-evidence
mkdir -p "$evidence"

# A registry failure is not evidence that a tag is absent.
assert_absent_or_matching() {
  local reference=$1 expected=$2 actual
  if actual=$(crane digest --insecure "$reference" 2>"$evidence/probe.error"); then
    [[ "$actual" == "$expected" ]] || return 1
  elif ! grep -Eiq 'MANIFEST_UNKNOWN|NAME_UNKNOWN|404 Not Found|manifest unknown|name unknown' "$evidence/probe.error"; then
    cat "$evidence/probe.error" >&2
    return 1
  fi
}

if [[ "$mode" == prepare ]]; then
  crane manifest "$source_ref" > "$evidence/upstream-index.json"
  [[ "$(crane digest "$source_ref")" == "$source_digest" ]] || exit 1
  for architecture in amd64 arm64; do
    platform_digest=$(jq -er --arg arch "$architecture" '.platforms[$arch]' "$release")
    [[ "$platform_digest" =~ ^sha256:[0-9a-f]{64}$ ]] || exit 1
    jq -e --arg arch "$architecture" --arg digest "$platform_digest" \
      '[.manifests[] | select(.platform.os == "linux" and .platform.architecture == $arch and .digest == $digest)] | length == 1' \
      "$evidence/upstream-index.json" >/dev/null
    crane config "$source_repo@$platform_digest" > "$evidence/upstream-$architecture-config.json"
    jq -e --arg version "$version" --arg arch "$architecture" \
      '.architecture == $arch and .os == "linux" and .config.Labels["org.opencontainers.image.version"] == $version' \
      "$evidence/upstream-$architecture-config.json" >/dev/null
  done

  mirror_ref=$image_repo:upstream-${source_digest#sha256:}
  assert_absent_or_matching "$mirror_ref" "$source_digest"
  policy=$(mktemp)
  trap 'rm -f "$policy"' EXIT
  jq -n --arg repo "$source_repo" '{default:[{type:"reject"}],transports:{docker:{($repo):[{type:"insecureAcceptAnything"}]}}}' > "$policy"
  # Preserve the entire reviewed upstream index, including its attestations.
  # Serialize blob transfers because this registry admits one blob writer.
  skopeo --policy "$policy" copy --all --preserve-digests --image-parallel-copies 1 \
    --src-tls-verify=true --dest-tls-verify=false "docker://$source_ref" "docker://$mirror_ref"
  [[ "$(crane digest --insecure "$mirror_ref")" == "$source_digest" ]] || exit 1
  rm -f "$policy"
  trap - EXIT

  for architecture in amd64 arm64; do
    platform_digest=$(jq -er --arg arch "$architecture" '.platforms[$arch]' "$release")
    candidate=$image_repo:prepared-$source_sha-$architecture
    crane mutate --insecure "$image_repo@$platform_digest" \
      --label "org.opencontainers.image.created=$source_timestamp" \
      --label "org.opencontainers.image.revision=$source_sha" \
      --label "org.opencontainers.image.source=$source_url" \
      --label "org.opencontainers.image.base.name=$source_repo" \
      --label "org.opencontainers.image.base.digest=$platform_digest" \
      --tag "$candidate" >/dev/null
    crane config --insecure "$candidate" > "$evidence/release-$architecture-config.json"
    # Only release metadata may change; rootfs, user, entrypoint and all other settings stay exact.
    python3 scripts/forgejo/verify-image-config.py \
      "$evidence/upstream-$architecture-config.json" "$evidence/release-$architecture-config.json" \
      "$source_sha" "$source_timestamp" "$platform_digest"
    crane manifest --insecure "$candidate" > "$evidence/release-$architecture-manifest.json"
    crane manifest --insecure "$image_repo@$platform_digest" > "$evidence/upstream-$architecture-manifest.json"
    jq -e --slurpfile upstream "$evidence/upstream-$architecture-manifest.json" \
      '.layers == $upstream[0].layers' "$evidence/release-$architecture-manifest.json" >/dev/null
  done
  docker buildx imagetools create \
    --annotation "index:org.opencontainers.image.source=$source_url" \
    --annotation "index:org.opencontainers.image.revision=$source_sha" \
    --annotation "index:org.opencontainers.image.created=$source_timestamp" \
    --annotation "index:org.opencontainers.image.version=$version" \
    --annotation "index:org.opencontainers.image.base.name=$source_repo" \
    --annotation "index:org.opencontainers.image.base.digest=$source_digest" \
    --tag "$preparation_ref" "$image_repo:prepared-$source_sha-amd64" "$image_repo:prepared-$source_sha-arm64"
  crane manifest --insecure "$preparation_ref" > "$evidence/release-index.json"
  jq -e --arg sha "$source_sha" --arg source "$source_url" --arg upstream "$source_digest" '
    .annotations["org.opencontainers.image.revision"] == $sha and
    .annotations["org.opencontainers.image.source"] == $source and
    .annotations["org.opencontainers.image.base.digest"] == $upstream and
    (.manifests | length) == 2 and
    any(.manifests[]; .platform.os == "linux" and .platform.architecture == "amd64") and
    any(.manifests[]; .platform.os == "linux" and .platform.architecture == "arm64")
  ' "$evidence/release-index.json" >/dev/null
  digest=$(crane digest --insecure "$preparation_ref")
  [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || exit 1
  [[ "$(crane digest --insecure "$image_repo@$digest")" == "$digest" ]] || exit 1
  assert_absent_or_matching "$publication_ref" "$digest"
  jq -n --arg revision "$source_sha" --arg digest "$digest" --arg upstream "$source_ref" \
    --arg image "$public_repo@$digest" '{revision:$revision,digest:$digest,upstream:$upstream,image:$image}' > "$evidence/receipt.json"
  exit 0
fi

# The workflow invokes this only after terminal validation and artifact upload.
digest=$(jq -er --arg sha "$source_sha" 'select(.revision == $sha) | .digest' "$evidence/receipt.json")
[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || exit 1
[[ "$(crane digest --insecure "$preparation_ref")" == "$digest" ]] || exit 1
assert_absent_or_matching "$publication_ref" "$digest"
crane tag --insecure "$image_repo@$digest" "kargo-sha-$source_sha"
[[ "$(crane digest --insecure "$publication_ref")" == "$digest" ]] || exit 1
printf 'Published immutable Forgejo image %s@%s\n' "$public_repo" "$digest"
