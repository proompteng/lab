# 189. Jangar Account-Scoped Quant Witness Custody And Route Reentry (2026-05-13)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-13
Owner: Gideon Park, Torghut Traders Architecture
Scope: Jangar quant-control evidence, account/window witness custody, Torghut route-warrant repair admission,
capital-safe route reentry, rollout, rollback, and cross-stage handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/193-torghut-account-scoped-quant-witness-bridge-and-route-reentry-2026-05-13.md`

Extends:

- `188-jangar-typed-torghut-evidence-admission-and-repair-dispatch-2026-05-13.md`
- `188-jangar-ready-truth-arbiter-and-stage-credit-cutover-2026-05-13.md`
- `187-jangar-main-source-ci-retention-and-source-serving-verdicts-2026-05-13.md`
- `docs/torghut/design-system/v6/192-torghut-typed-consumer-evidence-route-and-capital-safe-repair-dispatch-2026-05-13.md`
- `docs/torghut/design-system/v6/190-torghut-route-warrant-exchange-and-ingestion-proof-reentry-2026-05-13.md`

## Decision

I am selecting **account-scoped quant witness custody** as the next Jangar reliability and Torghut profit-evidence
contract.

The May 13 evidence changed the shape of the problem. Jangar's controller rollout is healthy, watch reliability is
healthy, and the Torghut consumer-evidence route is current. The aggregate Jangar quant store can become fresh and
large enough to report `latestMetricsCount=4536`, `metricsPipelineLagSeconds=2`, and `status=ok`. Torghut live still
reports `quant_health_not_configured`, route warrants remain `repair_only`, and accepted routeable candidates stay at
`0`. When the quant-health route is scoped to `account=paper&window=15m`, it returns degraded with an empty latest
store and missing pipeline stages. When scoped to the live account `PA3SX7FYNUTF&window=15m`, the request times out
inside a 15 to 20 second operator budget.

That means aggregate quant health is not enough. The next useful architecture step is to make Jangar produce a compact
account/window quant witness that Torghut can consume as route-reentry evidence without turning Jangar availability
into a live submission dependency. Jangar owns the quant computation, latest-store custody, and pipeline-health
classification. Torghut owns route warrants, proof floor, routeable candidate counts, and capital safety. The bridge
between them must be explicit and account-scoped.

The tradeoff is stricter routing. A healthy aggregate quant store will no longer be allowed to clear a Torghut
route-warrant blocker by itself. I accept that because account mismatch is exactly how a system can look healthy while
not producing routeable, post-cost profit evidence for the account that would carry capital.

## Governing Runtime Requirements

Every run must cite the governing Torghut design or runtime requirement before changing code. Implementation stages
must produce production PRs that improve readiness, profit evidence, data freshness, execution quality, or capital
safety. Verify stages must merge only green PRs and prove image promotion, Argo sync, live service health, and trading
or evidence status after rollout. Final handoff must name the revenue metric improved or the smallest blocker
preventing revenue impact.

This design maps to the value gates:

- `zero_notional_or_stale_evidence_rate`: replace `quant_health_not_configured` and account-scoped timeout with a
  measured quant-witness state and a bounded repair lot.
- `routeable_candidate_count`: allow candidate counts to increase only when the account/window quant witness is fresh
  for the same account and window as the route warrant.
- `fill_tca_or_slippage_quality`: keep active TCA stale-state independent; a fresh quant witness cannot mask TCA
  shortfall, stale executions, or slippage over guardrail.
- `post_cost_daily_net_pnl`: require account-scoped quant metrics to line up with post-cost hypothesis and TCA
  evidence before any profit claim can graduate.
- `capital_gate_safety`: preserve `max_notional=0` until Torghut's proof floor, route warrants, source-serving proof,
  and live submission gate all clear independently.

## Read-Only Evidence Snapshot

Assessment used Kubernetes reads and service HTTP reads. I did not apply Kubernetes manifests, directly edit database
records, change broker state, modify trading flags, or create AgentRuns. One source finding is that Jangar's quant
health GET starts the quant runtime by design; this document treats that runtime warm-up as architecture evidence and
not as a direct data-store or trading mutation.

### Cluster And Rollout

- Branch state was `codex/swarm-torghut-quant-discover` on current `origin/main`
  `bbe9dd519 chore(jangar): promote image f5ed7394 (#6409)`.
- Jangar deployment was available `1/1` on image `registry.ide-newton.ts.net/lab/jangar:f5ed7394` with pod
  `jangar-9b5489d5c-8dtbn` running `2/2`.
- Jangar `/health` returned HTTP 200. Jangar `/ready` returned HTTP 200 with leader election current, database
  migration consistency healthy, rollout health healthy, and watch reliability healthy.
- Jangar watch reliability reported `2` observed streams, `787` events, `0` errors, and `0` restarts in the 15 minute
  window. This is materially better than the May 6 watch-restart storm.
- Torghut live revision `torghut-00347` and sim revision `torghut-sim-00445` were ready. ClickHouse, Keeper, Postgres,
  TA, TA sim, options TA, WebSocket, options catalog, options enricher, and guardrail exporters were running.
- Recent Torghut events still showed startup/readiness probe misses during rollout and recurring
  `torghut-whitepaper-autoresearch-profit-target` workflow errors. These are not live capital gates, but they are
  reliability debt for research-to-profit throughput.

### Source

- `services/jangar/src/routes/api/torghut/trading/control-plane/quant/health.ts` starts the quant runtime, reads
  `quant_metrics_latest`, checks `quant_pipeline_health`, and reports `emptyLatestStoreAlarm`,
  `missingPipelineHealthStages`, `runtimeEnabled`, and pipeline lag.
- `services/jangar/src/server/torghut-quant-runtime.ts` computes strategy/account/window frames, writes latest and
  series metrics, and appends ingestion, compute, and materialization health rows.
- `services/jangar/src/server/torghut-quant-metrics-store.ts` has store functions for latest metrics and latest
  pipeline health, including account/window filters.
- `services/torghut/app/trading/submission_council.py` accepts only the typed Jangar
  `/api/torghut/trading/control-plane/quant/health` endpoint when `TRADING_JANGAR_QUANT_HEALTH_URL` is configured, but
  production live/paper intentionally leave that URL unset so Jangar availability is not a live submission dependency.
- `services/torghut/app/main.py` passes `quant_evidence` into readiness, consumer evidence, route warrants,
  evidence clocks, profit freshness, routeability, and repair-bid settlement.

### Data And Runtime Evidence

- Torghut `/readyz` returned degraded because `live_submission_gate.ok=false` with `simple_submit_disabled`,
  `profitability_proof_floor.ok=false` with `capital_state=zero_notional`, and `quant_evidence.reason` was
  `quant_health_not_configured`.
- Torghut `/trading/consumer-evidence` returned `torghut.consumer-evidence-status.v1`, mode `live`, running `true`,
  route-proven candidate `chip-paper-microbar-composite@execution-proof`, and `max_notional=0`.
- Torghut route warrants reported `warrant_state=repair_only`, `accepted_routeable_candidate_count=0`,
  `routeable_candidate_count=0`, `zero_notional_or_stale_evidence_rate=0.7`, and seven repair packets.
- Direct ClickHouse TA was current in the route warrant witness, with newest TA timestamp within roughly two minutes of
  assessment. ClickHouse guardrail exporter reported both replicas up, disk free ratios above `0.96`, and no read-only
  replicated tables.
- Active TCA remained stale: `execution_tca_stale`, active-session samples stale, expected-shortfall samples missing,
  and average absolute slippage `13.8203637593029676` bps over an `8` bps guardrail.
- Jangar aggregate quant health without account/window scope returned `status=ok`, `latestMetricsCount=4536`,
  `emptyLatestStoreAlarm=false`, and `metricsPipelineLagSeconds=2`.
- Jangar `account=paper&window=15m` quant health returned `status=degraded`, `latestMetricsCount=0`,
  `emptyLatestStoreAlarm=true`, `missingPipelineHealthStages=true`, and no stages.
- Jangar `account=PA3SX7FYNUTF&window=15m` quant health timed out inside a 15 to 20 second operator budget.
- `/db-check` reported Torghut schema current at `0031_autoresearch_candidate_spec_epoch_uniqueness`; direct Postgres
  and ClickHouse exec access from the agent service account was forbidden, so database assessment used service
  contracts and guardrail exporters.

## Problem

Jangar can prove aggregate quant freshness while Torghut cannot safely use that evidence for the account carrying
route warrants and capital holds.

The concrete failure modes are:

1. Aggregate quant health can be `ok` while account-scoped quant health is empty, degraded, or slow.
2. Torghut live sees `quant_health_not_configured`, so route warrants carry stale quant debt even when Jangar has fresh
   aggregate metrics.
3. A naive fix that configures Torghut live to require Jangar quant health would convert an account-scoped timeout into
   a live readiness dependency.
4. Route warrants cannot distinguish "quant store globally fresh" from "quant witness current for this account and
   window."
5. Repair dispatch cannot rank the quant repair packet against TCA and routeability debt using a stable witness id.
6. Operators see fresh quant dashboards, stale Torghut route warrants, and zero routeable candidates without a single
   custody object that explains the mismatch.

This blocks revenue through `routeable_candidate_count=0`; it does not justify relaxing `max_notional=0`.

## Alternatives Considered

### Option A: Require Torghut Live To Call Jangar Quant Health Directly

Set `TRADING_JANGAR_QUANT_HEALTH_URL` and `TRADING_JANGAR_QUANT_HEALTH_REQUIRED=true` on live/paper services.

Advantages:

- Small configuration surface.
- Torghut already has a typed URL validator.
- Quant evidence would show as configured immediately.

Disadvantages:

- Violates the current production rule that live and paper trading loops should not fail closed on external Jangar
  availability.
- Converts the observed live-account timeout into readiness degradation instead of a repairable witness.
- Does not solve account aliasing or account/window completeness.
- Risks hiding the difference between aggregate quant health and account-specific quant readiness.

Decision: reject for live submission gates. This may be useful in a shadow or sim lane, but not as the primary design.

### Option B: Let Aggregate Quant Health Clear Torghut Route Warrants

Use unscoped `/quant/health` as the route-warrant quant witness because it is fast and can report a large latest-store
count.

Advantages:

- Immediate status improvement.
- Simple for dashboards.
- Avoids account-specific query pressure.

Disadvantages:

- Incorrect for capital routing. Aggregate health does not prove account/window freshness.
- Would allow `latestMetricsCount>0` to mask `account=paper` empty store and live account timeouts.
- Weakens the value gates by letting routeability improve from unrelated evidence.

Decision: reject.

### Option C: Create Account-Scoped Quant Witness Custody

Jangar emits a compact account/window witness that separates aggregate store state, account store state, pipeline-stage
state, timeout state, and route-warrant usability. Torghut consumes that witness as zero-notional route-reentry
evidence, not as direct live submission authority.

Advantages:

- Preserves Torghut's safety rule that Jangar availability is not a live submission prerequisite.
- Gives route warrants a precise quant witness with account, window, TTL, and failure class.
- Lets repair dispatch prioritize the quant repair packet using a stable witness id.
- Makes aggregate/account mismatch visible to operators.
- Keeps `max_notional=0` until independent proof-floor, TCA, routeability, source-serving, and submission gates clear.

Disadvantages:

- Requires a new witness route or projected packet in Jangar.
- Requires Torghut to consume a witness without treating it as a hard live dependency.
- Adds one more contract that must be versioned and tested.

Decision: select Option C.

## Architecture

Jangar publishes:

```text
jangar.quant-account-witness.v1
  witness_id
  generated_at
  fresh_until
  account
  account_aliases[]
  window
  strategy_scope
  aggregate_latest_store
    status
    latest_metrics_count
    latest_metrics_updated_at
    metrics_pipeline_lag_seconds
  account_latest_store
    status
    latest_metrics_count
    latest_metrics_updated_at
    metrics_pipeline_lag_seconds
    timeout_observed
  pipeline_health
    ingestion
    compute
    materialization
  route_warrant_usability
    state = current | stale | empty | timeout | not_scoped
    reason_codes[]
    target_value_gates[]
  capital_safety
    max_notional = "0"
    can_clear_routeability = false unless account_latest_store.status == current
```

Jangar rules:

- Aggregate latest-store health is advisory only.
- Account/window latest-store health is required to clear the quant route-warrant dependency.
- Missing pipeline stages produce `quant_pipeline_stages_missing`, not a generic degraded state.
- Timeouts produce `quant_account_witness_timeout` and a fresh witness with stale usability, so repair dispatch can act
  without confusing timeout with success.
- Witness TTL is short during market hours and may be longer out of session, but stale witnesses cannot increase
  routeable candidates.
- The witness never contains paper or live notional authorization.

Torghut consumes the witness through the companion design as an observe-mode input to consumer evidence and route
warrants. A current witness can retire `quant_health_not_configured`; it cannot by itself clear TCA, proof floor,
source-serving, alpha readiness, or live submission blockers.

## Implementation Scope

Engineer milestone 1:

- Add a Jangar quant witness route or projection that returns `jangar.quant-account-witness.v1`.
- Add unit tests for aggregate healthy/account empty, aggregate healthy/account timeout, and account current cases.
- Add latency tests that keep witness generation under a 2 second service budget by using cached latest-store rows, not
  expensive account-wide scans.

Engineer milestone 2:

- Add Torghut observe-mode consumption of the witness and expose it under `/trading/consumer-evidence`.
- Keep `TRADING_JANGAR_QUANT_HEALTH_REQUIRED=false` for live and paper.
- Replace `quant_health_not_configured` with `quant_account_witness_*` reason codes only when a witness route is
  configured and reachable.

Engineer milestone 3:

- Teach route warrants to retire the quant repair packet only when witness account, window, source commit, and TTL match
  the active Torghut route warrant.
- Keep routeable candidate count at `0` unless TCA, routeability, profit signal, proof floor, and source-serving gates
  clear independently.

Deployer milestone:

- Prove Jangar `/api/torghut/trading/control-plane/quant/health` aggregate status and account-scoped witness status.
- Prove Torghut `/trading/consumer-evidence` carries the witness id and still reports `max_notional=0`.
- Prove `/readyz` can remain degraded for capital while the quant witness no longer reports "not configured."

## Validation Gates

Local checks:

- `bunx oxfmt --check docs/agents/designs/189-jangar-account-scoped-quant-witness-custody-and-route-reentry-2026-05-13.md docs/torghut/design-system/v6/193-torghut-account-scoped-quant-witness-bridge-and-route-reentry-2026-05-13.md docs/torghut/design-system/v6/index.md`
- `git diff --check`

Engineer checks:

- Jangar unit tests for the new witness route.
- Torghut tests for witness consumption in route warrants, evidence clocks, and consumer evidence.
- Contract fixture proving aggregate health cannot clear account-scoped quant debt.

Runtime checks:

- Jangar aggregate quant health is current.
- Jangar account/window witness is current or emits an explicit timeout/empty reason inside the service budget.
- Torghut consumer evidence includes `quant_account_witness_ref`.
- Torghut route warrants reduce `zero_notional_or_stale_evidence_rate` only when the account witness is current.
- `capital_gate_safety` remains `zero_notional_safe` until independent capital gates clear.

## Rollout

1. Ship Jangar witness route in observe mode.
2. Verify aggregate, paper-scoped, and live-account scoped witness responses from inside the cluster.
3. Ship Torghut witness consumption behind an observe-mode flag.
4. Compare route-warrant quant blocker before and after for one market session.
5. Allow repair dispatch to consume the witness only for zero-notional quant repair lots.

## Rollback

- Disable the Torghut witness-consumption flag and fall back to existing `quant_health_not_configured` semantics.
- Keep Jangar witness route enabled for diagnostics if it is not causing query pressure.
- If the witness route causes database pressure or timeouts, disable the Jangar quant runtime flag and preserve current
  zero-notional route-warrant behavior.

## Risks

- Account labels can drift between Torghut, Alpaca, and Jangar quant rows. The witness must publish aliases and the
  canonical account used in the query.
- Account-scoped latest-store queries can be slow under load. The route must avoid unbounded scans and needs a strict
  latency budget.
- A fresh quant witness can make route warrants look less stale while TCA remains stale. Validation must prove TCA
  blockers still hold routeability and capital.
- Starting quant runtime through a health route is operationally surprising. The engineer stage should confirm runtime
  startup is explicit at service boot or cheaply idempotent.

## Handoff

Revenue metric improved by this design: `zero_notional_or_stale_evidence_rate` should fall when account-scoped quant
witnesses become current, and `routeable_candidate_count` gets a precise quant prerequisite instead of a generic
configuration blocker.

Smallest blocker preventing revenue impact today: the live account-scoped quant witness is not reliable enough to
consume. Until that is fixed, Torghut must keep `max_notional=0` and route warrants in `repair_only`.
