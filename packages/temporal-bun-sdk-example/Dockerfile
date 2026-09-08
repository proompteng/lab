# syntax=docker/dockerfile:1.6

FROM oven/bun:1.4.0
WORKDIR /app

COPY package.json bunfig.toml tsconfig.json ./
RUN bun install --production

COPY src ./src

CMD ["bun", "run", "src/worker.ts"]
