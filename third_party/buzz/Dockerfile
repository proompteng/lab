# syntax=docker/dockerfile:1.7

ARG RUST_VERSION=1.95
ARG DEBIAN_VERSION=bookworm
ARG UPSTREAM_IMAGE=ghcr.io/block/buzz@sha256:29fe13981a726fe43642fe03cbd6cc87142579a90bbf9897e3c1b370d1037428

FROM rust:${RUST_VERSION}-${DEBIAN_VERSION} AS builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        git \
        libssl-dev \
        pkg-config \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY . .

RUN cargo test --release --locked -p buzz-relay api::git::store::tests:: --lib \
    && cargo build --release --locked -p buzz-relay --bin buzz-relay \
    && strip target/release/buzz-relay

FROM ${UPSTREAM_IMAGE} AS runtime

ARG LAB_GIT_SHA=unknown
LABEL org.opencontainers.image.source="https://github.com/proompteng/lab" \
      org.opencontainers.image.revision="${LAB_GIT_SHA}" \
      org.opencontainers.image.description="Buzz relay with the bounded Ceph RGW conditional-write compatibility patch" \
      io.proompteng.buzz.upstream-revision="acfbb1bb6af54cb29cb152496ff43b8285dcb8cf" \
      io.proompteng.buzz.upstream-image="ghcr.io/block/buzz@sha256:29fe13981a726fe43642fe03cbd6cc87142579a90bbf9897e3c1b370d1037428"

COPY --from=builder --chown=1000:1000 --chmod=0755 \
    /build/target/release/buzz-relay /usr/local/bin/buzz-relay
