# Torghut TigerBeetle Ledger Runbook

Torghut uses TigerBeetle as a durable double-entry ledger for execution/order lifecycle accounting evidence. Postgres remains the metadata and control-plane database. The Torghut service stores deterministic TigerBeetle account and transfer references in Postgres so runtime-ledger and proof systems can reconcile ledger evidence without replacing orchestration state.

## Current Topology

- Namespace: `torghut`
- Operator: Tigresse
- Cluster: `TigerBeetleCluster/torghut-tigerbeetle`
- Cluster ID: `2001`
- Endpoint: `torghut-tigerbeetle.torghut.svc.cluster.local:3000`
- Server/client version: `0.17.9`
- Storage class: `rook-ceph-block`
- Bootstrap replicas: `1`

The current bootstrap topology is not full TigerBeetle production HA. Do not claim full production HA until the cluster has six schedulable failure domains or Torghut has migrated to a new immutable HA TigerBeetle cluster.

## GitOps Sources

- Cluster CR: `argocd/applications/torghut/tigerbeetle-cluster.yaml`
- Runtime env: `argocd/applications/torghut/knative-service.yaml`
- SIM runtime env: `argocd/applications/torghut/knative-service-sim.yaml`
- Smoke hook: `argocd/applications/torghut/tigerbeetle-smoke-job.yaml`
- Design: `docs/torghut/tigerbeetle-ledger-design.md`

Torghut does not schedule a TigerBeetle catch-up or reconciliation CronJob. Live
order events, executions, costs, and runtime-ledger buckets journal synchronously.
The bounded journal runner remains available for explicit operator-driven repair,
but stale periodic reconciliation is not a service-readiness requirement.

## Normal Verification

```bash
kubectl -n argocd get app tigresse torghut -o wide
kubectl -n torghut get tigerbeetlecluster torghut-tigerbeetle -o wide
kubectl -n torghut get tigerbeetlecluster torghut-tigerbeetle -o jsonpath='{range .status.conditions[*]}{.type}={.status} {.reason}{"\n"}{end}'
kubectl -n torghut get sts,pod,pvc,svc,pdb -l app.kubernetes.io/instance=torghut-tigerbeetle -o wide
kubectl -n torghut logs job/torghut-tigerbeetle-smoke --tail=200
```

Expected smoke output includes:

```text
nop ok
create_accounts idempotent ok
create_transfers idempotent ok
lookup_transfers ok
reconciliation ok
```

## Service Health

Torghut exposes TigerBeetle state through the normal health surfaces:

```bash
kubectl -n torghut exec deploy/$(kubectl -n torghut get deploy -l serving.knative.dev/service=torghut -o jsonpath='{.items[0].metadata.name}') -- \
  /opt/venv/bin/python scripts/verify_tigerbeetle_ledger.py --mode smoke
```

For HTTP checks, inspect:

- `/readyz`: dependency object `dependencies.tigerbeetle`
- `/trading/health`: same readiness dependency payload
- `/trading/status`: top-level `tigerbeetle_ledger`

Optional protocol failures do not make Torghut unready while `TORGHUT_TIGERBEETLE_REQUIRED=false`. If `TORGHUT_TIGERBEETLE_REQUIRED=true`, protocol failure becomes a readiness blocker. Scheduled reconciliation is disabled, so `TORGHUT_TIGERBEETLE_RECONCILE_REQUIRED=false`; reconciliation age and staleness remain diagnostic fields without blocking readiness or new exposure.

## Reconciliation Semantics

Torghut writes deterministic Postgres reference rows for TigerBeetle accounts and transfers:

- `tigerbeetle_account_refs`
- `tigerbeetle_transfer_refs`
- `tigerbeetle_reconciliation_runs`

Order-feed lifecycle events are journaled after normalized `ExecutionOrderEvent` persistence. Duplicate events reuse the same deterministic transfer ID. Existing TigerBeetle duplicate transfers are accepted only if lookup matches the expected amount, ledger, code, debit account, and credit account. Mismatched duplicates are hard failures.

Reconciliation blockers are proof blockers, not profitability claims:

- `tigerbeetle_transfer_missing`
- `tigerbeetle_transfer_amount_mismatch`
- `tigerbeetle_transfer_code_mismatch`
- `tigerbeetle_transfer_ledger_mismatch`
- `tigerbeetle_transfer_debit_account_mismatch`
- `tigerbeetle_transfer_credit_account_mismatch`
- `tigerbeetle_postgres_ref_mismatch`
- `tigerbeetle_source_row_missing`
- `tigerbeetle_source_amount_mismatch`
- `tigerbeetle_runtime_ledger_direction_mismatch`
- `tigerbeetle_runtime_ledger_metadata_mismatch`
- `tigerbeetle_runtime_ledger_signed_refs_missing`
- `tigerbeetle_runtime_ledger_account_refs_missing`
- `tigerbeetle_unlinked_order_event`
- `tigerbeetle_unlinked_execution`
- `tigerbeetle_unlinked_execution_cost`
- `tigerbeetle_unlinked_runtime_ledger`
- `tigerbeetle_client_unavailable`
- `tigerbeetle_reconciliation_stale`

The operator-driven journal runner emits stable JSON with schema version `torghut.tigerbeetle-journal-order-events.v1`, top-level `ok`/`status`, per-source batch counts, sampled errors, and the reconciliation payload so repair evidence can distinguish durable ledger evidence from degraded or stale ledger parity.

## Rollout Checklist

1. Confirm the intended TigerBeetle release is compatible with the live replica and update the server manifest, Python client dependency, lockfile, contract test, and version documentation together.
2. Render manifests:

   ```bash
   mise exec helm@3 -- kustomize build --enable-helm argocd/applications/torghut >/tmp/torghut-render.yaml
   rg -n 'TigerBeetleCluster|torghut-tigerbeetle|TORGHUT_TIGERBEETLE|tigerbeetle-smoke' /tmp/torghut-render.yaml
   ```

3. Run local Torghut checks:

   ```bash
   cd services/torghut
   uv run --frozen --extra dev pytest tests/test_tigerbeetle_ids.py tests/test_tigerbeetle_ledger_model.py tests/test_tigerbeetle_client.py tests/test_tigerbeetle_journal.py tests/test_tigerbeetle_reconcile.py tests/test_tigerbeetle_status.py tests/test_verify_tigerbeetle_ledger.py -q
   uv run --frozen --extra dev ruff check app/trading/tigerbeetle_*.py scripts/verify_tigerbeetle_ledger.py tests/test_tigerbeetle_*.py tests/test_verify_tigerbeetle_ledger.py
   ```

4. Wait for CI and release automation to update the Torghut image digest in every Torghut workload, including `tigerbeetle-smoke-job.yaml`.
5. Verify Argo sync and the PostSync smoke job.
6. Inspect `/readyz`, `/trading/health`, and `/trading/status`.

## Troubleshooting

- `TigerBeetleCluster` missing: check `argocd/applications/torghut/kustomization.yaml` and Argo sync result.
- Pods blocked by Pod Security: check Torghut `managedNamespaceMetadata` in `argocd/applicationsets/product.yaml`.
- PVC pending: check `rook-ceph-block` and node/storage availability.
- Smoke job cannot import `tigerbeetle`: image digest was not updated to a build that includes the new Python dependency.
- Smoke job times out: inspect TigerBeetle pod logs and the service endpoint.
- Synchronous journaling reports unlinked evidence: inspect journal settings and `tigerbeetle_transfer_refs`, then run `python scripts/run_tigerbeetle_journal_cron.py --preset live --json` explicitly if a bounded repair is required.
