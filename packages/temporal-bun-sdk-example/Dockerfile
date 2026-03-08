# syntax=docker/dockerfile:1.6

FROM oven/bun:1.3.10
WORKDIR /app

COPY package.json bunfig.toml tsconfig.json ./
RUN bun install --production

COPY src ./src

CMD ["bun", "run", "src/worker.ts"]
