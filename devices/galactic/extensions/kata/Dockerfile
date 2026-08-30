# syntax=docker/dockerfile:1.7

FROM --platform=$BUILDPLATFORM ghcr.io/siderolabs/extensions-validator:84cecb0@sha256:6a19dbb8ba6c71ac6ee97b24f4834e25a1e593518b2a158211d590158aab1e5a AS validator

FROM --platform=$BUILDPLATFORM alpine:3.22.1@sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1 AS payload

ARG TARGETARCH
ARG KATA_VERSION=4.1.0
ARG KATA_AMD64_SHA256=3dc6b69c4acb787b967b04b64599a20d02a8beb1a8eaab3084110df9d0b08c96
ARG KATA_ARM64_SHA256=cf036de3d184dc080fe84dfbdbf06cd6811386224ff8c6aaee3b5d732722e58f
ARG FIRECRACKER_VERSION=v1.12.1
ARG FIRECRACKER_AMD64_SHA256=0a75e67ef6e4c540a2cf248b06822b0be9820cbba9fe19f9e0321200fe76ff6b
ARG FIRECRACKER_ARM64_SHA256=785bc9d30756bff0c03fb275baac957363f9ba98f78a2272405dcb6929ebb953

RUN apk add --no-cache ca-certificates curl e2fsprogs tar zstd

COPY --from=validator /extensions-validator /usr/local/bin/extensions-validator
COPY 10-kata-firecracker.part /tmp/10-kata-firecracker.part
COPY configuration-clh-runtime-rs.toml /tmp/configuration-clh-runtime-rs.toml
COPY manifest.yaml /extension/manifest.yaml
COPY artifacts /tmp/patched-kata-artifacts

RUN --mount=type=cache,target=/var/cache/downloads \
    set -eux; \
    case "${TARGETARCH}" in \
      amd64) \
        kata_arch='amd64'; \
        kata_sha256="${KATA_AMD64_SHA256}"; \
        qemu_binary='qemu-system-x86_64'; \
        dragonball_block_driver='virtio-blk-pci'; \
        firecracker_arch='x86_64'; \
        firecracker_sha256="${FIRECRACKER_AMD64_SHA256}"; \
        ;; \
      arm64) \
        kata_arch='arm64'; \
        kata_sha256="${KATA_ARM64_SHA256}"; \
        qemu_binary='qemu-system-aarch64'; \
        dragonball_block_driver='virtio-blk-mmio'; \
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
      ./opt/kata/bin/cloud-hypervisor \
      "./opt/kata/bin/${qemu_binary}" \
      ./opt/kata/libexec/virtiofsd \
      ./opt/kata/share/kata-qemu/qemu \
      ./opt/kata/share/defaults/kata-containers/runtime-rs/configuration-qemu-runtime-rs.toml \
      ./opt/kata/share/defaults/kata-containers/runtime-rs/configuration-rs-fc.toml \
      ./opt/kata/share/defaults/kata-containers/runtime-rs/configuration-dragonball.toml \
      ./opt/kata/share/kata-containers/kata-ubuntu-noble.image \
      ./opt/kata/share/kata-containers/vmlinux-6.18.35-202 \
      ./opt/kata/share/kata-containers/vmlinux-6.18.35-202-dragonball-experimental; \
    tar --zstd --extract \
      --file "/tmp/patched-kata-artifacts/${TARGETARCH}/kata-static-shim-v2-rust.tar.zst" \
      --directory /tmp/kata \
      ./opt/kata/runtime-rs/bin/containerd-shim-kata-v2; \
    mkdir -p /tmp/patched-kata-agent; \
    tar --zstd --extract \
      --file "/tmp/patched-kata-artifacts/${TARGETARCH}/kata-static-agent.tar.zst" \
      --directory /tmp/patched-kata-agent \
      ./usr/bin/kata-agent; \
    if [ "${TARGETARCH}" = arm64 ]; then \
      tar --zstd --extract --file "/var/cache/downloads/${kata_archive}" --directory /tmp/kata \
        ./opt/kata/share/aavmf/AAVMF_CODE.fd; \
    fi; \
    tar --extract --gzip --file "/var/cache/downloads/${firecracker_archive}" --directory /tmp/firecracker; \
    install -d \
      /extension/rootfs/etc/cri/conf.d \
      /extension/rootfs/usr/local/bin \
      /extension/rootfs/usr/local/libexec \
      /extension/rootfs/usr/local/share/kata-containers \
      /extension/rootfs/usr/local/share/kata-qemu; \
    install -m 0755 \
      /tmp/kata/opt/kata/runtime-rs/bin/containerd-shim-kata-v2 \
      /extension/rootfs/usr/local/bin/containerd-shim-kata-v2; \
    install -m 0755 \
      /tmp/kata/opt/kata/bin/cloud-hypervisor \
      /extension/rootfs/usr/local/bin/cloud-hypervisor; \
    install -m 0755 \
      "/tmp/kata/opt/kata/bin/${qemu_binary}" \
      "/extension/rootfs/usr/local/bin/${qemu_binary}"; \
    install -m 0755 \
      /tmp/kata/opt/kata/libexec/virtiofsd \
      /extension/rootfs/usr/local/libexec/virtiofsd; \
    install -m 0755 \
      "/tmp/firecracker/release-${FIRECRACKER_VERSION}-${firecracker_arch}/firecracker-${FIRECRACKER_VERSION}-${firecracker_arch}" \
      /extension/rootfs/usr/local/bin/firecracker; \
    install -m 0755 \
      "/tmp/firecracker/release-${FIRECRACKER_VERSION}-${firecracker_arch}/jailer-${FIRECRACKER_VERSION}-${firecracker_arch}" \
      /extension/rootfs/usr/local/bin/jailer; \
    cp -a \
      /tmp/kata/opt/kata/share/kata-qemu/qemu \
      /extension/rootfs/usr/local/share/kata-qemu/qemu; \
    rm -f \
      /extension/rootfs/usr/local/share/kata-qemu/qemu/edk2-*.fd \
      /extension/rootfs/usr/local/share/kata-qemu/qemu/hppa-firmware*.img \
      /extension/rootfs/usr/local/share/kata-qemu/qemu/s390-*.img \
      /extension/rootfs/usr/local/share/kata-qemu/qemu/slof.bin \
      /extension/rootfs/usr/local/share/kata-qemu/qemu/vof*.bin \
      /extension/rootfs/usr/local/share/kata-qemu/qemu/qemu_vga.ndrv \
      /extension/rootfs/usr/local/share/kata-qemu/qemu/pnv-pnor.bin \
      /extension/rootfs/usr/local/share/kata-qemu/qemu/*_bootrom.bin \
      /extension/rootfs/usr/local/share/kata-qemu/qemu/qemu-nsis.bmp; \
    rm -rf /extension/rootfs/usr/local/share/kata-qemu/qemu/firmware; \
    install -d /extension/rootfs/usr/local/bin/qemu-bundle/opt/kata/share/kata-qemu; \
    ln -s ../../../../../../share/kata-qemu/qemu \
      /extension/rootfs/usr/local/bin/qemu-bundle/opt/kata/share/kata-qemu/qemu; \
    if [ "${TARGETARCH}" = arm64 ]; then \
      install -d /extension/rootfs/usr/local/share/aavmf; \
      install -m 0644 \
        /tmp/kata/opt/kata/share/aavmf/AAVMF_CODE.fd \
        /extension/rootfs/usr/local/share/aavmf/AAVMF_CODE.fd; \
    fi; \
    install -m 0644 \
      /tmp/kata/opt/kata/share/kata-containers/kata-ubuntu-noble.image \
      /extension/rootfs/usr/local/share/kata-containers/kata-containers.img; \
    debugfs -w -R 'rm /usr/bin/kata-agent' \
      /extension/rootfs/usr/local/share/kata-containers/kata-containers.img; \
    debugfs -w -R 'write /tmp/patched-kata-agent/usr/bin/kata-agent /usr/bin/kata-agent' \
      /extension/rootfs/usr/local/share/kata-containers/kata-containers.img; \
    debugfs -w -R 'set_inode_field /usr/bin/kata-agent mode 0100755' \
      /extension/rootfs/usr/local/share/kata-containers/kata-containers.img; \
    debugfs -R 'stat /usr/sbin/e2fsck' \
      /extension/rootfs/usr/local/share/kata-containers/kata-containers.img \
      | grep -Fq 'Inode:'; \
    debugfs -R 'stat /usr/sbin/mkfs.ext4' \
      /extension/rootfs/usr/local/share/kata-containers/kata-containers.img \
      | grep -Fq 'Inode:'; \
    debugfs -R 'dump /usr/bin/kata-agent /tmp/installed-kata-agent' \
      /extension/rootfs/usr/local/share/kata-containers/kata-containers.img; \
    cmp /tmp/patched-kata-agent/usr/bin/kata-agent /tmp/installed-kata-agent; \
    e2fsck_status=0; \
    e2fsck -fy /extension/rootfs/usr/local/share/kata-containers/kata-containers.img \
      || e2fsck_status=$?; \
    test "${e2fsck_status}" -le 1; \
    install -m 0644 \
      /extension/rootfs/usr/local/share/kata-containers/kata-containers.img \
      /extension/rootfs/usr/local/share/kata-containers/kata-containers-qemu.img; \
    install -m 0644 \
      /tmp/kata/opt/kata/share/kata-containers/vmlinux-6.18.35-202 \
      /extension/rootfs/usr/local/share/kata-containers/vmlinux.container; \
    install -m 0644 \
      /tmp/kata/opt/kata/share/kata-containers/vmlinux-6.18.35-202-dragonball-experimental \
      /extension/rootfs/usr/local/share/kata-containers/vmlinux-dragonball-experimental.container; \
    install -m 0644 \
      /tmp/kata/opt/kata/share/defaults/kata-containers/runtime-rs/configuration-qemu-runtime-rs.toml \
      /extension/rootfs/usr/local/share/kata-containers/configuration-qemu-runtime-rs.toml; \
    install -m 0644 \
      /tmp/configuration-clh-runtime-rs.toml \
      /extension/rootfs/usr/local/share/kata-containers/configuration-clh-runtime-rs.toml; \
    install -m 0644 \
      /tmp/kata/opt/kata/share/defaults/kata-containers/runtime-rs/configuration-rs-fc.toml \
      /extension/rootfs/usr/local/share/kata-containers/configuration-rs-fc.toml; \
    install -m 0644 \
      /tmp/kata/opt/kata/share/defaults/kata-containers/runtime-rs/configuration-dragonball.toml \
      /extension/rootfs/usr/local/share/kata-containers/configuration-dragonball.toml; \
    sed -i 's#/opt/kata#/usr/local#g' \
      /extension/rootfs/usr/local/share/kata-containers/configuration-*.toml; \
    sed -i '/^image = /c\image = "/usr/local/share/kata-containers/kata-containers-qemu.img"' \
      /extension/rootfs/usr/local/share/kata-containers/configuration-qemu-runtime-rs.toml; \
    sed -i '/^firmware = /c\firmware = ""' \
      /extension/rootfs/usr/local/share/kata-containers/configuration-dragonball.toml; \
    sed -i \
      -e 's/^dial_timeout_ms = 10$/dial_timeout_ms = 100/' \
      -e 's/^reconnect_timeout_ms = 3000$/reconnect_timeout_ms = 45000/' \
      /extension/rootfs/usr/local/share/kata-containers/configuration-dragonball.toml; \
    sed -i \
      -e "s#^vm_rootfs_driver = .*#vm_rootfs_driver = \"${dragonball_block_driver}\"#" \
      -e "s#^block_device_driver = .*#block_device_driver = \"${dragonball_block_driver}\"#" \
      /extension/rootfs/usr/local/share/kata-containers/configuration-dragonball.toml; \
    awk ' \
      /^default_maxvcpus = 0$/ { \
        print "default_maxvcpus = 32"; \
        next; \
      } \
      /^dial_timeout_ms = 45000$/ { \
        print "dial_timeout_ms = 100"; \
        print "reconnect_timeout_ms = 45000"; \
        next; \
      } \
      { print } \
    ' /extension/rootfs/usr/local/share/kata-containers/configuration-rs-fc.toml \
      > /tmp/configuration-rs-fc.toml; \
    install -m 0644 /tmp/configuration-rs-fc.toml \
      /extension/rootfs/usr/local/share/kata-containers/configuration-rs-fc.toml; \
    truncate -s 512M \
      /extension/rootfs/usr/local/share/kata-containers/blockfile-scratch.ext4; \
    E2FSPROGS_FAKE_TIME=0 mkfs.ext4 -F -q -m 0 \
      -U 00000000-0000-0000-0000-000000000000 \
      -E lazy_itable_init=0,lazy_journal_init=0 \
      /extension/rootfs/usr/local/share/kata-containers/blockfile-scratch.ext4; \
    install -m 0644 /tmp/10-kata-firecracker.part \
      /extension/rootfs/etc/cri/conf.d/10-kata-runtimes.part; \
    test -x /extension/rootfs/usr/local/bin/containerd-shim-kata-v2; \
    test -x /extension/rootfs/usr/local/bin/cloud-hypervisor; \
    test -x "/extension/rootfs/usr/local/bin/${qemu_binary}"; \
    test -x /extension/rootfs/usr/local/bin/firecracker; \
    test -x /extension/rootfs/usr/local/bin/jailer; \
    test -x /extension/rootfs/usr/local/libexec/virtiofsd; \
    test -L /extension/rootfs/usr/local/bin/qemu-bundle/opt/kata/share/kata-qemu/qemu; \
    test -s /extension/rootfs/usr/local/share/kata-containers/vmlinux-dragonball-experimental.container; \
    grep -Fxq 'image = "/usr/local/share/kata-containers/kata-containers-qemu.img"' \
      /extension/rootfs/usr/local/share/kata-containers/configuration-qemu-runtime-rs.toml; \
    test "$(sha256sum /extension/rootfs/usr/local/share/kata-containers/kata-containers.img | cut -d ' ' -f 1)" = \
      "$(sha256sum /extension/rootfs/usr/local/share/kata-containers/kata-containers-qemu.img | cut -d ' ' -f 1)"; \
    test "$(stat -c '%i' /extension/rootfs/usr/local/share/kata-containers/kata-containers.img)" != \
      "$(stat -c '%i' /extension/rootfs/usr/local/share/kata-containers/kata-containers-qemu.img)"; \
    grep -Fxq 'default_maxvcpus = 32' \
      /extension/rootfs/usr/local/share/kata-containers/configuration-rs-fc.toml; \
    grep -Fxq 'dial_timeout_ms = 100' \
      /extension/rootfs/usr/local/share/kata-containers/configuration-rs-fc.toml; \
    grep -Fxq 'reconnect_timeout_ms = 45000' \
      /extension/rootfs/usr/local/share/kata-containers/configuration-rs-fc.toml; \
    test "$(grep -c '^firmware = ""$' \
      /extension/rootfs/usr/local/share/kata-containers/configuration-dragonball.toml)" -eq 1; \
    grep -Fxq 'dial_timeout_ms = 100' \
      /extension/rootfs/usr/local/share/kata-containers/configuration-dragonball.toml; \
    grep -Fxq 'reconnect_timeout_ms = 45000' \
      /extension/rootfs/usr/local/share/kata-containers/configuration-dragonball.toml; \
    grep -Fxq "vm_rootfs_driver = \"${dragonball_block_driver}\"" \
      /extension/rootfs/usr/local/share/kata-containers/configuration-dragonball.toml; \
    grep -Fxq "block_device_driver = \"${dragonball_block_driver}\"" \
      /extension/rootfs/usr/local/share/kata-containers/configuration-dragonball.toml; \
    if [ "${TARGETARCH}" = arm64 ]; then \
      test -s /extension/rootfs/usr/local/share/aavmf/AAVMF_CODE.fd; \
    fi; \
    for handler in kata-qemu kata-clh kata-fc kata-dragonball; do \
      grep -Fq "containerd.runtimes.${handler}]" /extension/rootfs/etc/cri/conf.d/10-kata-runtimes.part; \
    done; \
    test "$(grep -c '^  snapshotter = "blockfile"$' /extension/rootfs/etc/cri/conf.d/10-kata-runtimes.part)" -eq 1; \
    if grep -R '/opt/kata' /extension/rootfs/usr/local/share/kata-containers/configuration-*.toml; then \
      exit 1; \
    fi; \
    /usr/local/bin/extensions-validator validate --rootfs=/extension --pkg-name=kata-runtimes

FROM scratch

LABEL org.opencontainers.image.source="https://github.com/proompteng/lab"
LABEL org.opencontainers.image.description="Kata Containers 4.1.0 multi-VMM system extension for Talos 1.13"
LABEL org.opencontainers.image.version="4.1.0-talos-v1.13.9-r5"

COPY --from=payload /extension/manifest.yaml /manifest.yaml
COPY --from=payload /extension/rootfs /rootfs
