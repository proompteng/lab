# Secure Action Gateway

Secure Action Gateway protects internal AgentRuns before sensitive runtime authority is attached. It evaluates requested secrets, connectors, and tools, applies deterministic rules, records approval decisions, and exports a redacted audit trail.

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

## Live Workflow

1. Open `/`.
2. Click `Evaluate AgentRun`.
3. Review the event log and selected AgentRun manifest.
4. Create a rule in `/rules`.
5. Evaluate a mutating AgentRun action through `/api/agents/runs`.
6. Approve or deny from `/approvals`.
7. Export `/api/events/export`.
