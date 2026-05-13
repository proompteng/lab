# Secure Action Gateway Submission Evidence

Date: 2026-05-13
Owner: Greg Konush

## Working Product

- Live URL: https://sag.proompteng.ai
- Kubernetes namespace: `sag`
- Deployed image: `registry.ide-newton.ts.net/lab/sag:sag-20260513010817`
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

The product protects Kubernetes `AgentRun` workloads before they receive sensitive runtime authority.

1. Open https://sag.proompteng.ai.
2. Click `Evaluate AgentRun`.
3. SAG reads live `AgentRun` resources from the `agents` namespace.
4. If the AgentRun requests sensitive secret material, SAG blocks it and records a redacted audit event.
5. Add a natural-language rule in `Rules`, for example:

```text
Require approval before AgentRuns apply or mutate Kubernetes resources
```

6. Evaluate a mutating AgentRun action.
7. SAG holds the action for approval, denies a non-approver, approves with the security operator, and writes every decision to the event log.
8. Export `/api/events/export` to inspect the JSONL audit trail.

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
curl -fsS -X POST https://sag.proompteng.ai/api/workspace/clear \
  -H 'content-type: application/json' \
  --data '{}'

curl -fsS -X POST https://sag.proompteng.ai/api/agents/runs \
  -H 'content-type: application/json' \
  --data '{"actorId":"greg"}'

curl -fsS -X POST https://sag.proompteng.ai/api/rules \
  -H 'content-type: application/json' \
  --data '{"actorId":"greg","text":"Require approval before AgentRuns apply or mutate Kubernetes resources"}'

curl -fsS https://sag.proompteng.ai/api/events/export
```

Verified live result on 2026-05-13:

- Live AgentRun `torghut-quant-discover-sched-qlth5` was blocked.
- Secret references were stored as `secret:<hash>` values.
- Raw sensitive secret names were absent from the manifest, API response, JSONL export, and root HTML.
- A mutating AgentRun action entered `approval_required`.
- `ops` was denied approval because it lacks `approval:approve`.
- `greg` approved the action.
- The live root page showed `AgentRuns`, `Events`, `5 events`, and `1 blocked`.

## Deliverable Map

| Requirement                              | Evidence                                                 |
| ---------------------------------------- | -------------------------------------------------------- |
| Working product URL or runnable artifact | `https://sag.proompteng.ai`; `services/sag`              |
| Source code                              | `services/sag`, `argocd/sag`, `packages/scripts/src/sag` |
| PRD, 1-2 pages                           | `docs/secure-action-gateway/prd-submission.md`           |
| TDD, 1-2 pages                           | `docs/secure-action-gateway/tdd-submission.md`           |
| 2-5 minute walkthrough                   | Record the workflow above against the live URL           |
| Authorship/build note                    | See below                                                |

## Authorship / Build Note

Personally built:

- TanStack Start service in `services/sag`.
- Minimal event-log UI using Tailwind and Base UI primitives.
- CNPG-backed state persistence.
- Kubernetes service account integration for reading live AgentRuns in the `agents` namespace.
- Policy evaluation for requested secrets, requested connectors, and mutating tools.
- Natural-language rule builder that translates operator text into enforced rules.
- Approval flow with RBAC checks.
- Redacted JSONL audit export.
- Docker image build, Kubernetes manifests, CNPG cluster, service account, RBAC, Traefik ingress, and deploy script.

Reused:

- Existing repository Bun/TanStack/Kubernetes conventions.
- Existing image registry and typed deploy script patterns under `packages/scripts`.
- Base UI primitives and Tailwind for product UI.

What broke and how it was debugged:

- The first product surface mixed a request form with the event log. Live browser inspection made the confusion obvious, so the root page was reduced to events plus AgentRuns.
- The first loader pulled Postgres code into the browser bundle. Build output showed browser externalization warnings, so the loader was moved to a TanStack Start server function.
- Stale generated routes kept deleted request endpoints alive. A production build regenerated `routeTree.gen.ts` and removed those paths.
- Earlier persisted connector fixture tables were removed from CNPG and the state was cleared before final live verification.
