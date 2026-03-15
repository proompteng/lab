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

## Sequence

### 1. Historical parity and execution proof

Run one fresh March 13 full-day replay on the frozen digest.

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
python services/torghut/scripts/start_historical_simulation.py --mode run ...
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
