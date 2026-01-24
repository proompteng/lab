ARG TALOS_INSTALLER_IMAGE=factory.talos.dev/metal-installer/a170f9697ee0797c93bbad6325090bd12f32bc1d182be51b613da194b1767ae9:v1.12.1
ARG FIRECRACKER_VERSION=v1.12.1

FROM alpine:3.20 AS firecracker
ARG FIRECRACKER_VERSION
RUN apk add --no-cache ca-certificates curl
RUN set -eux; \
    arch=x86_64; \
    base_url="https://github.com/firecracker-microvm/firecracker/releases/download/${FIRECRACKER_VERSION}"; \
    curl -fsSL "${base_url}/firecracker-${FIRECRACKER_VERSION}-${arch}.tgz" -o /firecracker.tgz; \
    tar -xzf /firecracker.tgz -C /tmp; \
    release_dir="/tmp/release-${FIRECRACKER_VERSION}-${arch}"; \
    cp "${release_dir}/firecracker-${FIRECRACKER_VERSION}-${arch}" /firecracker; \
    cp "${release_dir}/jailer-${FIRECRACKER_VERSION}-${arch}" /jailer; \
    chmod +x /firecracker /jailer

COPY rootfs/usr/local/share/kata-containers/configuration-fc.toml /out/usr/local/share/kata-containers/configuration-fc.toml
COPY rootfs/usr/local/bin/containerd-shim-kata-fc-v2 /out/usr/local/bin/containerd-shim-kata-fc-v2
RUN set -eux; \
    install -m 0755 -D /firecracker /out/usr/local/bin/firecracker; \
    install -m 0755 -D /jailer /out/usr/local/bin/jailer; \
    chmod 0755 /out/usr/local/bin/containerd-shim-kata-fc-v2

FROM scratch AS customization
COPY --from=firecracker /out/ /

FROM ${TALOS_INSTALLER_IMAGE}
COPY --from=firecracker /out/ /
