# Bun + Node image for jangar worker + UI + Codex app-server
ARG NODE_VERSION=24.11.1
ARG BUN_VERSION=1.3.3

FROM node:${NODE_VERSION}-bookworm AS base
ENV BUN_INSTALL=/root/.bun
ENV PATH="$BUN_INSTALL/bin:$PATH"
WORKDIR /app

# Install Bun alongside Node
RUN curl -fsSL https://bun.sh/install | bash -s -- bun-v${BUN_VERSION}

# Base tsconfig for workspace packages
COPY tsconfig.base.json ./

ENV NODE_ENV=production

# Build codex dependency (file: workspace)
COPY packages/codex ./packages/codex
RUN cd packages/codex \
  && bun add -d typescript@5.9.3 \
  && bun install --frozen-lockfile \
  && bun run build

# Install jangar deps (with dev deps for UI build)
WORKDIR /app/services/jangar
COPY services/jangar/package.json ./
COPY services/jangar/tsconfig.json ./
COPY services/jangar/src ./src
COPY bun.lock ../bun.lock
RUN bun install --frozen-lockfile

# Build TanStack Start UI
RUN bun run start:build

# Prune to production deps (retain codex file dep)
RUN rm -rf node_modules \
  && bun install --frozen-lockfile --production \
  && mkdir -p node_modules/@proompteng \
  && ln -sf ../../packages/codex node_modules/@proompteng/codex

# Install Codex CLI so the app-server binary is available at runtime
RUN npm install -g @openai/codex@latest

ENV NODE_ENV=production
ENV PORT=3000
ENV WORKER_PORT=8070

CMD ["bun", "run", "src/index.ts"]
