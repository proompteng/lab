ARG BUN_VERSION=1.3.14

FROM node:lts-alpine AS deps
ARG BUN_VERSION
ENV BUN_INSTALL="/root/.bun"
ENV PATH="$BUN_INSTALL/bin:$PATH"
WORKDIR /app
RUN apk add --no-cache bash curl
RUN curl -fsSL https://bun.sh/install | bash -s -- bun-v${BUN_VERSION}

COPY package.json bun.lock .npmrc* tsconfig.base.json ./
COPY --parents apps/*/package.json ./
COPY --parents packages/*/package.json ./
COPY --parents services/*/package.json ./
# Root workspaces include nested service package manifests, so keep the reduced install graph complete.
COPY --parents services/agents/*/package.json ./
COPY --parents services/jangar/*/package.json ./
RUN bun install --frozen-lockfile --ignore-scripts

FROM deps AS builder
WORKDIR /app
COPY . .
RUN bun install --filter app --frozen-lockfile
RUN bun run build:app

FROM node:lts-alpine AS runner
WORKDIR /app/apps/app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

RUN addgroup --system --gid 1001 nodejs && \
  adduser --system --uid 1001 nextjs

COPY --from=builder --chown=nextjs:nodejs /app/apps/app/.output /app/apps/app/.output
COPY --from=builder --chown=nextjs:nodejs /app/apps/app/public /app/apps/app/public
COPY --from=builder --chown=nextjs:nodejs /app/node_modules /app/node_modules
COPY --from=builder --chown=nextjs:nodejs /app/apps/app/node_modules /app/apps/app/node_modules

RUN test -f /app/apps/app/node_modules/react/package.json

USER nextjs

EXPOSE 3000

CMD ["node", ".output/server/index.mjs"]
