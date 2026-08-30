# 104. Torghut Proof Expiry Clock And Hypothesis Rehydration Lanes (2026-05-06)

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

I am choosing a **proof expiry clock with hypothesis rehydration lanes** for Torghut.

The latest read-only state says Torghut is alive but not profit-authoritative. The live and simulation revisions are
running, Postgres and ClickHouse readiness checks are healthy, and both live and simulation report schema head
`0029_whitepaper_embedding_dimension_4096`. That is operationally useful.

The same payloads say capital proof is expired. Live `/readyz` returns HTTP 503 because simple submission is disabled.
Live alpha readiness has three hypotheses, zero promotion-eligible hypotheses, and three rollback-required hypotheses.
Simulation is HTTP 200 but reports degraded quant evidence: `quant_latest_metrics_empty`,
`quant_latest_store_alarm`, and `quant_pipeline_stages_missing`. Jangar marks the shared dependency quorum blocked on
stale empirical jobs: `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and `janus_hgrm_reward`.

The selected architecture makes proof age explicit. Every hypothesis gets a proof-expiry clock. When proof expires,
Torghut does not just say "degraded"; it routes the hypothesis into a rehydration lane with a measurable next proof
sample, budget, and rollback trigger. The tradeoff is slower promotion. I accept that because a stale empirical job is
not a reason to submit; it is a reason to repair the proof circuit.

## Read-Only Evidence Snapshot

No Kubernetes resources, database rows, or trading settings were mutated.

### Cluster And Route Evidence

- `kubectl get pods -n torghut -o wide` showed `torghut-00228-deployment-6cfbd4d7b8-twfnn` and
  `torghut-sim-00309-deployment-65b8769f9-kkc7h` at `2/2 Running`.
- ClickHouse, Keeper, Torghut Postgres, options catalog, options enricher, options TA, websocket, Alloy, and guardrail
  exporter pods were running.
- `kubectl rollout status deploy/torghut-ws -n torghut` and
  `kubectl rollout status deploy/torghut-options-catalog -n torghut` returned successfully rolled out.
- Torghut events still included readiness/startup probe failures during rollout and Flink status-update conflict
  warnings for `torghut-options-ta`.
- This service account cannot list Knative services, FlinkDeployments, PDBs, secrets, or exec into CNPG pods in the
  Torghut namespace, so the design relies on projected readiness/status evidence for least-privilege deployment gates.

### Live Torghut Evidence

- `curl -i http://torghut.torghut.svc.cluster.local/readyz` returned HTTP 503 with `"status":"degraded"`.
- Scheduler, Postgres, ClickHouse, and Alpaca checks were individually `ok`.
- Database schema was current: current head and expected head were both `0029_whitepaper_embedding_dimension_4096`,
  with no missing or unexpected heads.
- Migration graph lineage was ready but reported parent-fork warnings for
  `0010_execution_provenance_and_governance_trace` and `0015_whitepaper_workflow_tables`.
- Universe source was `jangar`, but `symbols_count` was 0 and the universe was "not yet evaluated" while
  `require_non_empty=true`.
- Live submission gate was blocked: `allowed=false`, reason `simple_submit_disabled`, capital stage `shadow`, and no
  promotion eligibility.
- Quant evidence was not required in live mode because Jangar quant health was not configured for the live account.
- Alpha readiness was three total hypotheses, one blocked, two shadow, zero promotion eligible, and three rollback
  required.

### Simulation Evidence

- `curl http://torghut-sim.torghut.svc.cluster.local/readyz` returned HTTP 200 with `"status":"ok"`.
- Database schema head matched live.
- Simulation capital stage was `paper` and live submission gate was allowed only because the mode is non-live.
- Quant evidence was degraded for account `TORGHUT_SIM`: latest metrics count 0, no latest metrics timestamp, stage
  count 0, `quant_latest_metrics_empty`, `quant_latest_store_alarm`, and `quant_pipeline_stages_missing`.
- Alpha readiness matched live: three hypotheses, zero promotion eligible, and three rollback required.

### Jangar Consumer Evidence

- Jangar dependency quorum is blocked on `empirical_jobs_degraded`.
- Jangar empirical job evidence names stale `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and
  `janus_hgrm_reward`.
- Jangar failure-domain holdbacks allow `torghut_observe` but hold `torghut_capital`.
- The companion Jangar design makes `torghut_capital` depend on a compact Torghut proof-expiry decision, not broad
  route health.

### Source Evidence

- `services/torghut/app/main.py` builds `/readyz` from scheduler, Postgres, ClickHouse, broker, database schema,
  universe, empirical jobs, DSPy runtime, live submission gate, and quant evidence.
- `_build_live_submission_gate_payload` allows non-live simple mode but blocks live simple mode on
  `trading_disabled`, `kill_switch_enabled`, `simple_submit_disabled`, and active emergency stop.
- Current simple-mode live submission does not consume stale empirical jobs or quant evidence as hard blockers unless
  the configured mode requires them. That is operationally useful, but it is too loose for capital promotion.
- `services/torghut/app/trading/empirical_jobs.py`, `services/torghut/app/trading/hypotheses.py`, and
  `services/torghut/app/trading/submission_council.py` already provide the vocabulary for freshness, hypothesis state,
  dependency quorum, capital stage, and reason codes. The missing artifact is an expiry clock that joins them into a
  current promotion decision.

## Problem

Torghut currently exposes useful readiness details, but the profitability question is still too implicit:

1. A running pod can coexist with zero promotion eligibility.
2. Simulation can be HTTP 200 while the latest quant metrics store is empty.
3. Live mode can keep broker/database dependencies healthy while live submission is intentionally disabled.
4. Stale empirical jobs are visible, but they do not produce a durable rehydration assignment.
5. Jangar needs a compact answer for `torghut_capital`: current proof, expired proof, or repair-only.

Without an expiry clock, stale proof turns into status text. Status text does not retire risk, schedule repair, or tell
Jangar when capital-adjacent actions are safe again.

## Alternatives Considered

### Option A: Keep Capital Disabled Until Manual Review

Pros:

- Safe in the immediate term.
- Matches the current `simple_submit_disabled` live posture.
- Requires no new projection.

Cons:

- Does not repair the stale empirical jobs.
- Does not define how a hypothesis becomes eligible again.
- Leaves Jangar to infer capital safety from disconnected status fields.

Decision: reject as the architecture. Manual review remains a human override, not the recovery loop.

### Option B: Promote From Simulation Because It Is HTTP 200

Pros:

- Simulation route is healthy.
- Non-live simple mode is allowed.
- It can start paper proof quickly.

Cons:

- Simulation quant metrics are empty.
- Promotion eligibility is still zero.
- It ignores rollback-required hypotheses and stale empirical jobs.
- It would convert operational readiness into proof readiness.

Decision: reject.

### Option C: Proof Expiry Clock With Rehydration Lanes

Torghut projects a proof-expiry record per hypothesis/account/window. Expired records route to a rehydration lane:
equity TA proof refresh, options data bootstrap, empirical job replay, or rejection-drag repair. Jangar consumes only
the compact decision.

Pros:

- Makes stale proof measurable and schedulable.
- Separates observation, repair, paper, and live decisions.
- Gives Jangar a capital-safe contract.
- Lets options innovation proceed through data readiness instead of empty-table optimism.
- Provides clean rollback triggers.

Cons:

- Requires new projection and tests.
- Slows capital reentry until proof is fresh.
- Needs careful budgets to keep rehydration from becoming unbounded research.

Decision: select Option C.

## Chosen Architecture

### ProofExpiryClock

Torghut should project one current record per hypothesis, account, and window:

```text
proof_expiry_clock
  hypothesis_id
  strategy_family
  account
  window
  generated_at
  fresh_until
  proof_state              # current, stale, missing, contradictory, blocked
  capital_decision         # observe_only, repair_only, paper_candidate, live_candidate, blocked
  empirical_job_refs[]
  quant_metric_refs[]
  data_readiness_refs[]
  rejection_drag_bps
  expected_net_edge_bps
  max_drawdown_bps
  rollback_required
  blocking_reason_codes[]
  rehydration_lane
  next_sample_contract
```

Initial reducer rules:

- If `promotion_eligible_total=0`, the decision cannot exceed `repair_only`.
- If any required empirical job is stale, proof state is `stale` and rehydration lane is `empirical_replay`.
- If latest quant metrics are empty for the account/window, proof state is `missing` and rehydration lane is
  `quant_metrics_rebuild`.
- If the universe requires non-empty symbols and returns zero symbols, proof state is `blocked` for paper/live capital
  and `repair_only` for data repair.
- If live simple submission is disabled, live capital is blocked even when other proof is current.
- If all proof is current, rejection drag and net edge decide whether the record is `paper_candidate` or
  `live_candidate`.

### Rehydration Lanes

The first four lanes should be explicit:

- `empirical_replay`: rerun `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and
  `janus_hgrm_reward` for the active hypothesis and dataset snapshot.
- `quant_metrics_rebuild`: republish latest quant health metrics to Jangar for the account/window and verify the stage
  count is non-zero.
- `universe_rebind`: repair Jangar universe evaluation until `symbols_count > 0` or explicitly document a closed market
  exception.
- `rejection_drag_repair`: sample the most recent blocked/rejected decisions, quantify rejection drag, and block paper
  promotion until drag is below the configured threshold.

Options work uses the same clock but starts in data readiness. Empty options feature tables cannot produce a paper or
live candidate.

### Jangar Consumer Contract

Torghut publishes the compact decision to Jangar:

```text
torghut_proof_expiry
  account
  window
  generated_at
  fresh_until
  capital_decision
  proof_state
  blocking_reason_codes[]
  rehydration_lane
  artifact_refs[]
```

Jangar maps it as follows:

- `observe_only` -> allow `torghut_observe`, hold `torghut_capital`.
- `repair_only` -> allow repair/rehydration schedules, hold paper/live capital.
- `paper_candidate` -> allow paper proof only if Jangar route/source-schema clocks agree.
- `live_candidate` -> still requires explicit deployer approval and live submission controls.
- `blocked` -> hold all capital and open only bounded repair.

## Engineer Handoff

Implement in small slices:

1. Add a pure proof-expiry reducer in Torghut that accepts the existing readyz dependencies, empirical job status,
   quant evidence, hypothesis summary, and live submission gate payload.
2. Add tests for the current state: live blocked on `simple_submit_disabled`, simulation degraded by empty quant
   metrics, zero promotion eligibility capped at `repair_only`, and stale empirical jobs mapped to
   `empirical_replay`.
3. Expose the clock in `/readyz` and `/trading/autonomy` as advisory data only.
4. Add the Jangar consumer projection only after the Torghut payload has one clean release cycle.

Acceptance gates:

- `uv run --frozen pytest services/torghut/tests/test_profit_expiry_clock.py`
- `uv run --frozen pyright --project pyrightconfig.json`
- `uv run --frozen pyright --project pyrightconfig.alpha.json`
- `uv run --frozen pyright --project pyrightconfig.scripts.json`
- In-cluster live `/readyz` still blocks live submission, while simulation exposes `repair_only` until latest metrics
  and empirical jobs are fresh.

## Deployer Handoff

Deploy advisory projection first. Do not enable capital behavior from the new clock in the first rollout.

1. Roll out Torghut with the proof-expiry payload hidden behind advisory status.
2. Verify live remains blocked while `TRADING_SIMPLE_SUBMIT_ENABLED=false`.
3. Verify simulation reports `repair_only` while latest metrics count is zero.
4. Verify Jangar still holds `torghut_capital` until it consumes a current Torghut proof-expiry record.
5. Only after one clean cycle, let Jangar use the clock for `torghut_capital` hold/allow decisions.

Rollback:

- Remove the advisory payload or disable the feature flag.
- Keep live submission disabled.
- Keep Jangar `torghut_capital` held until a fresh proof-expiry decision is available.

## Risks

- The rehydration lanes can become unbounded if each stale job creates a new research branch instead of a bounded proof
  sample.
- Universe `symbols_count=0` may be a startup/evaluation timing issue; the reducer must distinguish transient startup
  from persistent data absence.
- A future live candidate still needs broker-side controls. This design does not weaken kill switch, emergency stop,
  or simple submit controls.
- Jangar and Torghut must agree on expiry windows; otherwise Jangar can hold a capital action after Torghut thinks the
  proof is current.

## Open Questions

- What is the first target expiry window for empirical jobs: one trading day, one market session, or one proof sample?
- Should zero-symbol universe evidence block all rehydration, or only paper/live capital?
- Should options data readiness require both `options_contract_bars_1s` and `options_surface_features`, or can surface
  features lag bars during bootstrap?
