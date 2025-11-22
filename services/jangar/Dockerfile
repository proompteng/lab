# Bun-based image for jangar Temporal worker
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

# Install jangar deps
WORKDIR /app/services/jangar
COPY services/jangar/package.json services/jangar/bun.lock ./
RUN bun install --production --frozen-lockfile

# Copy source
COPY services/jangar/tsconfig.json ./
COPY services/jangar/src ./src

ENV NODE_ENV=production
ENV PORT=8080

CMD ["bun", "run", "src/worker.ts"]
