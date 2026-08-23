# syntax=docker/dockerfile:1.7

FROM --platform=$BUILDPLATFORM ghcr.io/siderolabs/extensions-validator:84cecb0@sha256:6a19dbb8ba6c71ac6ee97b24f4834e25a1e593518b2a158211d590158aab1e5a AS validator

FROM --platform=$BUILDPLATFORM alpine:3.22.1 AS payload

ARG TARGETARCH
ARG KATA_VERSION=4.1.0
ARG KATA_AMD64_SHA256=3dc6b69c4acb787b967b04b64599a20d02a8beb1a8eaab3084110df9d0b08c96
ARG KATA_ARM64_SHA256=cf036de3d184dc080fe84dfbdbf06cd6811386224ff8c6aaee3b5d732722e58f
ARG FIRECRACKER_VERSION=v1.12.1
ARG FIRECRACKER_AMD64_SHA256=0a75e67ef6e4c540a2cf248b06822b0be9820cbba9fe19f9e0321200fe76ff6b
ARG FIRECRACKER_ARM64_SHA256=785bc9d30756bff0c03fb275baac957363f9ba98f78a2272405dcb6929ebb953

RUN apk add --no-cache ca-certificates curl tar zstd

COPY --from=validator /extensions-validator /usr/local/bin/extensions-validator
COPY 10-kata-firecracker.part /tmp/10-kata-firecracker.part
COPY manifest.yaml /extension/manifest.yaml

RUN --mount=type=cache,target=/var/cache/downloads \
    set -eux; \
    case "${TARGETARCH}" in \
      amd64) \
        kata_arch='amd64'; \
        kata_sha256="${KATA_AMD64_SHA256}"; \
        firecracker_arch='x86_64'; \
        firecracker_sha256="${FIRECRACKER_AMD64_SHA256}"; \
        ;; \
      arm64) \
        kata_arch='arm64'; \
        kata_sha256="${KATA_ARM64_SHA256}"; \
        firecracker_arch='aarch64'; \
        firecracker_sha256="${FIRECRACKER_ARM64_SHA256}"; \
        ;; \
      *) \
        echo "unsupported architecture: ${TARGETARCH}" >&2; \
        exit 1; \
        ;; \
    esac; \
    kata_archive="kata-static-${KATA_VERSION}-${kata_arch}.tar.zst"; \
    firecracker_archive="firecracker-${FIRECRACKER_VERSION}-${firecracker_arch}.tgz"; \
    if ! echo "${kata_sha256}  /var/cache/downloads/${kata_archive}" | sha256sum -c -; then \
      curl --fail --location --retry 3 \
        --output "/var/cache/downloads/${kata_archive}" \
        "https://github.com/kata-containers/kata-containers/releases/download/${KATA_VERSION}/${kata_archive}"; \
      echo "${kata_sha256}  /var/cache/downloads/${kata_archive}" | sha256sum -c -; \
    fi; \
    if ! echo "${firecracker_sha256}  /var/cache/downloads/${firecracker_archive}" | sha256sum -c -; then \
      curl --fail --location --retry 3 \
        --output "/var/cache/downloads/${firecracker_archive}" \
        "https://github.com/firecracker-microvm/firecracker/releases/download/${FIRECRACKER_VERSION}/${firecracker_archive}"; \
      echo "${firecracker_sha256}  /var/cache/downloads/${firecracker_archive}" | sha256sum -c -; \
    fi; \
    mkdir -p /tmp/kata /tmp/firecracker; \
    tar --zstd --extract --file "/var/cache/downloads/${kata_archive}" --directory /tmp/kata \
      ./opt/kata/runtime-rs/bin/containerd-shim-kata-v2 \
      ./opt/kata/share/defaults/kata-containers/runtime-rs/configuration-rs-fc.toml \
      ./opt/kata/share/kata-containers/kata-ubuntu-noble.image \
      ./opt/kata/share/kata-containers/vmlinux-6.18.35-202 \
      ./opt/kata/share/kata-containers/root_hash_base.txt; \
    tar --extract --gzip --file "/var/cache/downloads/${firecracker_archive}" --directory /tmp/firecracker; \
    install -d \
      /extension/rootfs/etc/cri/conf.d \
      /extension/rootfs/usr/local/bin \
      /extension/rootfs/usr/local/share/kata-containers; \
    install -m 0755 \
      /tmp/kata/opt/kata/runtime-rs/bin/containerd-shim-kata-v2 \
      /extension/rootfs/usr/local/bin/containerd-shim-kata-fc-v2; \
    install -m 0755 \
      "/tmp/firecracker/release-${FIRECRACKER_VERSION}-${firecracker_arch}/firecracker-${FIRECRACKER_VERSION}-${firecracker_arch}" \
      /extension/rootfs/usr/local/bin/firecracker; \
    install -m 0755 \
      "/tmp/firecracker/release-${FIRECRACKER_VERSION}-${firecracker_arch}/jailer-${FIRECRACKER_VERSION}-${firecracker_arch}" \
      /extension/rootfs/usr/local/bin/jailer; \
    install -m 0644 \
      /tmp/kata/opt/kata/share/kata-containers/kata-ubuntu-noble.image \
      /extension/rootfs/usr/local/share/kata-containers/kata-containers.img; \
    install -m 0644 \
      /tmp/kata/opt/kata/share/kata-containers/vmlinux-6.18.35-202 \
      /extension/rootfs/usr/local/share/kata-containers/vmlinux.container; \
    install -m 0644 \
      /tmp/kata/opt/kata/share/kata-containers/root_hash_base.txt \
      /extension/rootfs/usr/local/share/kata-containers/root_hash_base.txt; \
    install -m 0644 \
      /tmp/kata/opt/kata/share/defaults/kata-containers/runtime-rs/configuration-rs-fc.toml \
      /extension/rootfs/usr/local/share/kata-containers/configuration-rs-fc.toml; \
    sed -i 's#/opt/kata#/usr/local#g' \
      /extension/rootfs/usr/local/share/kata-containers/configuration-rs-fc.toml; \
    install -m 0644 /tmp/10-kata-firecracker.part \
      /extension/rootfs/etc/cri/conf.d/10-kata-firecracker.part; \
    test "$(grep -c '^path = \"/usr/local/bin/firecracker\"$' /extension/rootfs/usr/local/share/kata-containers/configuration-rs-fc.toml)" -eq 1; \
    test "$(grep -c '^kernel = \"/usr/local/share/kata-containers/vmlinux.container\"$' /extension/rootfs/usr/local/share/kata-containers/configuration-rs-fc.toml)" -eq 1; \
    test "$(grep -c '^image = \"/usr/local/share/kata-containers/kata-containers.img\"$' /extension/rootfs/usr/local/share/kata-containers/configuration-rs-fc.toml)" -eq 1; \
    /usr/local/bin/extensions-validator validate --rootfs=/extension --pkg-name=kata-firecracker

FROM scratch

LABEL org.opencontainers.image.source="https://github.com/proompteng/lab"
LABEL org.opencontainers.image.description="Kata Containers 4.1.0 and Firecracker 1.12.1 system extension for Talos 1.13"
LABEL org.opencontainers.image.version="4.1.0-talos-v1.13.9"

COPY --from=payload /extension/manifest.yaml /manifest.yaml
COPY --from=payload /extension/rootfs /rootfs
