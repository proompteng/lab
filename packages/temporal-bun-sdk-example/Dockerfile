# syntax=docker/dockerfile:1.6

FROM oven/bun:1.1.20
WORKDIR /app

COPY package.json bun.lock tsconfig.base.json ./
COPY packages/temporal-bun-sdk ./packages/temporal-bun-sdk
COPY packages/temporal-bun-sdk-example ./packages/temporal-bun-sdk-example

RUN bun install --ignore-scripts
RUN bun --cwd packages/temporal-bun-sdk run build

WORKDIR /app/packages/temporal-bun-sdk-example
CMD ["bun", "run", "src/worker.ts"]
