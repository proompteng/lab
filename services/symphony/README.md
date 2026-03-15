# Symphony

Symphony is a Bun/TypeScript service that polls Linear, creates per-issue workspaces, and runs Codex app-server sessions against those workspaces using a repository-owned `WORKFLOW.md`.

## Run

```bash
bun run --cwd services/symphony start
```

Optional:

```bash
bun run --cwd services/symphony start ./path/to/WORKFLOW.md --port 8080
```

Cluster example:

```bash
bun run --cwd services/symphony start ./path/to/WORKFLOW.md --host 0.0.0.0 --port 8080
```

## Validate

```bash
bun run --cwd services/symphony tsc
bun run --cwd services/symphony test
bun run --cwd services/symphony lint
bun run --cwd services/symphony lint:oxlint
bun run --cwd services/symphony lint:oxlint:type
```

## Current scope

- Strict `WORKFLOW.md` loading with typed config/defaults and last-known-good reload behavior
- Linear polling and issue normalization
- Per-issue workspace creation, hook execution, and terminal cleanup
- Durable scheduler metadata under `${workspace.root}/_symphony/` for retry/session recovery across restarts
- Lease-based leader election for single-cluster scheduler ownership
- Codex app-server session runner with dynamic `linear_graphql` tool support
- Expanded HTTP dashboard and JSON status API with policy, leader, capacity, recent events, and issue drilldowns

## Operational docs

- [Safety model](/Users/gregkonush/.codex/worktrees/88a8/lab/docs/symphony/safety-model.md)
- [Workflow authoring guide](/Users/gregkonush/.codex/worktrees/88a8/lab/docs/symphony/workflow-authoring.md)
