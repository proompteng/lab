---
name: lab-quality-checks
description: Run required formatting and tests for TS/Go changes.
---

## Install & Setup
- Install dependencies with `bun install`.
- For Go services, run `go mod tidy` inside each service when modules change.

## Required Checks
- TypeScript/JavaScript changes: run `bunx biome check <paths>` and fix all diagnostics.
- Go changes: run `go test ./...` and `go build ./...` (or narrow with `-run`).
- UI apps: use `bun run lint:<app>`; for smoke tests use `bun run build:<app>` then `bun run start:<app>`.

## Constraints
- Never edit lockfiles by hand; regenerate with the package manager.
