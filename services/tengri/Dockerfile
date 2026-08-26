# syntax=docker/dockerfile:1.7

ARG RUST_VERSION=1.90.0

FROM --platform=$BUILDPLATFORM docker.io/library/rust:${RUST_VERSION}-bookworm AS build

ARG TARGETARCH

RUN apt-get update -o Acquire::Retries=3 && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends protobuf-compiler && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY Cargo.toml Cargo.lock build.rs ./
COPY proto ./proto
COPY src ./src
RUN test "$(dpkg --print-architecture)" = "$TARGETARCH" && \
    cargo test --locked --all-targets && \
    cargo build --locked --release --bin tengri && \
    cp target/release/tengri /out-tengri && \
    test -s /out-tengri

FROM docker.io/library/debian:bookworm-slim

RUN apt-get update -o Acquire::Retries=3 && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates && \
    rm -rf /var/lib/apt/lists/* && \
    groupadd --gid 65532 tengri && \
    useradd --uid 65532 --gid 65532 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin tengri

COPY --from=build /out-tengri /usr/local/bin/tengri

USER 65532:65532
EXPOSE 50051 8080
ENTRYPOINT ["/usr/local/bin/tengri"]
