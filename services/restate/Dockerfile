# syntax=docker/dockerfile:1
FROM rust:1.98.1-trixie@sha256:a8a5f0a1e5fe7dfe1d352591e4a1c7dd2c08fd70475cae872cf3458ba0df0546 AS source
RUN apt-get update \
    && apt-get install -y --no-install-recommends clang cmake protobuf-compiler libprotobuf-dev libsasl2-dev libkrb5-dev libzstd-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /restate
RUN curl --fail --location --retry 3 https://codeload.github.com/restatedev/restate/tar.gz/20efb1b83a39b8227451e531c366e067588ae9ee -o /tmp/source.tar.gz \
    && echo 'b76c099c31af2162a4f91b3c5d91186b00eb50f8e56ee5721e8998df76ebc730  /tmp/source.tar.gz' | sha256sum --check \
    && tar -xzf /tmp/source.tar.gz --strip-components=1 \
    && rm /tmp/source.tar.gz
COPY metadata-background.patch /tmp/metadata-background.patch
COPY metadata-election-connect.patch /tmp/metadata-election-connect.patch
RUN patch --batch --fuzz=0 -p1 < /tmp/metadata-background.patch \
    && patch --batch --fuzz=0 -p1 < /tmp/metadata-election-connect.patch
ENV VERGEN_GIT_SHA=20efb1b83a39b8227451e531c366e067588ae9ee
ENV CARGO_BUILD_JOBS=4

FROM source AS test
COPY tests/ /proof/
RUN cc -Wall -Wextra -Werror -shared -fPIC /proof/slow-fsync.c -ldl -o /proof/slow-fsync.so \
    && cat /proof/metadata-responsiveness.rs >> crates/metadata-server/src/raft/storage/rocksdb.rs
RUN --mount=type=cache,id=restate-cargo-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=restate-cargo-git,target=/usr/local/cargo/git \
    --mount=type=cache,id=restate-test-target,target=/restate/target \
    bash /proof/verify-metadata.sh \
    && bash /proof/verify-election-connect.sh

FROM scratch AS evidence
COPY --from=test /proof/*.log /

FROM source AS builder
RUN --mount=type=cache,id=restate-cargo-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=restate-cargo-git,target=/usr/local/cargo/git \
    --mount=type=cache,id=restate-release-target,target=/restate/target \
    cargo build --locked --release -p restate-server \
    && cp target/release/restate-server /tmp/restate-server \
    && cargo build --locked --release -p restate-doctor \
    && cp target/release/restate-doctor /tmp/restate-doctor

FROM docker.restate.dev/restatedev/restate:1.8.1@sha256:cd5ee1abb1b3f91e813e327a024779280938aaff991ccdc5b241a3a3a4bddce1 AS runtime
COPY --from=builder /tmp/restate-server /usr/local/bin/restate-server
COPY --from=builder /tmp/restate-doctor /usr/local/bin/restate-doctor
RUN restate-server --version | grep -Fx 'restate-server 1.8.1' \
    && restate-doctor --version | grep -E '^restate-doctor 1\.8\.1( |$)'
LABEL org.opencontainers.image.base.name="docker.restate.dev/restatedev/restate:1.8.1" \
      ai.proompteng.restate.upstream-revision="20efb1b83a39b8227451e531c366e067588ae9ee" \
      ai.proompteng.restate.patch="metadata-background-v1,election-connect-v1"
