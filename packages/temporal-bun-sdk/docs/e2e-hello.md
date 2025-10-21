# Temporal Bun SDK Hello E2E

## Prerequisites

- Docker Desktop or Docker Engine running locally
- Bun 1.1+
- Zig 0.12+

## Build the Zig bridge

```
cd packages/temporal-bun-sdk
zig build -Doptimize=ReleaseFast --build-file native/temporal-bun-bridge-zig/build.zig
```

## Start Temporal locally

```
bun run hello:up
```

## Run the end-to-end sample

```
bun run examples/hello/run.ts --name Grisha
```

The script prints the workflow runId followed by the greeting.

## Shut everything down

```
bun run hello:down
```
