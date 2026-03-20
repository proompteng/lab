# Symphony

Symphony is a Bun/TypeScript delivery runtime for the `Symphony` Linear project. It polls Linear, creates
per-issue workspaces, runs Codex app-server sessions against those workspaces using a repository-owned
`WORKFLOW.md`, and tracks the full GitHub Actions plus GitOps delivery transaction for each issue.

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

## Runtime scope

- Strict `WORKFLOW.md` loading with typed config/defaults and last-known-good reload behavior
- Linear polling, issue normalization, dispatch rules, retry scheduling, and durable scheduler state under `${workspace.root}/_symphony/`
- Per-issue workspace creation, hook execution, terminal cleanup, and recovery from restarts or leadership changes
- Lease-based leader election for single-cluster scheduler ownership
- Codex app-server execution with first-class runtime tools for `linear_graphql` and GitHub delivery operations
- Delivery transaction tracking for code PRs, required checks, merges to `main`, build workflow runs, promotion PRs, Argo rollout state, post-deploy verification, and rollback PRs
- HTTP dashboard and JSON APIs for runtime state, issue drilldowns, delivery state, capacity, leader status, recent events, and recent errors

## Delivery guarantees

- Symphony does not mutate the cluster directly. Delivery stays on GitHub Actions plus GitOps.
- Terminal delivery states clear stale runtime payloads so completed or rolled-back issues no longer appear as actively running.
- Successful terminal delivery states clear obsolete `delivery.lastError` values instead of preserving transient refresh failures.
- Pre-dispatch target health is tolerant of short-lived transient failures and candidate fetch uses bounded retry with backoff/jitter before dispatch pauses.

## Observability surface

- `GET /livez`: liveness probe
- `GET /readyz`: readiness probe
- `GET /`: HTML dashboard
- `GET /api/v1/state`: full runtime snapshot
- `POST /api/v1/refresh`: force a poll/reconcile cycle
- `GET /api/v1/:issueIdentifier`: per-issue details including tracked state, runtime session info, retry info, run history, and delivery transaction state

## Operational docs

- [Safety model](/Users/gregkonush/.codex/worktrees/88a8/lab/docs/symphony/safety-model.md)
- [Workflow authoring guide](/Users/gregkonush/.codex/worktrees/88a8/lab/docs/symphony/workflow-authoring.md)
