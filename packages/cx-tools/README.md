# cx-tools

Operational wrappers for control-plane agents:

- `cx-codex-run` — thin wrapper around `codex exec` that enforces JSON event output.
- `cx-workflow-*` — wrappers around `temporal workflow` operations (`start`, `cancel`, `query`, `signal`).

## Installed Binaries

See `package.json` `bin` entries for the command names:

- `cx-codex-run`
- `cx-workflow-start`
- `cx-workflow-cancel`
- `cx-workflow-query`
- `cx-workflow-signal`

## Runtime defaults

- Command wrappers inject `--namespace` from `TEMPORAL_NAMESPACE` / `TEMPORAL_NAMESPACE_ID` when missing.
- Command wrappers inject `--address` from `TEMPORAL_ADDRESS` when missing.
- `cx-workflow-start` also injects `--task-queue` from `TEMPORAL_TASK_QUEUE` when missing.

## Build

Artifacts are expected to build into `dist/` for runtime packaging:

```bash
bun run build
```

## Local validation

```bash
bun run lint:oxlint
bun run lint:oxlint:type
bunx tsc --noEmit -p tsconfig.json
```
