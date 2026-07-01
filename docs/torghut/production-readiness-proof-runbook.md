# Torghut Production-Readiness Proof Runbook

This runbook is the authoritative operator sequence for a production-readiness signoff on a single frozen Torghut image digest.

## Scope

- Strategy scope: `equities + intraday_tsmom_v1`
- Historical primary proof day: `March 13, 2026`
- Held-out profitability window: `March 2, 2026` through `March 13, 2026`
- Broker target: Alpaca `paper`
- Signoff rule: every proof lane must pass on the same `image_digest`

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

Execute the production-real Alpaca paper proof on the next live US equities session.

Required outcome:

- account lookup succeeds
- pre-submit validation succeeds
- order submit succeeds
- readback succeeds
- terminal cancel or fill is observed

Suggested command:

```bash
python services/torghut/scripts/verify_alpaca_broker.py \
  --mode paper \
  --output <bundle-dir>/broker-proof.raw.json
```

### 4. Session readiness proof

Capture the live readiness gate on the same digest used for the replay and broker proof.

Required outcome:

- `GET /readyz` returns `200`
- `GET /trading/health` returns `200`
- Jangar dependency quorum returns `allow`
- broker status is `broker_ok`
- no rollback-required blocker is active

Persist the captured readiness payload as `session-ready.json`.

### 5. Proof repair capture

If the readiness gate is blocked by stale empirical, order-feed source-window, execution TCA, or zero-notional drift
receipts, capture the live status first. The old scheduled empirical renewal, source-window repair, and TCA refresh
CronJobs have been removed; do not recreate them for proof recovery. The remaining GitOps-owned repair CronJob is the
zero-notional drift repair.

The zero-notional repair CronJob runs the script with `--execute-policy dispatchable-only`: it first calls the repair
endpoint with `execute=false` and only dispatches when the receipt contains a concrete `zero_notional_action` or
`candidate_id`. A capital-safe `no_selected_repair` receipt should complete successfully with
`preflight_skipped_execute=true`.

```bash
stamp="$(date -u +%Y%m%d%H%M%S)"
out="/tmp/torghut-proof-rerun-${stamp}"
mkdir -p "${out}"

job="torghut-zero-notional-drift-repair-manual-${stamp}"
kubectl create job -n torghut --from="cronjob/torghut-zero-notional-drift-repair" "${job}"
kubectl wait -n torghut --for=condition=complete --timeout=20m "job/${job}"
kubectl get job -n torghut "${job}" -o yaml > "${out}/${job}.yaml"
kubectl logs -n torghut -l "job-name=${job}" --all-containers --timestamps --tail=-1 > "${out}/${job}.log"
```

After the rerun, capture:

```bash
curl -fsS http://torghut.torghut.svc.cluster.local/trading/status > "${out}/status.json"
curl -fsS http://torghut.torghut.svc.cluster.local/trading/empirical-jobs > "${out}/empirical-jobs.json"
curl -fsS http://torghut.torghut.svc.cluster.local/trading/revenue-repair > "${out}/revenue-repair.json"
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
