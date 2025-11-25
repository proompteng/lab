# Bun-based image for jangar worker + UI
FROM oven/bun:1.3.3 AS base
WORKDIR /app

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

ENV NODE_ENV=production
ENV PORT=8080
ENV WORKER_PORT=8070

CMD ["bun", "run", "src/index.ts"]
