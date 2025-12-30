# syntax=docker/dockerfile:1.6

FROM oven/bun:1.1.20 AS install
WORKDIR /app

# Install system dependencies required for Zig and Temporal core libraries
RUN apt-get update && apt-get install -y \
    xz-utils \
    curl \
    ca-certificates \
    tar \
    git \
    build-essential \
    pkg-config \
    protobuf-compiler \
    libprotobuf-dev \
    && rm -rf /var/lib/apt/lists/*

# Install Zig 0.15.1
RUN curl -L https://ziglang.org/download/0.15.1/zig-x86_64-linux-0.15.1.tar.xz | tar -xJ -C /usr/local --strip-components=1

# No Rust toolchain required — the build consumes pre-built static libraries

COPY packages/temporal-bun-sdk/package.json package.json
COPY packages/temporal-bun-sdk/bunfig.toml bunfig.toml
COPY packages/temporal-bun-sdk/tsconfig.json tsconfig.json
COPY packages/temporal-bun-sdk/tsconfig.paths.json tsconfig.paths.json
COPY packages/temporal-bun-sdk/src src
COPY packages/temporal-bun-sdk/tests tests
COPY packages/temporal-bun-sdk/scripts scripts
COPY packages/temporal-bun-sdk/native native

RUN bun install

# Download pre-built libraries (required)
# This replaces the previous lengthy Rust compilation process
RUN bun run libs:download

# Build TypeScript and native Zig components using pre-built libraries
RUN bun run build
RUN bun run build:native:zig:bundle

FROM oven/bun:1.1.20 AS runner
WORKDIR /app
ENV NODE_ENV=production

# Install minimal runtime dependencies
RUN apt-get update && apt-get install -y \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY packages/temporal-bun-sdk/package.json package.json
COPY packages/temporal-bun-sdk/bunfig.toml bunfig.toml
RUN bun install --production

COPY --from=install /app/dist dist
COPY --from=install /app/dist/native dist/native

# Add health check for the worker
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD bun --version || exit 1

CMD ["bun", "run", "start:worker"]
