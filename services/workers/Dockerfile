FROM oven/bun:1.3.5

ARG NODE_VERSION=24.11.1
ARG NVM_VERSION=0.39.7

ENV DEBIAN_FRONTEND=noninteractive \
    NVM_DIR=/root/.nvm \
    BUN_INSTALL=/root/.bun \
    PATH=/root/.bun/bin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl git bash xz-utils; \
    rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/v${NVM_VERSION}/install.sh" | bash; \
    bash -lc "source ${NVM_DIR}/nvm.sh \
      && nvm install ${NODE_VERSION} \
      && nvm alias default ${NODE_VERSION} \
      && ln -sf \"$(command -v node)\" /usr/local/bin/node \
      && ln -sf \"$(command -v npm)\" /usr/local/bin/npm \
      && ln -sf \"$(command -v npx)\" /usr/local/bin/npx"; \
    bun add -g @openai/codex; \
    ln -sf /root/.bun/bin/bun /usr/local/bin/bun; \
    ln -sf /root/.bun/bin/codex /usr/local/bin/codex

WORKDIR /workspace
CMD ["bash"]
