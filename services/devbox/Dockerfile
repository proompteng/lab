# syntax=mirror.gcr.io/docker/dockerfile:1.7
FROM mirror.gcr.io/golang:1.25.5-alpine AS registry-client
RUN GOBIN=/out CGO_ENABLED=0 go install github.com/google/go-containerregistry/cmd/crane@v0.20.6

FROM mirror.gcr.io/ubuntu:24.04 AS rootfs
SHELL ["/bin/bash", "-euxo", "pipefail", "-c"]
ARG CODEX_VERSION=0.153.4
ARG RUST_VERSION=1.90.0
ENV DEBIAN_FRONTEND=noninteractive container=kata
RUN apt-get update && apt-get install --yes --no-install-recommends \
    systemd systemd-sysv dbus-user-session openssh-server sudo locales \
    ca-certificates curl git git-lfs jq rsync xz-utils unzip bzip2 \
    build-essential pkg-config libssl-dev protobuf-compiler python3-venv \
    bubblewrap iproute2 iptables iputils-ping dnsutils util-linux \
    docker.io docker-buildx docker-compose-v2 nix-bin nix-setup-systemd && \
    rm -rf /var/lib/apt/lists/* && \
    if id ubuntu >/dev/null 2>&1; then userdel -r ubuntu; fi && \
    groupadd --gid 1000 codex && \
    useradd --uid 1000 --gid 1000 --groups sudo,docker --create-home --shell /bin/bash codex && \
    printf 'codex ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/codex && \
    chmod 0440 /etc/sudoers.d/codex && \
    locale-gen en_US.UTF-8
COPY flake.nix flake.lock /opt/lab-toolchain/
COPY nix /opt/lab-toolchain/nix
RUN mkdir -p /etc/nix /opt/devbox && \
    printf 'experimental-features = nix-command flakes\nsandbox = false\ntrusted-users = root codex\n' > /etc/nix/nix.conf && \
    NIX_REMOTE=local nix build --no-link --print-out-paths /opt/lab-toolchain#ciToolchain > /opt/devbox/toolchain-path && \
    ln -s "$(cat /opt/devbox/toolchain-path)" /opt/devbox/toolchain
ENV PATH=/opt/devbox/toolchain/bin:/opt/devbox/npm/bin:/opt/devbox/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ENV RUSTUP_HOME=/opt/devbox/rustup CARGO_HOME=/opt/devbox/cargo
RUN npm install --global --prefix /opt/devbox/npm "@openai/codex@${CODEX_VERSION}" && \
    case "$(dpkg --print-architecture)" in amd64) rust_arch=x86_64 ;; arm64) rust_arch=aarch64 ;; *) exit 1 ;; esac && \
    curl --fail --location --retry 3 "https://static.rust-lang.org/rustup/archive/1.28.2/${rust_arch}-unknown-linux-gnu/rustup-init" -o /tmp/rustup-init && \
    curl --fail --location --retry 3 "https://static.rust-lang.org/rustup/archive/1.28.2/${rust_arch}-unknown-linux-gnu/rustup-init.sha256" -o /tmp/rustup-init.sha256 && \
    cd /tmp && sha256sum --check rustup-init.sha256 && chmod +x rustup-init && \
    ./rustup-init -y --no-modify-path --profile minimal --default-toolchain "${RUST_VERSION}" --component rustfmt,clippy && \
    rm /tmp/rustup-init /tmp/rustup-init.sha256
COPY . /opt/lab-seed
COPY --chmod=0755 services/devbox/install-deps.sh /usr/local/bin/devbox-install-deps
WORKDIR /opt/lab-seed
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/devbox/playwright
ARG SOURCE_REVISION
RUN devbox-install-deps && \
    bunx --no-install playwright install --with-deps chromium && \
    test -n "${SOURCE_REVISION}" && \
    printf '%s\n' "${SOURCE_REVISION}" > /opt/devbox/source-revision && \
    NIX_REMOTE=local nix develop /opt/lab-toolchain --command toolchain-doctor && \
    NIX_REMOTE=local nix-store --dump-db > /opt/devbox/nix-registration && \
    rm -rf /root/.bun/install/cache /root/.npm /var/lib/apt/lists/*
COPY services/devbox/prepare.sh /usr/local/sbin/devbox-prepare
COPY services/devbox/verify.sh /usr/local/bin/devbox-verify
COPY services/devbox/profile.sh /etc/profile.d/devbox.sh
COPY services/devbox/devbox-prepare.service /etc/systemd/system/devbox-prepare.service
RUN chmod 0755 /usr/local/sbin/devbox-prepare /usr/local/bin/devbox-verify && \
    sed -e '/^export /!d' -e 's/^export //' -e 's|\$HOME|/home/codex|g' /etc/profile.d/devbox.sh > /etc/environment && \
    mkdir -p /etc/ssh/sshd_config.d /etc/systemd/system/nix-daemon.service.d /var/lib/systemd/linger && \
    printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\nAllowUsers codex\n' > /etc/ssh/sshd_config.d/devbox.conf && \
    printf '[Service]\nExecStart=\nExecStart=/opt/devbox/toolchain/bin/nix-daemon --daemon\n' > /etc/systemd/system/nix-daemon.service.d/devbox.conf && \
    touch /var/lib/systemd/linger/codex && \
    systemctl enable ssh docker nix-daemon.socket devbox-prepare && \
    systemctl mask systemd-resolved.service systemd-networkd.service systemd-networkd-wait-online.service && \
    rm -f /etc/ssh/ssh_host_* /etc/machine-id && touch /etc/machine-id
ENV CARGO_HOME=/home/codex/.cargo HOME=/home/codex
CMD ["/sbin/init"]

FROM mirror.gcr.io/alpine:3.22 AS launcher
RUN apk add --no-cache bash ca-certificates coreutils util-linux rsync tar
COPY --from=registry-client /out/crane /usr/local/bin/crane
COPY services/devbox/boot.sh /usr/local/bin/devbox-boot
COPY services/devbox/exec.sh /usr/local/bin/devbox-exec
COPY services/devbox/prune-roots.sh /usr/local/bin/devbox-prune-roots
RUN chmod 0755 /usr/local/bin/devbox-boot /usr/local/bin/devbox-exec /usr/local/bin/devbox-prune-roots
STOPSIGNAL 37
ENTRYPOINT ["/usr/local/bin/devbox-boot"]
