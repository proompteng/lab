# Secure Action Gateway Submission Evidence

Date: 2026-05-13
Owner: Greg Konush

## Working Product

- Live URL: https://sag.proompteng.ai
- Kubernetes namespace: `sag`
- Deployed image: `registry.ide-newton.ts.net/lab/sag:sag-20260513095640`
- Database: CNPG cluster `sag-db` in namespace `sag`
- Source paths: `services/sag`, `argocd/sag`, `packages/scripts/src/sag`

Local run:

```sh
bun install
bun run --filter @proompteng/sag dev
```

Production build:

```sh
bun run --filter @proompteng/sag build
```

## Core Workflow

The product is a behind-the-firewall action gateway. Operators submit natural-language work requests; SAG turns the request into a plan, executes allowed read steps against internal systems, holds risky mutations for approval, and records every decision in an append-only audit log.

1. Open https://sag.proompteng.ai.
2. Submit an operational intent such as:

```text
Inspect live agent runs, read SQL policy state, query audit graph, and parse the legacy feed
```

3. SAG creates a task, expands it into plan steps, and executes real connector calls across SQL, REST, GraphQL, and a legacy feed.
4. Submit a higher-risk intent such as:

```text
Inspect AgentRuns and execute a guarded restart if policy allows it
```

5. SAG evaluates policy before execution, parks the mutation behind an approval, and records the pending decision.
6. Approve the pending action as an authorized operator.
7. Export `/api/events/export` to inspect the JSONL audit trail.

## Verification

Local gates:

```sh
bun run --filter @proompteng/sag tsc
bun run --filter @proompteng/sag test
bun run --filter @proompteng/sag lint
bun run --filter @proompteng/sag lint:oxlint
bun run --filter @proompteng/sag build
bun run lint:argocd
```

Cluster gates:

```sh
kubectl get deploy sag -n sag -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'
kubectl rollout status deployment/sag -n sag --timeout=180s
curl -fsS https://sag.proompteng.ai/api/health
```

End-to-end API check:

```sh
curl -fsS -X POST https://sag.proompteng.ai/api/tasks \
  -H 'content-type: application/json' \
  --data '{"text":"Inspect live agent runs, read SQL policy state, query audit graph, and parse the legacy feed"}'

curl -fsS -X POST https://sag.proompteng.ai/api/tasks \
  -H 'content-type: application/json' \
  --data '{"text":"Inspect AgentRuns and execute a guarded restart if policy allows it"}'

curl -fsS -X POST https://sag.proompteng.ai/api/rules \
  -H 'content-type: application/json' \
  --data '{"text":"Require approval before agents update production databases"}'

curl -fsS https://sag.proompteng.ai/api/events/export
```

Verified live result on 2026-05-13:

- Read task `task-00066` succeeded and recorded SQL, REST, GraphQL, and legacy connector calls.
- Guarded mutation task `task-00081` entered `waiting_approval` before executing `guarded_action.execute`.
- Approval `appr-00097` moved to `approved` and task `task-00081` completed with decision `approved`.
- Natural-language rule `rule-00062` was created by translator `codex-app-server`.
- JSONL export contained task, plan, connector, policy, approval, and audit events without raw secret values.
- CNPG row counts after smoke: `tasks=5`, `calls=20`, `events=39`, `approvals=2`, `rules=5`.

## Deliverable Map

| Requirement                              | Evidence                                                                                                  |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Working product URL or runnable artifact | `https://sag.proompteng.ai`; `services/sag`                                                               |
| Source code                              | `services/sag`, `argocd/sag`, `packages/scripts/src/sag`; PRs `#6452`, `#6453`, `#6454`, `#6455`, `#6456` |
| PRD, 1-2 pages                           | `docs/secure-action-gateway/prd-submission.md`                                                            |
| TDD, 1-2 pages                           | `docs/secure-action-gateway/tdd-submission.md`                                                            |
| 2-5 minute walkthrough                   | `docs/secure-action-gateway/panel-presentation.md`                                                        |
| Authorship/build note                    | See below                                                                                                 |

## Authorship / Build Note

Personally built:

- TanStack Start service in `services/sag`.
- Minimal event-log UI using Tailwind and Base UI primitives.
- CNPG-backed tables for identities, connectors, policies, tasks, plan steps, connector calls, approvals, AgentRuns, rule messages, and audit events.
- Natural-language task intake that produces multi-step plans and executes real connector calls.
- SQL, REST, GraphQL, legacy-feed, Kubernetes, policy, and audit connector surfaces.
- Kubernetes service account integration for reading live AgentRuns in the `agents` namespace.
- Policy evaluation for requested secrets, requested connectors, mutating operations, and approval-gated actions.
- Natural-language rule builder wired through the Codex app server with deterministic fallback.
- Approval flow with server-side actor resolution and RBAC checks.
- Redacted JSONL audit export.
- Docker image build, Kubernetes manifests, CNPG cluster, service account, RBAC, Traefik ingress, sealed Codex auth, and deploy script.

Reused:

- Existing repository Bun/TanStack/Kubernetes conventions.
- Existing image registry and typed deploy script patterns under `packages/scripts`.
- Base UI primitives and Tailwind for product UI.

What broke and how it was debugged:

- The first product surface looked like a mock dashboard. It was reduced to one operator workflow: task intake, current task state, policy decision, and audit evidence.
- The first loader pulled Postgres code into the browser bundle. Build output showed browser externalization warnings, so the loader was moved to a TanStack Start server function.
- The first persistence version wrote normalized state beside legacy JSON. Live logs exposed undefined values from older persisted rows, so state normalization and JSON parameter sanitization were added before rollout.
- Argo reverted direct cluster applies until the image tag was committed and merged through GitOps, so rollout evidence now tracks both the direct deploy and the GitOps image promotion.
- The Codex CLI was initially installed without Node or a native CA bundle available in the runtime image. The runner now carries Node 24, native CA certificates, and points `SAG_CODEX_BINARY` at the installed Codex executable.
