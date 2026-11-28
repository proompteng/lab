#!/usr/bin/env bash
set -euo pipefail
fixture="$(mktemp -d)"
prefix="restate-cache-proof-$$"
utility=busybox:1.37.0@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec
cachefile="$(pwd)/packages/scripts/src/restate/cargo-cache.Dockerfile"
cleanup() {
  docker buildx rm "$prefix-source" "$prefix-destination" >/dev/null 2>&1 || true
  rm -rf "$fixture"
}
trap cleanup EXIT
cat > "$fixture/Dockerfile" <<'DOCKERFILE'
# syntax=docker/dockerfile:1
ARG UTILITY_IMAGE
FROM ${UTILITY_IMAGE} AS source
RUN --mount=type=cache,id=restate-cargo-registry,target=/mount/registry \
    --mount=type=cache,id=restate-cargo-git,target=/mount/git \
    --mount=type=cache,id=restate-test-target,target=/mount/test \
    --mount=type=cache,id=restate-release-target,target=/mount/release \
    for directory in registry git test release; do \
      echo "$directory" > "/mount/$directory/payload"; \
    done \
    && mkdir -p /mount/release/release \
    && printf '#!/bin/sh\necho cached-server\n' > /mount/release/release/restate-server \
    && chmod 751 /mount/release/release/restate-server \
    && ln -s restate-server /mount/release/release/link
FROM ${UTILITY_IMAGE} AS verify
RUN --mount=type=cache,id=restate-cargo-registry,target=/mount/registry \
    --mount=type=cache,id=restate-cargo-git,target=/mount/git \
    --mount=type=cache,id=restate-test-target,target=/mount/test \
    --mount=type=cache,id=restate-release-target,target=/mount/release \
    for directory in registry git test release; do \
      test "$(cat "/mount/$directory/payload")" = "$directory" || exit 1; \
    done \
    && test "$(stat -c %a /mount/release/release/restate-server)" = 751 \
    && test "$(readlink /mount/release/release/link)" = restate-server \
    && test "$(/mount/release/release/link)" = cached-server
DOCKERFILE
docker buildx create --name "$prefix-source" --driver docker-container --bootstrap
docker buildx build --builder "$prefix-source" --build-arg "UTILITY_IMAGE=$utility" --target source "$fixture"
docker buildx build --builder "$prefix-source" --file "$cachefile" --build-arg "UTILITY_IMAGE=$utility" \
  --build-arg CACHE_NONCE=fixture --target archive --provenance=false \
  --output "type=oci,dest=$fixture/archive,tar=false" "$fixture"
digest="$(jq -r '.manifests[0].digest' "$fixture/archive/index.json")"
docker buildx rm "$prefix-source"
docker buildx create --name "$prefix-destination" --driver docker-container --bootstrap
if docker buildx build --builder "$prefix-destination" --build-arg "UTILITY_IMAGE=$utility" \
  --target verify "$fixture" > "$fixture/empty-worker.log" 2>&1; then
  echo 'An empty worker unexpectedly had the fixture cache' >&2
  exit 1
fi
docker buildx build --builder "$prefix-destination" --file "$cachefile" \
  --build-arg "UTILITY_IMAGE=$utility" --build-arg CACHE_IMAGE=restored-cache \
  --build-context "restored-cache=oci-layout://$fixture/archive@$digest" --target restore "$fixture"
docker buildx build --builder "$prefix-destination" --build-arg "UTILITY_IMAGE=$utility" --target verify "$fixture"
echo 'All four cache mounts, executable mode and symlink survived replacement of the worker.'
