# nata

Lightweight TypeScript HTTP service built with Hono and `@hono/node-server`.

## Current behavior

`src/server.ts` currently serves:

- `GET /` -> `Nata!`
- `GET /health/liveness` -> `OK`
- `GET /health/readiness` -> `OK`

The service also logs incoming requests and returns a generic `500` response through the shared error handler.

## Local development

From the repo root:

```bash
bun run --filter nata dev
bun run --filter nata start
```

Or from `apps/nata`:

```bash
bun run dev
bun run start
```

`PORT` defaults to `8080`.

## Scripts

```bash
bun run dev
bun run start
bun run lint:oxlint
bun run lint:oxlint:type
```

## Function metadata

`func.yaml` keeps the Knative Functions metadata for this service:

- runtime: `typescript`
- builder: S2I
- builder image: `registry.ide-newton.ts.net/lab/base`
- namespace: `froussard`

## Notes

- This workspace does not currently define dedicated build or test scripts.
- If you expand the service beyond the current health and hello endpoints, update this README alongside `src/server.ts`.
