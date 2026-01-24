FROM alpine:3.20 AS build

ARG FIRECRACKER_VERSION=v1.12.1
ARG FIRECRACKER_SHA256=0a75e67ef6e4c540a2cf248b06822b0be9820cbba9fe19f9e0321200fe76ff6b
ARG FIRECRACKER_SHA512=83c43e102ed224a2b40fa05cfb32f60af70d44ec10acbec8cde68307ed568c0522289c056f92d28857885600a8571a293331e491d64d8cdf0868de0bfc273812

RUN apk add --no-cache curl tar coreutils

RUN curl -fsSL -o /tmp/firecracker.tgz \
    https://github.com/firecracker-microvm/firecracker/releases/download/${FIRECRACKER_VERSION}/firecracker-${FIRECRACKER_VERSION}-x86_64.tgz \
  && echo "${FIRECRACKER_SHA256}  /tmp/firecracker.tgz" | sha256sum -c - \
  && echo "${FIRECRACKER_SHA512}  /tmp/firecracker.tgz" | sha512sum -c - \
  && mkdir -p /rootfs/usr/local/bin \
  && mkdir -p /rootfs/usr/local/share/kata-containers \
  && tar -xzf /tmp/firecracker.tgz -C /tmp

RUN set -eux; \
  release_dir=$(find /tmp -maxdepth 1 -type d -name "release-*" | head -n 1); \
  arch=$(uname -m); \
  if [ "${arch}" = "x86_64" ]; then suffix="x86_64"; else suffix="aarch64"; fi; \
  mkdir -p /rootfs/usr/local/bin; \
  cp "${release_dir}/firecracker-${FIRECRACKER_VERSION}-${suffix}" /rootfs/usr/local/bin/firecracker; \
  cp "${release_dir}/jailer-${FIRECRACKER_VERSION}-${suffix}" /rootfs/usr/local/bin/jailer; \
  chmod 0755 /rootfs/usr/local/bin/firecracker /rootfs/usr/local/bin/jailer

COPY configuration.toml /rootfs/usr/local/share/kata-containers/configuration.toml
COPY manifest.yaml /manifest.yaml

FROM scratch
COPY --from=build /rootfs /rootfs
COPY --from=build /manifest.yaml /manifest.yaml
