# syntax=mirror.gcr.io/docker/dockerfile:1.7

ARG DEBIAN_BASE_IMAGE=mirror.gcr.io/debian
ARG RUST_BASE_IMAGE=mirror.gcr.io/rust
ARG RUST_VERSION=1.90.0

FROM --platform=$BUILDPLATFORM ${RUST_BASE_IMAGE}:${RUST_VERSION}-bookworm AS build

ARG TARGETARCH

RUN apt-get update -o Acquire::Retries=3 && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends protobuf-compiler curl ca-certificates && \
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

RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) fc_arch=x86_64; fc_sha=382a02a869e4d6d5cb14c40577f9545e8458021ea8b0b2d3fc10ec14d9c242e6 ;; \
      arm64) fc_arch=aarch64; fc_sha=8d0e69f6d6f9a1724551f607f18504052c16c1828ee3d4d7b6e6c73380871e0e ;; \
      *) exit 1 ;; \
    esac; \
    curl -fsSL --retry 3 -o /tmp/firecracker.tgz "https://github.com/firecracker-microvm/firecracker/releases/download/v1.16.1/firecracker-v1.16.1-${fc_arch}.tgz"; \
    printf '%s  /tmp/firecracker.tgz\n' "$fc_sha" | sha256sum --check; \
    tar -xzf /tmp/firecracker.tgz -C /tmp; \
    cp "/tmp/release-v1.16.1-${fc_arch}/firecracker-v1.16.1-${fc_arch}" /out-firecracker; \
    /out-firecracker --version

FROM ${DEBIAN_BASE_IMAGE}:bookworm-slim

RUN apt-get update -o Acquire::Retries=3 && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates e2fsprogs iproute2 nftables && \
    rm -rf /var/lib/apt/lists/* && \
    groupadd --gid 65532 tengri && \
    useradd --uid 65532 --gid 65532 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin tengri

COPY --from=build /out-tengri /usr/local/bin/tengri
COPY --from=build /out-firecracker /usr/local/bin/firecracker
COPY --chmod=0555 network.sh /usr/local/bin/tengri-network

USER 65532:65532
EXPOSE 50051 8080
ENTRYPOINT ["/usr/local/bin/tengri"]
