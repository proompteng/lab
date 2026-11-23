# syntax=docker/dockerfile:1
FROM rust:1.98.1-trixie@sha256:a8a5f0a1e5fe7dfe1d352591e4a1c7dd2c08fd70475cae872cf3458ba0df0546 AS source
RUN apt-get update \
    && apt-get install -y --no-install-recommends clang cmake protobuf-compiler libprotobuf-dev libsasl2-dev libkrb5-dev libzstd-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /restate
RUN curl --fail --location --retry 3 https://codeload.github.com/restatedev/restate/tar.gz/bc55288da0d6fd8874bb5a3bc72f12f3698475ab -o /tmp/source.tar.gz \
    && echo 'f6dca0b8a2f2a05793905ed75faca010c0203c9a3614731652fe6ad389ff5978  /tmp/source.tar.gz' | sha256sum --check \
    && tar -xzf /tmp/source.tar.gz --strip-components=1 \
    && rm /tmp/source.tar.gz
COPY metadata-background.patch /tmp/metadata-background.patch
COPY metadata-election-connect.patch /tmp/metadata-election-connect.patch
RUN patch --batch --fuzz=0 -p1 < /tmp/metadata-background.patch \
    && patch --batch --fuzz=0 -p1 < /tmp/metadata-election-connect.patch
ENV VERGEN_GIT_SHA=bc55288da0d6fd8874bb5a3bc72f12f3698475ab
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

FROM docker.restate.dev/restatedev/restate:1.8.1-hotfix.3@sha256:a08ba07bd867dff3b2b399ccb0575ce8c8c0ca32e47e17c1f023533c8a9a7b69 AS runtime
COPY --from=builder /tmp/restate-server /usr/local/bin/restate-server
COPY --from=builder /tmp/restate-doctor /usr/local/bin/restate-doctor
RUN restate-server --version | grep -Fx 'restate-server 1.8.1-hotfix.3' \
    && restate-doctor --version | grep -E '^restate-doctor 1\.8\.1-hotfix\.3( |$)'
LABEL org.opencontainers.image.base.name="docker.restate.dev/restatedev/restate:1.8.1-hotfix.3" \
      ai.proompteng.restate.upstream-revision="bc55288da0d6fd8874bb5a3bc72f12f3698475ab" \
      ai.proompteng.restate.patch="metadata-background-v1,election-connect-v1"
