# syntax=docker/dockerfile:1
FROM rust:1.96.1-trixie@sha256:1f0dbad1df66647807e6952d1db85d0b2bda7606cb2139d82517e4f009967376 AS source
RUN apt-get update \
    && apt-get install -y --no-install-recommends clang cmake protobuf-compiler libprotobuf-dev libsasl2-dev libkrb5-dev libzstd-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /restate
RUN curl --fail --location --retry 3 https://codeload.github.com/restatedev/restate/tar.gz/fb0ca137d5fc1c86cda5a7d8ef653c5ab201fe6c -o /tmp/source.tar.gz \
    && echo '9d993aa1b094323079abe2a622391ba3b3e068d6a0927bff547fd5a0ddcfa3f1  /tmp/source.tar.gz' | sha256sum --check \
    && tar -xzf /tmp/source.tar.gz --strip-components=1 \
    && rm /tmp/source.tar.gz
COPY metadata-background.patch /tmp/metadata-background.patch
RUN patch --batch --fuzz=0 -p1 < /tmp/metadata-background.patch
ENV VERGEN_GIT_SHA=fb0ca137d5fc1c86cda5a7d8ef653c5ab201fe6c
ENV CARGO_BUILD_JOBS=4

FROM source AS test
COPY tests/ /proof/
RUN cc -Wall -Wextra -Werror -shared -fPIC /proof/slow-fsync.c -ldl -o /proof/slow-fsync.so \
    && cat /proof/metadata-responsiveness.rs >> crates/metadata-server/src/raft/storage/rocksdb.rs
RUN --mount=type=cache,id=restate-cargo-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=restate-cargo-git,target=/usr/local/cargo/git \
    --mount=type=cache,id=restate-test-target,target=/restate/target \
    bash /proof/verify-metadata.sh

FROM source AS builder
RUN --mount=type=cache,id=restate-cargo-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=restate-cargo-git,target=/usr/local/cargo/git \
    --mount=type=cache,id=restate-release-target,target=/restate/target \
    cargo build --locked --release -p restate-server \
    && cp target/release/restate-server /tmp/restate-server

FROM docker.restate.dev/restatedev/restate:1.7.9@sha256:329e32e12059610b681e165161bcd0722d193325b6c893bc46bfec72cd54b595 AS runtime
COPY --from=builder /tmp/restate-server /usr/local/bin/restate-server
LABEL org.opencontainers.image.base.name="docker.restate.dev/restatedev/restate:1.7.9" \
      ai.proompteng.restate.upstream-revision="fb0ca137d5fc1c86cda5a7d8ef653c5ab201fe6c" \
      ai.proompteng.restate.patch="metadata-background-v1"
