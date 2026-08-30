# Torghut Production-Readiness Proof Runbook

This runbook is the authoritative operator sequence for a production-readiness signoff on a single frozen Torghut image digest.

## Scope

- Strategy scope: `equities + intraday_tsmom_v1`
- Historical primary proof day: `March 13, 2026`
- Held-out profitability window: `March 2, 2026` through `March 13, 2026`
- Broker target: Alpaca `paper`
- Signoff rule: every proof lane must pass on the same `image_digest`

## Current P0 Capital Hold

Production-readiness signoff is blocked while the profitability roadmap P0 mutation and reconciliation proofs remain
incomplete. GitOps keeps `TRADING_NEW_EXPOSURE_CUTOFF_TIME_ET=00:00:00`: the scheduler continues status, reconciliation,
cancel, and closeout work, but strategy decisions cannot increase exposure.

The authoritative baseline is `GET /trading/status` on the scheduler owner. Record all of these independently:

- `action_authority.service_healthy`
- `action_authority.entry_allowed`
- `action_authority.reduce_only_allowed`
- `action_authority.recovery_degraded`
- `broker_mutation_safety.runtime_wired`
- `broker_mutation_safety.*_fencing_proven`
- `broker_mutation_safety.reason_codes`

Do not reinterpret `live_submission_gate.allowed`, Kubernetes readiness, or Argo health as capital authority. Until the
broker-mutation coordinator and recovery worker are production-wired and fault-proved, the expected truthful baseline
is `entry_allowed=false`, `reduce_only_allowed=false`, and `recovery_degraded=true`; the existing emergency closeout
path remains operational but is not yet a durably fenced reduction authority.

## Preconditions

1. Freeze the candidate digest and confirm it is the active digest on:
   - `torghut`
   - `torghut-sim`
   - `torghut-historical-simulation` WorkflowTemplate
2. Do not change strategy config, model refs, or digest after the first March 13 proof starts.
3. Ensure the historical workflow has Ceph cache credentials:
   - `TORGHUT_SIM_CACHE_CEPH_ACCESS_KEY`
   - `TORGHUT_SIM_CACHE_CEPH_SECRET_KEY`
   - `TORGHUT_SIM_CACHE_CEPH_BUCKET`
   - `TORGHUT_SIM_CACHE_CEPH_ENDPOINT`
4. Ensure the simulation manifest uses split Postgres credentials:
   - `postgres.admin_dsn` targets the bootstrap/superuser role with `TORGHUT_POSTGRES_ADMIN_PASSWORD`
   - `postgres.simulation_dsn` / `postgres.runtime_simulation_dsn` target the Torghut app role with `TORGHUT_POSTGRES_PASSWORD`

## Sequence

### 1. Historical parity and execution proof

Run one fresh March 13 full-day replay on the frozen digest.

Replay contract for the proof lane:

- historical proof manifests must use `ta_restore.mode=stateless`
- proof reruns must hard-reset TA operator state; resuming prior checkpoint lineage is invalid for readiness signoff

Required outcome:

- non-zero decisions
- non-zero executions
- `legacy_path_count=0`
- full artifact bundle present

Then run three consecutive true warm-cache reruns for the same March 13 window on the same digest.

Required outcome for all three warm reruns:

- cache hit path actually used
- no `cursor_tail_stable`
- identical decision, execution, order-event, and TCA counts
- matching proof artifact hashes

Suggested supporting commands:

```bash
cd services/torghut
uv run python -m scripts.historical_simulation_startup --mode run ...
python services/torghut/scripts/run_simulation_analysis.py activity ...
```

### 2. Profitability proof

Run the held-out March 2-13 window using the frozen digest and the existing empirical promotion contracts.

Required artifacts:

- profitability proof manifest
- model-risk evidence package
- quant-readiness verification output

Suggested supporting commands:

```bash
python services/torghut/scripts/verify_quant_readiness.py \
  --profitability-proof <path> \
  --model-risk-evidence-package <path> \
  ...
```

### 3. Live paper broker proof

Do not execute a broker mutation while `broker_mutation_safety.runtime_wired=false`. Once the bounded validation submit
path reports wired, follow the [infrastructure-validation runbook](profitability/infrastructure-validation-runbook.md)
exactly. Use Torghut's dedicated coordinator path and a short-lived `InfrastructureValidationPermit`; direct
script-to-broker submission is not admissible. The continuous Alpaca crypto exercise does not need a US equities
session. If broker I/O becomes ambiguous, do not retry: preserve the receipt for the Slice 5 recovery path.

Required outcome:

- account lookup succeeds
- pre-submit validation succeeds
- order submit succeeds
- readback succeeds
- terminal cancel, expiry, or rejection with zero filled quantity is observed
- the account returns to zero positions and zero open orders
- the receipt and any asynchronous order event remain explicitly non-promotable and unlinked from candidate evidence

### 4. Session readiness proof

Capture the live readiness gate on the same digest used for the replay and broker proof.

Required outcome:

- `GET /scheduler/readyz` returns `200` for the scheduler workload;
- `GET /trading/status` reports `action_authority.service_healthy=true`;
- entry, reduction, recovery, and broker-mutation fields match the intended capital stage;
- the core `/readyz` result is recorded separately and may be `503` while capital entry is intentionally blocked;
- no rollback-required service blocker is active.

Persist the captured readiness payload as `session-ready.json`.

### 5. Proof repair capture

If the readiness gate is blocked by stale empirical, order-feed source-window, execution TCA, or zero-notional drift
receipts, capture the live status first. The scheduled repair CronJobs and their maintenance API endpoints have been
removed; do not recreate them for proof recovery. Repairs now run through the scheduler-owned runtime and its normal
capital-safety gates.

```bash
stamp="$(date -u +%Y%m%d%H%M%S)"
out="/tmp/torghut-proof-rerun-${stamp}"
mkdir -p "${out}"
```

After the rerun, capture only the current operational endpoints:

```bash
curl -fsS http://torghut.torghut.svc.cluster.local/trading/status > "${out}/status.json"
kubectl -n torghut get --raw \
  '/api/v1/namespaces/torghut/services/http:torghut-scheduler:8183/proxy/scheduler/readyz' \
  > "${out}/scheduler-ready.json"
```

Do not submit or fabricate an Alpaca order from this runbook. Broker execution evidence must come from Torghut’s normal
scheduler or bounded paper-route probe path.

## Bundle assembly

Once all lanes pass, assemble the canonical proof bundle:

```bash
python services/torghut/scripts/assemble_production_readiness_bundle.py \
  --output-dir <bundle-dir> \
  --image-digest <digest> \
  --proof-timestamp <utc-iso8601> \
  --run-id <historical-run-id> \
  --workflow-name <workflow-name> \
  --proof-id <signoff-id> \
  --broker-mode paper \
  --simulation-proof <path> \
  --broker-proof <path> \
  --profitability-proof <path> \
  --model-risk-evidence <path> \
  --session-ready <path> \
  --performance <path>
```

The bundle must contain:

- `simulation-proof.json`
- `broker-proof.json`
- `profitability-proof.json`
- `model-risk-evidence.json`
- `session-ready.json`
- `performance.json`
- `bundle-manifest.json`

## Fail-Closed Rules

- Any warm rerun with zero decisions or zero executions invalidates readiness.
- Any missing required artifact invalidates readiness.
- Any broker proof outside the production `TorghutAlpacaClient` / `AlpacaExecutionAdapter` path is invalid.
- Any digest mismatch across proof lanes invalidates readiness.
- Platform proof without profitability proof means platform-ready only, not capital-ready.
