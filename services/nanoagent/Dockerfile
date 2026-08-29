# syntax=mirror.gcr.io/docker/dockerfile:1.7

ARG GO_BASE_IMAGE=mirror.gcr.io/golang
ARG GO_VERSION=1.25.5
ARG BUN_BASE_IMAGE=mirror.gcr.io/oven/bun
ARG BUN_VERSION=1.4.0
ARG NODE_BASE_IMAGE=mirror.gcr.io/node
ARG NODE_VERSION=24.11.1
ARG UBUNTU_BASE_IMAGE=mirror.gcr.io/ubuntu

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

FROM ${NODE_BASE_IMAGE}:${NODE_VERSION}-bookworm-slim AS node-runtime

FROM ${BUN_BASE_IMAGE}:${BUN_VERSION} AS bun-runtime

FROM ${UBUNTU_BASE_IMAGE}:24.04 AS runtime

ENV CODEX_BINARY=/home/nanoagent/.local/bin/codex \
    CODEX_BOOTSTRAP_COMMAND=/usr/local/bin/bootstrap-codex \
    CODEX_HOME=/home/nanoagent/.codex \
    HOME=/home/nanoagent \
    NANOAGENT_HOME=/home/nanoagent \
    NANOAGENT_REEXEC_WRAPPER=/usr/bin/tini \
    NANOAGENT_WORKSPACE=/workspace \
    PATH=/home/nanoagent/.local/bin:/home/nanoagent/go/bin:/home/nanoagent/.cargo/bin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    XDG_CACHE_HOME=/home/nanoagent/.cache

RUN set -eux; \
    apt-get update -o Acquire::Retries=3; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      bash \
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
      tini; \
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

FROM runtime AS node-bun-bundle

ARG BUN_VERSION
ARG NODE_VERSION

COPY --from=node-runtime /usr/local/bin/node /bundle/node/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules/npm /bundle/node/lib/node_modules/npm
COPY --from=bun-runtime /usr/local/bin/bun /bundle/bun/bin/bun
RUN set -eux; \
    test "$(/bundle/node/bin/node --version)" = "v${NODE_VERSION}"; \
    test "$(/bundle/bun/bin/bun --version)" = "${BUN_VERSION}"; \
    mkdir -p /out; \
    tar --create --gzip --file /out/node-bun.tar.gz --directory /bundle .

FROM runtime AS runtime-with-toolchain

COPY --from=node-bun-bundle /out/node-bun.tar.gz /usr/share/nanoagent/node-bun.tar.gz
COPY --chmod=0555 bootstrap-toolchain.sh /usr/local/bin/bootstrap-toolchain
RUN test -x /usr/local/bin/bootstrap-toolchain && bootstrap-toolchain --validate-manifest

FROM runtime-with-toolchain AS toolchain-smoke

ENV HOME=/home/nanoagent/.toolchain-smoke
USER 1000:1000
RUN mkdir -p "$HOME" && \
    bootstrap-toolchain --install-only && \
    PATH="$HOME/.local/bin:$PATH" && \
    export PATH && \
    test "$(node --version)" = 'v24.11.1' && \
    test "$(npm --version | cut -d. -f1)" -ge 10 && \
    test "$(bun --version)" = '1.4.0' && \
    test "$(bunx --version)" = '1.4.0' && \
    printf 'node=%s bun=%s\n' "$(node --version)" "$(bun --version)" > /tmp/toolchain-version

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
ENTRYPOINT ["/usr/local/bin/bootstrap-toolchain", "--", "/usr/local/bin/nanoagent"]
