ARG BUN_VERSION=1.3.5

FROM oven/bun:${BUN_VERSION}-alpine AS builder

WORKDIR /repo

# Build tooling for native modules (node-gyp)
RUN apk add --no-cache python3 make g++

# Copy monorepo manifests and scripts so workspace installs can run
COPY package.json bun.lock .npmrc* ./
COPY scripts/run-husky-install.mjs ./scripts/run-husky-install.mjs
COPY --parents apps/*/package.json ./
COPY --parents packages/*/package.json ./
COPY --parents services/*/package.json ./

# Copy the kitty-krew workspace source
COPY apps/kitty-krew ./apps/kitty-krew
COPY packages ./packages

# Install dependencies for the kitty-krew workspace using the root Bun lockfile
ENV HUSKY=0
RUN bun install --frozen-lockfile --ignore-scripts

# Build the application
RUN bun run --filter ./apps/kitty-krew build

# Production image
FROM oven/bun:${BUN_VERSION}-alpine

WORKDIR /app/apps/kitty-krew

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3000
ENV LOG_LEVEL=info

# Copy dependencies and built output
COPY --from=builder /repo/node_modules /app/node_modules
COPY --from=builder /repo/apps/kitty-krew /app/apps/kitty-krew

# Create logs directory and set permissions
RUN mkdir -p logs && chmod 755 logs

# Expose port
EXPOSE 3000

# Run the application
CMD ["bun", "run", "start"]
