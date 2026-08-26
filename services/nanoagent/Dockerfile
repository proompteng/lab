# syntax=docker/dockerfile:1.7

ARG BUN_VERSION=1.4.0
ARG CODEX_VERSION=0.149.0
ARG GO_VERSION=1.25.5
ARG NODE_VERSION=24.11.1
ARG RUST_VERSION=1.90.0
ARG UV_VERSION=0.9.18

FROM --platform=$BUILDPLATFORM docker.io/library/golang:${GO_VERSION}-bookworm AS build

ARG TARGETARCH
ARG TARGETOS

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN go test ./... && \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
      go build -trimpath -ldflags='-s -w' -o /out/nanoagent .

FROM docker.io/library/node:${NODE_VERSION}-bookworm-slim AS node-runtime

ARG CODEX_VERSION

RUN npm install -g "@openai/codex@${CODEX_VERSION}" && \
    npm cache clean --force && \
    test -x /usr/local/bin/codex

FROM docker.io/oven/bun:${BUN_VERSION}-slim AS bun-runtime
FROM docker.io/library/golang:${GO_VERSION}-bookworm AS go-runtime
FROM docker.io/library/rust:${RUST_VERSION}-bookworm AS rust-runtime
FROM ghcr.io/astral-sh/uv:${UV_VERSION} AS uv-runtime

FROM docker.io/library/ubuntu:24.04

ENV BUN_INSTALL=/home/nanoagent/.bun \
    BUN_INSTALL_CACHE_DIR=/tmp/bun-cache \
    CARGO_HOME=/home/nanoagent/.cargo \
    CODEX_BINARY=/usr/local/bin/codex \
    CODEX_HOME=/home/nanoagent/.codex \
    GOCACHE=/home/nanoagent/.cache/go-build \
    GOPATH=/home/nanoagent/go \
    HOME=/home/nanoagent \
    NANOAGENT_HOME=/home/nanoagent \
    NANOAGENT_WORKSPACE=/home/nanoagent \
    NPM_CONFIG_CACHE=/tmp/npm-cache \
    NPM_CONFIG_PREFIX=/home/nanoagent/.local \
    PATH=/home/nanoagent/.local/bin:/home/nanoagent/.bun/bin:/home/nanoagent/go/bin:/home/nanoagent/.cargo/bin:/usr/local/go/bin:/usr/local/rust/cargo/bin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    RUSTUP_HOME=/usr/local/rust/rustup \
    UV_CACHE_DIR=/tmp/uv-cache \
    UV_TOOL_BIN_DIR=/home/nanoagent/.local/bin \
    UV_TOOL_DIR=/home/nanoagent/.local/share/uv/tools \
    XDG_CACHE_HOME=/home/nanoagent/.cache

COPY --from=node-runtime /usr/local /usr/local
COPY --from=bun-runtime /usr/local/bin/bun /usr/local/bin/bun
COPY --from=bun-runtime /usr/local/bin/bunx /usr/local/bin/bunx
COPY --from=go-runtime /usr/local/go /usr/local/go
COPY --from=rust-runtime /usr/local/cargo /usr/local/rust/cargo
COPY --from=rust-runtime /usr/local/rustup /usr/local/rust/rustup
COPY --from=uv-runtime /uv /uvx /usr/local/bin/
COPY --from=build /out/nanoagent /usr/local/bin/nanoagent

RUN set -eux; \
    apt-get update -o Acquire::Retries=3; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      bash \
      build-essential \
      ca-certificates \
      curl \
      file \
      git \
      iproute2 \
      jq \
      less \
      libssl-dev \
      openssh-client \
      pkg-config \
      procps \
      python3 \
      python3-venv \
      ripgrep \
      tini; \
    rm -rf /var/lib/apt/lists/*; \
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
    mkdir -p /home/nanoagent/workspace /home/nanoagent/.cache /usr/local/rust; \
    ln -s /home/nanoagent/workspace /workspace; \
    chown -R 1000:1000 /home/nanoagent; \
    test -x /bin/bash; \
    test -x /usr/local/bin/bun; \
    test -x /usr/local/bin/codex; \
    test -x /usr/local/go/bin/go; \
    test -x /usr/local/bin/node; \
    test -x /usr/local/bin/npm; \
    test -x /usr/local/bin/uv; \
    test -x /usr/local/rust/cargo/bin/rustc

USER 1000:1000
WORKDIR /home/nanoagent
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "-s", "--", "/usr/local/bin/nanoagent"]
