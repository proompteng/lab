# syntax=docker/dockerfile:1
ARG UTILITY_IMAGE=busybox:1.37.0@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec
ARG CACHE_IMAGE=scratch
FROM ${CACHE_IMAGE} AS seed
FROM ${UTILITY_IMAGE} AS utility

FROM utility AS restore
RUN --mount=type=cache,id=restate-cargo-registry,target=/cache/registry \
    --mount=type=cache,id=restate-cargo-git,target=/cache/git \
    --mount=type=cache,id=restate-test-target,target=/cache/test \
    --mount=type=cache,id=restate-release-target,target=/cache/release \
    --mount=type=bind,from=seed,source=/cache,target=/seed \
    cp -a /seed/registry/. /cache/registry/ \
    && cp -a /seed/git/. /cache/git/ \
    && cp -a /seed/test/. /cache/test/ \
    && cp -a /seed/release/. /cache/release/

FROM utility AS collect
ARG CACHE_NONCE
RUN --mount=type=cache,id=restate-cargo-registry,target=/mount/registry \
    --mount=type=cache,id=restate-cargo-git,target=/mount/git \
    --mount=type=cache,id=restate-test-target,target=/mount/test \
    --mount=type=cache,id=restate-release-target,target=/mount/release \
    echo "$CACHE_NONCE" > /nonce \
    && mkdir -p /cache \
    && cp -a /mount/registry /mount/git /mount/test /mount/release /cache/ \
    && if test -f /mount/release/release/restate-server; then echo true; else echo false; fi > /cache/populated

FROM scratch AS status
COPY --from=collect /cache/populated /populated

FROM scratch AS archive
COPY --from=collect /cache /cache
