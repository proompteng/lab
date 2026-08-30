# 139. Torghut Profit-Data Witness And Forecast Repair Exchange (2026-05-07)

Status: Accepted for engineer and deployer handoff

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented: typed proof/readiness/repair/capital surfaces exist across API, trading, and Jangar consumer modules; contract text remains broader than runtime.
- Matched implementation area: Proof, evidence, freshness, repair, and capital gating.
- Current source evidence:
  - `services/torghut/app/api/readiness_helpers/trading_health_proof_lane.py`
  - `services/torghut/app/api/proof_floor_payloads/proof_floor_receipts.py`
  - `services/torghut/app/trading/consumer_evidence.py`
  - `services/torghut/app/trading/freshness_carry.py`
  - `services/torghut/app/trading/revenue_repair/repair_queue.py`
  - `services/jangar/src/server/control-plane-torghut-consumer-evidence.ts`
- Design drift note: Most May 2026 proof/capital docs are implemented as distributed surfaces, not single resources named after each document.


## Decision

I am selecting **profit-data witness and forecast repair exchange** as the next Torghut profitability architecture
step.

The current state is better than the stale May 5 soak, but it is not capital-ready. Jangar now reports execution trust
healthy and database migrations current through `20260505_torghut_quant_pipeline_health_window_index`. Empirical jobs
are fresh: `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and `janus_hgrm_reward` are promotion
authority eligible for candidate `chip-paper-microbar-composite@execution-proof` on dataset
`torghut-chip-full-day-20260505-5e447b6d-r1`. That is real progress.

The capital blocker moved. Jangar's material action verdicts still hold `paper_canary` and block `live_micro_canary`
because Torghut consumer evidence is missing, forecast service authority is degraded, and watch reliability is
degraded. The Torghut autonomy route returns fresh empirical jobs, but `forecast_registry` is absent and the Jangar
empirical-services reducer reports `forecast.status=degraded`, `message=registry_empty`, and `eligible_models=[]`.
That means Torghut has enough empirical proof to fund zero-notional repair, but not enough settled forecast authority
to spend paper or live capital.

The selected design creates a profit-data witness consumed from Jangar's database witness exchange and a forecast
repair exchange inside Torghut. The repair exchange ranks zero-notional bids that turn fresh empirical artifacts into
forecast registry entries, consumer evidence receipts, and bounded replay plans. The tradeoff is that capital stays
locked while repair work proceeds. I accept that because a fresh empirical candidate without a forecast registry and
without Jangar consumer receipts is not a profitable trading authority; it is a repair opportunity.

## Runtime Objective And Success Metrics

This contract increases profitability by converting blocked proof into measurable repair work without relaxing capital
guardrails.

Success means:

- Torghut publishes a profit-data witness that references Jangar's database witness exchange before paper/live capital.
- Forecast registry absence becomes a ranked zero-notional repair bid, not a generic degraded status.
- Fresh empirical jobs can create forecast repair, replay, and paper-readiness work while `max_notional=0`.
- Jangar material action verdicts stop using `torghut_consumer_evidence_missing` once Torghut publishes a current
  consumer evidence receipt.
- Paper canary remains held until forecast registry, TCA, database witness, consumer evidence, and watch reliability
  receipts are current.
- Live micro canary remains blocked until paper settlement, current execution/TCA, and rollback rehearsal are current.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database rows, broker state, trading flags,
GitOps resources, or empirical artifacts.

### Cluster And Control-Plane Evidence

- Jangar and agents deployments were available in the current sample.
- Jangar route status reported execution trust healthy and database migrations current.
- Watch reliability was degraded over `15` minutes with `2461` events, `0` errors, and `4` restarts.
- Material action verdicts held `dispatch_normal`, `deploy_widen`, and `merge_ready` on `watch_reliability_degraded`.
- `paper_canary` was held with `forecast_service_degraded` and `watch_reliability_degraded`.
- `live_micro_canary` was blocked with `torghut_consumer_evidence_missing`, `forecast_service_degraded`, and
  `watch_reliability_degraded`.
- `torghut_capital` action-clock decision was `hold` with conflict class `consumer_debt` and reason
  `forecast_service_degraded`.

### Profit And Data Evidence

- `GET /trading/autonomy` showed empirical jobs healthy and authoritative.
- Eligible empirical jobs were `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and
  `janus_hgrm_reward`.
- The eligible candidate was `chip-paper-microbar-composite@execution-proof`.
- The dataset snapshot was `torghut-chip-full-day-20260505-5e447b6d-r1`.
- Empirical artifacts referenced S3 paths under
  `s3://torghut-empirical-artifacts/empirical/sim-2026-05-05-chip-5e447b6d-r1/`.
- The same route did not return a populated `forecast_registry`, `live_submission`, or `proof_floor` object in the
  fields sampled.
- Jangar's empirical service projection reported `forecast.status=degraded`, `forecast.message=registry_empty`, and
  `forecast.eligible_models=[]`.
- Independent database validation from the current runtime is blocked by Jangar service-account RBAC and by the missing
  `jangar-db-ro` endpoint, so Torghut capital must treat database proof as service-owned until Jangar ships the witness
  exchange.

### Source Evidence

- `services/torghut/app/trading/autonomy/lane.py` is `7377` lines and owns much of the autonomy lane, including
  evidence manifests, phase manifests, promotion recommendation payloads, rollback readiness, and capital policy.
- `services/torghut/app/trading/submission_council.py` is `1199` lines and builds live submission gates from Jangar
  dependency quorum, quant status, empirical evidence, promotion certificates, market-context segments, and TCA inputs.
- Torghut tests already cover autonomy lane promotion blockers, malformed readiness, stale readiness, rollback
  readiness, profitability stage manifests, and live submission policy.
- The missing design is not another "make trading ready" checklist. The missing design is a small exchange that prices
  which proof repair converts fresh empirical work into forecast authority fastest while maintaining zero notional.

## Problem

Torghut has fresh empirical proof without a settled forecast authority path.

That creates three risks:

1. Fresh empirical jobs get ignored because forecast authority is degraded into a single status string.
2. Capital gates get loosened by hand because the empirical candidate looks promising.
3. Jangar keeps reporting `torghut_consumer_evidence_missing` because Torghut has no compact receipt that says what is
   fresh, what is missing, what is repair-only, and what remains capital-blocking.

The current state should not result in paper trading. It should result in zero-notional repair work ranked by expected
profit unblock value.

## Alternatives Considered

### Option A: Promote The Fresh Empirical Candidate To Paper Immediately

Pros:

- Uses the freshest available Torghut proof.
- Creates paper observations quickly.
- Gives the team a concrete candidate to watch.

Cons:

- Bypasses the missing forecast registry.
- Does not resolve Jangar `torghut_consumer_evidence_missing`.
- Ignores degraded watch reliability and database witness gaps.
- Risks treating a repair candidate as capital authority.

Decision: reject.

### Option B: Freeze All Torghut Work Until Jangar Witness Quorum Is Complete

Pros:

- Strong safety posture.
- Easy for deployer gates to enforce.
- Avoids more partial evidence.

Cons:

- Wastes fresh empirical artifacts that can be used safely at zero notional.
- Does not tell engineers what to repair first.
- Leaves forecast registry and consumer evidence debt unpriced.

Decision: reject.

### Option C: Profit-Data Witness And Forecast Repair Exchange

Pros:

- Consumes Jangar database witness authority as a first-class input.
- Converts fresh empirical jobs into ranked zero-notional repair bids.
- Produces consumer evidence receipts that Jangar can ingest.
- Holds paper/live capital until forecast, TCA, witness, and rollback receipts are current.
- Gives profitability work measurable hypotheses and explicit guardrails.

Cons:

- Adds a reducer and route payload.
- Requires careful artifact and dataset lineage checks.
- May keep capital at zero even when empirical jobs look attractive.

Decision: select Option C.

## Architecture

Torghut emits one profit-data witness per account, candidate, and market window.

```text
profit_data_witness
  witness_id
  generated_at
  fresh_until
  account_label
  candidate_id
  dataset_snapshot_ref
  jangar_database_witness_exchange_ref
  empirical_job_receipt_refs
  forecast_registry_receipt_ref
  consumer_evidence_receipt_ref
  tca_receipt_ref
  capital_state                  # zero_notional, shadow, paper_ready, live_blocked
  max_notional
  reason_codes
```

Forecast repair is a zero-notional exchange.

```text
forecast_repair_bid
  bid_id
  witness_id
  repair_kind                    # registry_bootstrap, consumer_receipt, replay_lineage, tca_refresh
  candidate_id
  dataset_snapshot_ref
  expected_unblock_value
  expected_cost
  allowed_effects                # artifact_write, replay, status_publish
  blocked_effects                # paper_order, live_order
  acceptance_metric
  rollback_target
  reason_codes
```

Consumer evidence is compact enough for Jangar to ingest without reading Torghut internals.

```text
torghut_consumer_evidence_receipt
  receipt_id
  generated_at
  fresh_until
  candidate_id
  empirical_jobs_state
  forecast_registry_state
  tca_state
  database_witness_state
  paper_readiness_state
  live_readiness_state
  max_notional
  reason_codes
```

Initial repair hypotheses:

- `H-FORECAST-REGISTRY-01`: if four empirical jobs are promotion-authority eligible for the same candidate and dataset,
  generate a forecast registry entry in shadow with `eligible_models >= 1`, `max_notional=0`, and artifact lineage back
  to the empirical S3 refs.
- `H-CONSUMER-EVIDENCE-01`: if forecast registry bootstrap succeeds, publish a consumer evidence receipt that clears
  `torghut_consumer_evidence_missing` in Jangar while preserving `paper_canary=hold` until TCA and witness quorum are
  current.
- `H-TCA-REACTIVATION-01`: once forecast registry and consumer evidence are current, run zero-notional replay or
  simulation work to refresh execution/TCA receipts before paper.
- `H-WITNESS-QUORUM-01`: consume Jangar database witness exchange and hold paper/live if database authority is only
  `service_only`.

Capital guardrails:

- `max_notional=0` until forecast registry, consumer evidence, TCA, Jangar database witness quorum, and watch
  reliability are current.
- No live order path may consume forecast repair bids directly.
- Paper canary requires a current rollback target and bounded loss budget.
- Live micro canary requires closed paper settlement and current execution/TCA.
- Any contradiction between empirical candidate, forecast registry, dataset snapshot, or Jangar witness state reverts
  to `zero_notional`.

## Implementation Scope For Engineer Stage

1. Add a Torghut profit-data witness payload near the autonomy lane or submission council boundary rather than deep
   inside unrelated trading code.
2. Produce the first witness from existing empirical job payloads, forecast registry state, Jangar status, and TCA
   state.
3. Publish a compact consumer evidence receipt that Jangar can read without requiring Torghut DB credentials.
4. Add a forecast repair exchange that ranks zero-notional bids and writes only bounded artifacts or route payloads in
   the first phase.
5. Add tests proving:
   - fresh empirical jobs plus empty forecast registry creates `registry_bootstrap` repair, not paper authority;
   - consumer evidence receipt clears only the missing-consumer reason and does not clear forecast/TCA blockers;
   - `service_only` Jangar database witness holds paper/live;
   - stale TCA keeps live blocked even with fresh forecast registry;
   - mismatched candidate/dataset lineage blocks repair promotion.

## Validation Gates

Minimum local validation:

- `pytest services/torghut/tests/test_autonomous_lane.py -k "promotion or profitability or readiness"`
- `pytest services/torghut/tests/test_trading_scheduler_autonomy.py -k "actuation or phase_manifest"`
- `bunx oxfmt --check docs/torghut/design-system/v6/139-torghut-profit-data-witness-and-forecast-repair-exchange-2026-05-07.md`

Read-only runtime validation:

- `curl -fsS http://torghut.torghut.svc.cluster.local/trading/autonomy | jq '.empirical_jobs'`
- `curl -fsS http://torghut.torghut.svc.cluster.local/trading/autonomy | jq '.forecast_registry'`
- `curl -fsS http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status | jq '.empirical_services'`
- `curl -fsS http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status | jq '.material_action_verdict_epoch.final_verdicts[] | select(.action_class==\"paper_canary\" or .action_class==\"live_micro_canary\")'`

Acceptance gates:

- Fresh empirical jobs produce at least one repair bid.
- Empty forecast registry keeps capital at `zero_notional`.
- Jangar consumer evidence receipt is present and current before paper.
- Jangar database witness exchange is `quorum` before paper or live notional.
- TCA receipt is current before live micro canary.
- No route or artifact exposes credentials, raw DSNs, account secrets, or unrestricted SQL.

## Rollout Plan

1. Ship profit-data witness and repair bids as route-only shadow payloads.
2. Publish consumer evidence receipt to Jangar while keeping capital state `zero_notional`.
3. Let Jangar material verdicts consume the receipt to remove only `torghut_consumer_evidence_missing`.
4. Add forecast registry bootstrap as a zero-notional repair action.
5. Add TCA reactivation only after forecast registry and consumer evidence are current.
6. Allow paper canary only after database witness quorum, forecast registry, TCA, rollback, and watch reliability are
   current.

## Rollback Plan

- Disable forecast repair bid admission and leave the witness payload read-only.
- Keep all capital states at `zero_notional`.
- Remove Jangar consumer receipt consumption by flag if it creates false positives.
- Revert to existing submission council and autonomy gates for paper/live decisions.
- Do not delete empirical artifacts or mutate historical trading records.

## Risks And Tradeoffs

- Forecast registry bootstrap can produce a false sense of authority if it is treated as capital-ready. The guardrail is
  explicit: registry bootstrap is zero-notional repair only.
- Consumer evidence receipt can hide detail. Keep it compact but include refs back to empirical jobs, dataset snapshot,
  Jangar witness, and TCA state.
- Jangar database witness quorum may lag behind Torghut repair progress. That is acceptable; repair can continue at
  zero notional.
- The autonomy lane is large. Implement the first payload at a boundary and avoid a broad refactor.
- If watch reliability remains degraded, paper must stay held even after Torghut repairs forecast state.

## Handoff To Engineer

Build the smallest profit-data witness that can clear ambiguity without granting capital. The first winning behavior is:
fresh empirical jobs plus empty forecast registry emits `registry_bootstrap` and `consumer_receipt` repair bids with
`max_notional=0`; it does not emit paper or live authority. Feed Jangar a compact consumer evidence receipt only after
lineage agrees on candidate and dataset snapshot.

## Handoff To Deployer

Deploy this as a shadow profitability repair surface. Validate the autonomy route and Jangar material verdicts before
allowing any capital transition. If anything disagrees, set the witness state to `zero_notional` and keep existing
submission council gates authoritative.
