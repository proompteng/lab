# Secure Action Gateway

SAG turns a natural-language request into an Agent Action Run: planned action steps, source calls, policy decisions, approval gates, and audit replay.

## Local Run

```sh
bun run --filter @proompteng/sag dev
```

## Checks

```sh
bun run --filter @proompteng/sag tsc
bun run --filter @proompteng/sag test
bun run --filter @proompteng/sag lint
bun run --filter @proompteng/sag lint:oxlint
bun run --filter @proompteng/sag build
```

## Product Flow

1. Open `/`.
2. Submit a request.
3. Review the Agent Action Run.
4. Approve a held action when policy requires it.
5. Open `Audit`.
6. Export the audit replay.
