# syntax=mirror.gcr.io/docker/dockerfile:1.7

ARG DEBIAN_BASE_IMAGE=mirror.gcr.io/debian
ARG RUST_BASE_IMAGE=mirror.gcr.io/rust
ARG RUST_VERSION=1.90.0
ARG FIRECRACKER_RUST_VERSION=1.95.0

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

FROM --platform=$BUILDPLATFORM ${RUST_BASE_IMAGE}:${FIRECRACKER_RUST_VERSION}-bookworm AS firecracker-build

ARG TARGETARCH
ENV RUSTUP_TOOLCHAIN=1.95.0 CARGO_TARGET_DIR=/firecracker/target CARGO_BUILD_JOBS=2
WORKDIR /firecracker
RUN apt-get update -o Acquire::Retries=3 && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends clang cmake gperf libclang-dev musl-tools patch && \
    rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    test "$(dpkg --print-architecture)" = "$TARGETARCH"; \
    case "$TARGETARCH" in \
      amd64) fc_arch=x86_64 ;; \
      arm64) fc_arch=aarch64 ;; \
      *) exit 1 ;; \
    esac; \
    ln -s "../${fc_arch}-linux-gnu/asm" "/usr/include/${fc_arch}-linux-musl/asm"; \
    ln -s ../linux "/usr/include/${fc_arch}-linux-musl/linux"; \
    ln -s ../asm-generic "/usr/include/${fc_arch}-linux-musl/asm-generic"
RUN curl -fsSL --retry 3 -o /tmp/libseccomp.tgz \
      https://github.com/seccomp/libseccomp/releases/download/v2.6.0/libseccomp-2.6.0.tar.gz && \
    printf '%s  /tmp/libseccomp.tgz\n' 83b6085232d1588c379dc9b9cae47bb37407cf262e6e74993c61ba72d2a784dc | sha256sum --check && \
    mkdir /libseccomp && tar -xzf /tmp/libseccomp.tgz --strip-components=1 -C /libseccomp && \
    cd /libseccomp && CC='musl-gcc -static' ./configure --disable-shared --enable-static && \
    make -j2 && make install && rm /tmp/libseccomp.tgz
RUN curl -fsSL --retry 3 -o /tmp/firecracker-source.tgz \
      https://github.com/firecracker-microvm/firecracker/archive/refs/tags/v1.16.1.tar.gz && \
    printf '%s  /tmp/firecracker-source.tgz\n' 4056d1440f9db53e49aa9fe848954cc8d80cbf202a2454a1a1d93830ff0fb304 | sha256sum --check && \
    tar -xzf /tmp/firecracker-source.tgz --strip-components=1 -C /firecracker && \
    rm /tmp/firecracker-source.tgz
COPY firecracker-memory-direct-io.patch /tmp/firecracker-memory-direct-io.patch
RUN --mount=type=cache,target=/usr/local/cargo/registry,id=tengri-firecracker-registry \
    --mount=type=cache,target=/firecracker/target,id=tengri-firecracker-target-${TARGETARCH} \
    set -eu; \
    test "$(dpkg --print-architecture)" = "$TARGETARCH"; \
    patch --fuzz=0 -p1 < /tmp/firecracker-memory-direct-io.patch; \
    case "$TARGETARCH" in \
      amd64) fc_target=x86_64-unknown-linux-musl ;; \
      arm64) fc_target=aarch64-unknown-linux-musl ;; \
      *) exit 1 ;; \
    esac; \
    test -s "resources/seccomp/${fc_target}.json"; \
    rustup target add "$fc_target"; \
    cargo build --locked --release --target "$fc_target" --bin firecracker; \
    cp "target/${fc_target}/release/firecracker" /out-firecracker; \
    file /out-firecracker | grep -E 'statically linked|static-pie linked'; \
    /out-firecracker --version

FROM ${DEBIAN_BASE_IMAGE}:bookworm-slim

RUN apt-get update -o Acquire::Retries=3 && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates e2fsprogs iproute2 nftables && \
    rm -rf /var/lib/apt/lists/* && \
    groupadd --gid 65532 tengri && \
    useradd --uid 65532 --gid 65532 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin tengri

COPY --from=build /out-tengri /usr/local/bin/tengri
COPY --from=firecracker-build /out-firecracker /usr/local/bin/firecracker
COPY --from=firecracker-build /firecracker/LICENSE /firecracker/NOTICE /usr/share/doc/tengri/firecracker/
COPY --from=firecracker-build /libseccomp/LICENSE /usr/share/doc/tengri/firecracker/libseccomp-LICENSE
COPY --chmod=0555 network.sh /usr/local/bin/tengri-network

USER 65532:65532
EXPOSE 50051 8080
ENTRYPOINT ["/usr/local/bin/tengri"]
