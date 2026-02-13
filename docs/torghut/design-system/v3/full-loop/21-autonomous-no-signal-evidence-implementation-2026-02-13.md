# Autonomous No-Signal Evidence Implementation (2026-02-13)

## Objective
Ensure the autonomy loop creates durable research-ledger evidence for empty-signal windows so monitoring, replay, and rollout tooling can distinguish a healthy no-data state from an execution failure.

## Design
1. On each autonomous cycle, persist a deterministic `research_runs` record when signal ingestion returns zero rows.
2. Record the autonomy window metadata in the run row:
   - `status='skipped'`
   - `dataset_from=query_start`
   - `dataset_to=query_end`
   - deterministic `run_id` built from window and window-reason
3. Emit an artifact file `no-signals.json` under the autonomy output directory with:
   - status, reason, query start/end timestamps
   - reference path captured in `state.last_autonomy_gates`
4. Preserve existing lane execution path for non-empty windows.

## Runtime state updates
- `last_autonomy_reason` is set to the no-signal reason.
- `last_autonomy_run_id` contains the persisted skipped run ID.
- `last_autonomy_gates` points to `no-signals.json`.

## Why this is needed
- Previous behavior silently returned on no-signal windows and produced no `research_runs` telemetry.
- Operators could not confirm whether the loop was alive versus broken.

## Success criteria
- `trading/autonomy` shows `last_reason` transitions to and from explicit no-signal reasons.
- `research_runs` receives regular `skipped` rows during sustained empty windows.
- No regression when lane has non-empty signals; gating, persistence, and recommendation outputs remain unchanged.

## Rollout checklist
1. Deploy code and verify autonomous cycle logs the no-signal artifact path.
2. Verify `research_runs` has rows with `status='skipped'` while `signals_total == 0`.
3. Validate signal recovery by observing a subsequent non-empty cycle produces a normal lane `run_id` and candidate artifacts.
