# syntax=docker/dockerfile:1
FROM rust:1.98.1-trixie@sha256:a8a5f0a1e5fe7dfe1d352591e4a1c7dd2c08fd70475cae872cf3458ba0df0546 AS source
RUN apt-get update \
    && apt-get install -y --no-install-recommends clang cmake protobuf-compiler libprotobuf-dev libsasl2-dev libkrb5-dev libzstd-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /restate
RUN curl --fail --location --retry 3 https://codeload.github.com/restatedev/restate/tar.gz/34918c2216435626ad5525ae8c40b8095d3c26b0 -o /tmp/source.tar.gz \
    && echo '6c1a9664dde027f2a403287979ab6f5f833fee9febe520bc639083e599877752  /tmp/source.tar.gz' | sha256sum --check \
    && tar -xzf /tmp/source.tar.gz --strip-components=1 \
    && rm /tmp/source.tar.gz
COPY metadata-background.patch /tmp/metadata-background.patch
COPY metadata-election-connect.patch /tmp/metadata-election-connect.patch
RUN patch --batch --fuzz=0 -p1 < /tmp/metadata-background.patch \
    && patch --batch --fuzz=0 -p1 < /tmp/metadata-election-connect.patch
ENV VERGEN_GIT_SHA=34918c2216435626ad5525ae8c40b8095d3c26b0
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

FROM docker.restate.dev/restatedev/restate:1.8.1-hotfix.2@sha256:e3a11e7c694cfe0c134eca1652992c068bef0bcba3caeec9d2a3b3bc50daa62e AS runtime
COPY --from=builder /tmp/restate-server /usr/local/bin/restate-server
COPY --from=builder /tmp/restate-doctor /usr/local/bin/restate-doctor
RUN restate-server --version | grep -Fx 'restate-server 1.8.1-hotfix.2' \
    && restate-doctor --version | grep -E '^restate-doctor 1\.8\.1-hotfix\.2( |$)'
LABEL org.opencontainers.image.base.name="docker.restate.dev/restatedev/restate:1.8.1-hotfix.2" \
      ai.proompteng.restate.upstream-revision="34918c2216435626ad5525ae8c40b8095d3c26b0" \
      ai.proompteng.restate.patch="metadata-background-v1,election-connect-v1"
