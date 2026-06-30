# syntax=docker/dockerfile:1.7

ARG ACTIONS_RUNNER_BASE=ghcr.io/actions/actions-runner@sha256:08c30b0a7105f64bddfc485d2487a22aa03932a791402393352fdf674bda2c29
FROM ${ACTIONS_RUNNER_BASE}

ARG DEBIAN_FRONTEND=noninteractive
ARG LAB_GIT_SHA=unknown
ARG NIX_INSTALL_URL=https://releases.nixos.org/nix/nix-2.28.5/install

LABEL org.opencontainers.image.title="lab-arc-runner"
LABEL org.opencontainers.image.description="GitHub Actions ARC runner with the Lab Nix CI toolchain preinstalled"
LABEL org.opencontainers.image.source="https://github.com/proompteng/lab"
LABEL org.opencontainers.image.revision="${LAB_GIT_SHA}"

USER root
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git jq xz-utils \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -m 0755 /nix \
  && chown runner:runner /nix

USER runner
ENV USER=runner
ENV NIX_CONFIG="experimental-features = nix-command flakes"
ENV PATH="/home/runner/.nix-profile/bin:/nix/var/nix/profiles/default/bin:${PATH}"

WORKDIR /tmp/lab-nix-toolchain
COPY --chown=runner:runner flake.nix flake.lock ./
COPY --chown=runner:runner nix ./nix

RUN curl --proto '=https' --tlsv1.2 -fsSL "${NIX_INSTALL_URL}" -o /tmp/install-nix.sh \
  && sh /tmp/install-nix.sh --no-daemon --yes --no-channel-add --no-modify-profile \
  && rm /tmp/install-nix.sh \
  && nix profile install .#ciToolchain --priority 4 \
  && toolchain-doctor \
  && oci-doctor \
  && nix store gc

WORKDIR /home/runner
