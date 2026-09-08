# syntax=mirror.gcr.io/docker/dockerfile:1.7

ARG GO_BASE_IMAGE=mirror.gcr.io/golang
ARG GO_VERSION=1.25.5
ARG BUN_BASE_IMAGE=mirror.gcr.io/oven/bun
ARG BUN_VERSION=1.4.0
ARG NODE_BASE_IMAGE=mirror.gcr.io/node
ARG NODE_VERSION=24.11.1
ARG RUST_BASE_IMAGE=mirror.gcr.io/rust
ARG RUST_VERSION=1.90.0
ARG UBUNTU_BASE_IMAGE=mirror.gcr.io/ubuntu
ARG UV_BASE_IMAGE=ghcr.io/astral-sh/uv
ARG UV_VERSION=0.11.14

FROM --platform=$BUILDPLATFORM ${GO_BASE_IMAGE}:${GO_VERSION}-bookworm AS build

ARG TARGETARCH
ARG TARGETOS

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN go test ./... && \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
      go build -trimpath -ldflags='-s -w' -o /out/nanoagent .

FROM ${GO_BASE_IMAGE}:${GO_VERSION}-bookworm AS go-runtime

FROM ${NODE_BASE_IMAGE}:${NODE_VERSION}-bookworm-slim AS node-runtime

FROM ${BUN_BASE_IMAGE}:${BUN_VERSION} AS bun-runtime

FROM ${RUST_BASE_IMAGE}:${RUST_VERSION}-bookworm AS rust-runtime

FROM rust-runtime AS rust-linker-runtime

ARG TARGETARCH

RUN set -eux; \
    case "$TARGETARCH" in \
      amd64) linux_triplet='x86_64-linux-gnu' ;; \
      arm64) linux_triplet='aarch64-linux-gnu' ;; \
      *) printf 'unsupported Rust linker architecture: %s\n' "$TARGETARCH" >&2; exit 1 ;; \
    esac; \
    gcc_crt_directory="$(dirname "$(gcc -print-file-name=crtbeginS.o)")"; \
    mkdir -p /out/crt; \
    cp \
      "/usr/lib/${linux_triplet}/Scrt1.o" \
      "/usr/lib/${linux_triplet}/crti.o" \
      "/usr/lib/${linux_triplet}/crtn.o" \
      "$gcc_crt_directory/crtbeginS.o" \
      "$gcc_crt_directory/crtendS.o" \
      /out/crt/; \
    test "$(find /out/crt -maxdepth 1 -type f | wc -l)" -eq 5

FROM ${UV_BASE_IMAGE}:${UV_VERSION} AS uv-runtime

FROM ${UBUNTU_BASE_IMAGE}:24.04 AS runtime

ENV CARGO_HOME=/home/nanoagent/.cargo \
    CODEX_BINARY=/home/nanoagent/.local/bin/codex \
    CODEX_BOOTSTRAP_COMMAND=/usr/local/bin/bootstrap-codex \
    CODEX_HOME=/home/nanoagent/.codex \
    BUN_INSTALL=/home/nanoagent/.local \
    GOROOT=/home/nanoagent/.local/go \
    HOME=/home/nanoagent \
    NANOAGENT_HOME=/home/nanoagent \
    NANOAGENT_REEXEC_WRAPPER=/usr/bin/tini \
    NANOAGENT_WORKSPACE=/workspace \
    NPM_CONFIG_PREFIX=/home/nanoagent/.local \
    PATH=/home/nanoagent/.local/bin:/home/nanoagent/go/bin:/home/nanoagent/.cargo/bin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    TOOLCHAIN_BOOTSTRAP_COMMAND=/usr/local/bin/bootstrap-toolchain \
    XDG_CACHE_HOME=/home/nanoagent/.cache

RUN set -eux; \
    apt-get update -o Acquire::Retries=3; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      bash \
      bubblewrap \
      ca-certificates \
      curl \
      file \
      git \
      gzip \
      iproute2 \
      jq \
      less \
      mawk \
      openssh-client \
      procps \
      python3 \
      python3-venv \
      ripgrep \
      tar \
      tini \
      xz-utils; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*; \
    runtime_group="$(getent group 1000 | cut -d: -f1 || true)"; \
    if [ -n "$runtime_group" ]; then \
      groupmod --new-name nanoagent "$runtime_group"; \
    else \
      groupadd --gid 1000 nanoagent; \
    fi; \
    runtime_user="$(getent passwd 1000 | cut -d: -f1 || true)"; \
    if [ -n "$runtime_user" ]; then \
      usermod --login nanoagent --home /home/nanoagent --move-home --shell /bin/bash --gid 1000 "$runtime_user"; \
    else \
      useradd --uid 1000 --gid 1000 --home-dir /home/nanoagent --shell /bin/bash --create-home nanoagent; \
    fi; \
    mkdir -p /home/nanoagent/.cache /home/nanoagent/.codex /home/nanoagent/.local/bin /home/nanoagent/workspace; \
    ln -s /home/nanoagent/workspace /workspace; \
    chown -R 1000:1000 /home/nanoagent; \
    test -x /bin/bash

COPY --from=build /out/nanoagent /usr/local/bin/nanoagent
COPY --chmod=0555 bootstrap-codex.sh /usr/local/bin/bootstrap-codex
RUN test -x /usr/local/bin/bootstrap-codex && test -x /usr/local/bin/nanoagent

FROM runtime AS c-toolchain-runtime

ARG TARGETARCH

RUN set -eux; \
    apt-get update -o Acquire::Retries=3; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends gcc libc6-dev; \
    triplet="$(gcc -dumpmachine)"; \
    compiler_major="$(gcc -dumpversion)"; \
    compiler_version="$(gcc -dumpfullversion)"; \
    case "$TARGETARCH" in \
      amd64) \
        expected_triplet='x86_64-linux-gnu'; \
        loader_path='/lib64/ld-linux-x86-64.so.2'; \
        loader_name='ld-linux-x86-64.so.2' \
        ;; \
      arm64) \
        expected_triplet='aarch64-linux-gnu'; \
        loader_path='/lib/ld-linux-aarch64.so.1'; \
        loader_name='ld-linux-aarch64.so.1' \
        ;; \
      *) printf 'unsupported C compiler architecture: %s\n' "$TARGETARCH" >&2; exit 1 ;; \
    esac; \
    test "$triplet" = "$expected_triplet"; \
    test "$compiler_major" = '13'; \
    test "$compiler_version" = '13.3.0'; \
    compiler_driver="$(command -v "${triplet}-gcc-${compiler_major}")"; \
    assembler="$(command -v "${triplet}-as")"; \
    linker="$(command -v "${triplet}-ld.bfd")"; \
    compiler_library_root="$(dirname "$(gcc -print-libgcc-file-name)")"; \
    compiler_program_root="$(dirname "$(gcc -print-prog-name=cc1)")"; \
    output='/out/c'; \
    mkdir -p \
      "$output/bin" \
      "$output/lib/gcc/$triplet/$compiler_major" \
      "$output/libexec/gcc/$triplet/$compiler_major" \
      "$output/runtime" \
      "$output/sysroot/lib/$triplet" \
      "$output/sysroot/usr/include" \
      "$output/sysroot/usr/lib/$triplet"; \
    cp -a "$compiler_driver" "$output/bin/"; \
    cp -a "$assembler" "$output/bin/"; \
    cp -a "$linker" "$output/bin/"; \
    ln -s "${triplet}-as" "$output/bin/as"; \
    ln -s "${triplet}-ld.bfd" "$output/bin/ld"; \
    cp -a "$compiler_library_root/." "$output/lib/gcc/$triplet/$compiler_major/"; \
    rm -rf \
      "$output/lib/gcc/$triplet/$compiler_major/plugin" \
      "$output/lib/gcc/$triplet/$compiler_major/include/sanitizer"; \
    rm -f \
      "$output/lib/gcc/$triplet/$compiler_major"/libasan* \
      "$output/lib/gcc/$triplet/$compiler_major"/libhwasan* \
      "$output/lib/gcc/$triplet/$compiler_major"/liblsan* \
      "$output/lib/gcc/$triplet/$compiler_major"/libtsan* \
      "$output/lib/gcc/$triplet/$compiler_major"/libubsan*; \
    cp -a "$compiler_program_root/cc1" "$output/libexec/gcc/$triplet/$compiler_major/"; \
    cp -a "$compiler_program_root/liblto_plugin.so" "$output/libexec/gcc/$triplet/$compiler_major/"; \
    cp -a /usr/include/. "$output/sysroot/usr/include/"; \
    for development_file in \
      Scrt1.o crt1.o crti.o crtn.o gcrt1.o rcrt1.o \
      libc.so libc_nonshared.a libdl.a libm.so libpthread.a libresolv.a librt.a libutil.a; do \
      if [ -e "/usr/lib/$triplet/$development_file" ]; then \
        cp -a "/usr/lib/$triplet/$development_file" "$output/sysroot/usr/lib/$triplet/"; \
      fi; \
    done; \
    for runtime_file in \
      libc.so.6 libdl.so.2 libgcc_s.so.1 libm.so.6 libmvec.so.1 libpthread.so.0 libresolv.so.2 librt.so.1 libutil.so.1; do \
      if [ -e "/lib/$triplet/$runtime_file" ]; then \
        ln -s "/lib/$triplet/$runtime_file" "$output/sysroot/lib/$triplet/$runtime_file"; \
      fi; \
    done; \
    mkdir -p "$output/sysroot$(dirname "$loader_path")"; \
    ln -s "$loader_path" "$output/sysroot$loader_path"; \
    ln -s "/lib/$triplet/$loader_name" "$output/sysroot/lib/$triplet/$loader_name"; \
    : > /tmp/c-toolchain-runtime-libraries; \
    for binary in "$compiler_driver" "$compiler_program_root/cc1" "$assembler" "$linker"; do \
      ldd "$binary" | awk '$2 == "=>" && $3 ~ /^\// { print $3 }' >> /tmp/c-toolchain-runtime-libraries; \
    done; \
    sort -u /tmp/c-toolchain-runtime-libraries | while IFS= read -r dependency; do \
      dependency_name="$(basename "$dependency")"; \
      case "$dependency_name" in \
        libc.so.6|libm.so.6|libz.so.1|libzstd.so.1) ;; \
        *) cp -aL "$dependency" "$output/runtime/$dependency_name" ;; \
      esac; \
    done; \
    printf '%s\n' "$compiler_major" > "$output/compiler-major"; \
    printf '%s\n' "$compiler_version" > "$output/compiler-version"; \
    printf '%s\n' "$triplet" > "$output/compiler-triplet"; \
    test -x "$output/bin/${triplet}-gcc-${compiler_major}"; \
    test -x "$output/bin/as"; \
    test -x "$output/bin/ld"; \
    test -x "$output/libexec/gcc/$triplet/$compiler_major/cc1"; \
    test -f "$output/sysroot/usr/include/stdlib.h"; \
    test -f "$output/sysroot/usr/lib/$triplet/Scrt1.o"; \
    test -L "$output/sysroot$loader_path"

FROM runtime AS development-toolchain-layout

ARG BUN_VERSION
ARG GO_VERSION
ARG NODE_VERSION
ARG RUST_VERSION
ARG UV_VERSION

COPY --from=node-runtime /usr/local/bin/node /bundle/node/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules/npm /bundle/node/lib/node_modules/npm
COPY --from=bun-runtime /usr/local/bin/bun /bundle/bun/bin/bun
COPY --from=c-toolchain-runtime /out/c /bundle/c
COPY --from=go-runtime /usr/local/go /bundle/go
COPY --from=rust-runtime /usr/local/rustup/toolchains /bundle/rust-toolchains
COPY --from=rust-linker-runtime /out /bundle/linker
COPY --from=uv-runtime /uv /bundle/uv/bin/uv
COPY --from=uv-runtime /uvx /bundle/uv/bin/uvx
RUN set -eux; \
    rust_toolchain="$(find /bundle/rust-toolchains -mindepth 1 -maxdepth 1 -type d -name "${RUST_VERSION}-*" -print -quit)"; \
    test -n "$rust_toolchain"; \
    mv "$rust_toolchain" /bundle/rust; \
    rm -rf /bundle/rust-toolchains; \
    rm -f \
      /bundle/rust/bin/rust-gdb \
      /bundle/rust/bin/rust-gdbgui \
      /bundle/rust/bin/rust-lldb; \
    rm -rf /bundle/rust/etc /bundle/rust/share; \
    rm -rf /bundle/go/api /bundle/go/doc /bundle/go/misc /bundle/go/test; \
    test "$(/bundle/node/bin/node --version)" = "v${NODE_VERSION}"; \
    test "$(/bundle/bun/bin/bun --version)" = "${BUN_VERSION}"; \
    test "$(cat /bundle/c/compiler-version)" = '13.3.0'; \
    test "$(GOROOT=/bundle/go /bundle/go/bin/go version | cut -d' ' -f3)" = "go${GO_VERSION}"; \
    test "$(/bundle/rust/bin/rustc --version | cut -d' ' -f2)" = "${RUST_VERSION}"; \
    test "$(/bundle/rust/bin/cargo --version | cut -d' ' -f2)" = "${RUST_VERSION}"; \
    test "$(/bundle/uv/bin/uv --version | cut -d' ' -f2)" = "${UV_VERSION}"

FROM --platform=$BUILDPLATFORM ${UBUNTU_BASE_IMAGE}:24.04 AS development-toolchain-bundle

RUN set -eux; \
    apt-get update -o Acquire::Retries=3; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends xz-utils; \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

COPY --from=development-toolchain-layout /bundle /bundle

RUN set -eux; \
    mkdir -p /out; \
    XZ_OPT='-T2 -8' tar \
      --create \
      --xz \
      --file /out/development-toolchain.tar.xz \
      --sort=name \
      --mtime='UTC 2020-01-01' \
      --owner=0 \
      --group=0 \
      --numeric-owner \
      --directory /bundle \
      .

FROM runtime AS runtime-with-toolchain

COPY --from=development-toolchain-bundle /out/development-toolchain.tar.xz /usr/share/nanoagent/development-toolchain.tar.xz
COPY --chmod=0555 bootstrap-toolchain.sh /usr/local/bin/bootstrap-toolchain
RUN test -x /usr/local/bin/bootstrap-toolchain && bootstrap-toolchain --validate-manifest

FROM runtime-with-toolchain AS toolchain-smoke

ENV BUN_INSTALL=/home/nanoagent/.toolchain-smoke/.local \
    CARGO_HOME=/home/nanoagent/.toolchain-smoke/.cargo \
    GOROOT=/home/nanoagent/.toolchain-smoke/.local/go \
    HOME=/home/nanoagent/.toolchain-smoke \
    NPM_CONFIG_PREFIX=/home/nanoagent/.toolchain-smoke/.local \
    PATH=/home/nanoagent/.toolchain-smoke/.local/bin:/home/nanoagent/.local/bin:/home/nanoagent/go/bin:/home/nanoagent/.cargo/bin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
USER 1000:1000
RUN mkdir -p "$HOME" && \
    bootstrap-toolchain --install-only && \
    test "$(command -v bwrap)" = '/usr/bin/bwrap' && \
    test "$(node --version)" = 'v24.11.1' && \
    test "$(npm --version | cut -d. -f1)" -ge 10 && \
    test "$(npm config get prefix)" = "$HOME/.local" && \
    test "$(bun --version)" = '1.4.0' && \
    test "$(bunx --version)" = '1.4.0' && \
    test "$(uv --version | cut -d' ' -f2)" = '0.11.14' && \
    test "$(go version | cut -d' ' -f3)" = 'go1.25.5' && \
    test "$(go env GOROOT)" = "$HOME/.local/go" && \
    test "$(go env CGO_ENABLED)" = '1' && \
    test "$(gcc -dumpfullversion)" = '13.3.0' && \
    test "$(command -v cc)" = "$HOME/.local/bin/cc" && \
    test "$(rustc --version | cut -d' ' -f2)" = '1.90.0' && \
    test "$(cargo --version | cut -d' ' -f2)" = '1.90.0' && \
    test "$(rustdoc --version | cut -d' ' -f2)" = '1.90.0' && \
    printf 'fn main(){println!("rust-ok");}\n' > /tmp/rust-smoke.rs && \
    test "$(rustc /tmp/rust-smoke.rs -o /tmp/rust-smoke && /tmp/rust-smoke)" = 'rust-ok' && \
    cargo new --quiet --bin /tmp/cargo-smoke && \
    test "$(cd /tmp/cargo-smoke && cargo run --quiet)" = 'Hello, world!' && \
    cargo new --quiet --lib /tmp/cargo-library-smoke && \
    printf '/// Returns 42.\n///\n/// ```\n/// assert_eq!(cargo_library_smoke::answer(), 42);\n/// ```\npub fn answer() -> i32 { 42 }\n' \
      > /tmp/cargo-library-smoke/src/lib.rs && \
    (cd /tmp/cargo-library-smoke && cargo test --quiet) && \
    printf '#[no_mangle]\npub extern "C" fn answer() -> i32 { 42 }\n' > /tmp/rust-library-smoke.rs && \
    rustc --crate-type=cdylib /tmp/rust-library-smoke.rs -o /tmp/librust_library_smoke.so && \
    printf 'package main\n/*\n#include <stdlib.h>\nstatic int answer(void) { return 42; }\n*/\nimport "C"\nimport "fmt"\nfunc main(){fmt.Println(C.answer())}\n' > /tmp/go-smoke.go && \
    test "$(go run /tmp/go-smoke.go)" = '42' && \
    uv venv /tmp/uv-smoke >/dev/null && \
    mkdir -p "$BUN_INSTALL/install/global" && \
    printf '{"name":"nanoagent-global"}\n' > "$BUN_INSTALL/install/global/package.json" && \
    test "$(bun pm bin --global)" = "$HOME/.local/bin" && \
    printf 'node=%s bun=%s uv=%s go=%s rustc=%s cargo=%s rustdoc=%s\n' \
      "$(node --version)" \
      "$(bun --version)" \
      "$(uv --version)" \
      "$(go version)" \
      "$(rustc --version)" \
      "$(cargo --version)" \
      "$(rustdoc --version)" \
      > /tmp/toolchain-version

# Download and verify the pinned native Codex package during every image build. The
# package is intentionally not copied into the final rootfs; a guest installs the
# same verified package into its persistent 16 GiB home volume on first boot.
FROM runtime AS codex-smoke

ENV CODEX_BINARY=/home/nanoagent/.smoke/.local/bin/codex \
    CODEX_HOME=/home/nanoagent/.smoke/.codex \
    HOME=/home/nanoagent/.smoke

USER 1000:1000
RUN mkdir -p "$HOME" "$CODEX_HOME" && \
    bootstrap-codex --install-only && \
    "$CODEX_BINARY" --version > /tmp/codex-version

FROM runtime-with-toolchain

# Firecracker's Kata snapshotter extracts an OCI image into a 512 MiB blockfile.
# Keep 32 MiB of explicit headroom for filesystem metadata and extraction overhead.
ARG FIRECRACKER_ROOTFS_LIMIT_BYTES=503316480
COPY --from=codex-smoke /tmp/codex-version /usr/share/nanoagent/codex-version
COPY --from=toolchain-smoke /tmp/toolchain-version /usr/share/nanoagent/toolchain-version
RUN set -eux; \
    rootfs_bytes="$(du -sx -B1 / 2>/dev/null | cut -f1)"; \
    test "$rootfs_bytes" -le "$FIRECRACKER_ROOTFS_LIMIT_BYTES"; \
    printf '%s\n' "$rootfs_bytes" > /usr/share/nanoagent/rootfs-size-bytes

USER 1000:1000
WORKDIR /home/nanoagent
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/nanoagent"]
