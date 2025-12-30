ARG BUN_VERSION=1.3.5

FROM node:lts-alpine AS deps
ARG BUN_VERSION

WORKDIR /app
ENV BUN_INSTALL="/root/.bun"
ENV PATH="$BUN_INSTALL/bin:$PATH"

RUN apk add --no-cache bash curl
RUN curl -fsSL https://bun.sh/install | bash -s -- bun-v${BUN_VERSION}

COPY package.json bun.lock .npmrc* ./
COPY scripts/run-husky-install.mjs ./scripts/run-husky-install.mjs
COPY apps ./apps
COPY packages ./packages
COPY services ./services
ENV HUSKY=0
RUN bun install --frozen-lockfile --ignore-scripts

FROM deps AS builder
WORKDIR /app
COPY . .
RUN bun run build:reviseur

FROM node:lts-alpine AS runner
WORKDIR /app

COPY --from=builder /app/apps/reviseur/.mastra/output ./apps/reviseur

WORKDIR /app/apps/reviseur
CMD ["node", "index.mjs"]
