# Bun-based image for jangar Temporal worker
FROM oven/bun:1.2.23 AS base
WORKDIR /app

# Install dependencies
COPY services/jangar/package.json services/jangar/bun.lock ./
RUN bun install --frozen-lockfile

# Copy source
COPY services/jangar/tsconfig.json ./
COPY services/jangar/src ./src

ENV NODE_ENV=production
ENV PORT=8080

CMD ["bun", "run", "src/worker.ts"]
