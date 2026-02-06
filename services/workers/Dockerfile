FROM oven/bun:1.3.5

ARG NODE_VERSION=24.11.1
ARG NVM_VERSION=0.39.7
ARG CODEX_VERSION=latest

ENV DEBIAN_FRONTEND=noninteractive \
    NVM_DIR=/root/.nvm \
    BUN_INSTALL=/root/.bun \
    PATH=/root/.bun/bin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl git bash xz-utils; \
    rm -rf /var/lib/apt/lists/*

SHELL ["/bin/bash", "-c"]

RUN set -euxo pipefail; \
    curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/v${NVM_VERSION}/install.sh" | PROFILE=/dev/null bash; \
    printf '%s\n' \
      'export NVM_DIR="$([ -z "${XDG_CONFIG_HOME-}" ] && printf %s "${HOME}/.nvm" || printf %s "${XDG_CONFIG_HOME}/nvm")"' \
      '[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"' \
      '[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"' \
      > /etc/profile.d/nvm.sh; \
    set +u; \
    . "${NVM_DIR}/nvm.sh"; \
    set -u; \
    nvm install "${NODE_VERSION}"; \
    nvm alias default "${NODE_VERSION}"; \
    nvm use default; \
    ln -sf "/root/.nvm/versions/node/v${NODE_VERSION}/bin/node" /usr/local/bin/node; \
    ln -sf "/root/.nvm/versions/node/v${NODE_VERSION}/bin/npm" /usr/local/bin/npm; \
    ln -sf "/root/.nvm/versions/node/v${NODE_VERSION}/bin/npx" /usr/local/bin/npx; \
    bun add -g "@openai/codex@${CODEX_VERSION}"

WORKDIR /workspace
CMD ["bash"]
