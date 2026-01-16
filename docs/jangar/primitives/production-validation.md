# Jangar Primitives Production Validation

Use this checklist to validate end-to-end Jangar primitives in production. The goal is to confirm
Crossplane package health, Jangar control-plane persistence, memory writes, and orchestration
execution across all step types.

## Prereqs

- `kubectl` with cluster context set (k3s `default`).
- `kubectl cnpg` plugin installed.
- `python3` or `python` available (used by validation script).
- Access to `jangar` and `facteur` namespaces.

## 1) Crossplane package health (optional)

```bash
kubectl get configurations.pkg.crossplane.io
kubectl get functions.pkg.crossplane.io
```

Expect `function-map-to-list` to show `Installed=True` and `Healthy=True`. The deprecated
`configuration-agents` package should not be installed once native Agents CRDs are in use.

## 2) Control-plane schema and API

Verify tables in `jangar-db`:

```bash
kubectl cnpg psql -n jangar jangar-db -- -d jangar -c \
  "select to_regclass('public.agent_runs'), to_regclass('public.orchestration_runs'), to_regclass('public.memory_resources'), to_regclass('public.audit_events');"
```

Confirm endpoints are live:

```bash
curl -fsS -X POST https://jangar/v1/agents \
  -H 'Idempotency-Key: demo-agent-1' \
  -H 'content-type: application/json' \
  -d '{"name":"demo-agent","namespace":"jangar","spec":{}}'

curl -fsS https://jangar/v1/agents/demo-agent?namespace=jangar
```

Repeat for `/v1/agent-runs`, `/v1/memories`, `/v1/orchestrations`, `/v1/orchestration-runs`, and `/v1/runs/{id}`.

## 3) MemoryOp + Checkpoint writes

Check for non-zero rows in the memory provider (`facteur-vector-cluster`):

```bash
kubectl cnpg psql -n facteur facteur-vector-cluster -- -d facteur_kb -c \
  "select count(*) from jangar_primitives.memory_events;"
```

The counts in `memory_events`, `memory_kv`, and `memory_embeddings` should be > 0 after runs.

## 4) Orchestration runs

Run an orchestration that uses all step types (AgentRun, ToolRun, MemoryOp, ApprovalGate,
SignalWait, Checkpoint, SubOrchestration). Then confirm status + stepStatuses:

```bash
kubectl get orchestrationruns.orchestration.proompteng.ai -n jangar
kubectl get orchestrationruns.orchestration.proompteng.ai -n jangar <run-name> -o yaml
```

Ensure `status.stepStatuses` is populated and `status.phase` is `Succeeded`.

## 5) Policy enforcement

Run both negative and positive checks:

- **Budget**: set `status.used` above `spec.limits` and verify run creation is rejected.
- **SecretBinding**: omit `secretBindingRef` while requesting secrets and verify a 403.
- **ApprovalPolicy**: set a policy to `Denied` and verify ApprovalGate blocks.

Audit events should be present in `audit_events` for allow/deny decisions.

## Quick script

For a quick smoke check, run:

```bash
scripts/jangar/validate-primitives.sh
```

The script asserts pinned Crossplane function tags, non-zero memory tables, and a
succeeded orchestration run with populated `stepStatuses`. Adjust env vars for
non-default namespaces or clusters.
