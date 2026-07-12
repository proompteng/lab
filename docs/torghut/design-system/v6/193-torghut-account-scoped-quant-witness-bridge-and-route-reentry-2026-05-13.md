# 193. Torghut Account-Scoped Quant Witness Bridge And Route Reentry (2026-05-13)

Status: Accepted for engineer and deployer handoff

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented: route repair, paper-route probing, quote routeability, and TCA/freshness surfaces exist but remain gate-controlled.
- Matched implementation area: Routeability, TCA, fill quality, and market context.
- Current source evidence:
  - `services/torghut/app/trading/route_reacquisition.py`
  - `services/torghut/app/trading/route_reacquisition_probe.py`
  - `services/torghut/app/trading/scheduler/paper_route_probe/probe_processing.py`
  - `services/torghut/app/trading/scheduler/submission_preparation/quote_routeability.py`
  - `services/torghut/app/trading/tca`
- Design drift note: Routeability claims need current repair/probe/TCA/readiness evidence.


## Decision

I am selecting **a capital-safe quant witness bridge** for Torghut route reentry.

Torghut has useful direct data now. Live and sim are running on the promoted image, direct ClickHouse TA is current,
Postgres schema is current, empirical jobs are healthy, and `/trading/consumer-evidence` is the typed action boundary.
The route warrant still has no routeable candidates and remains repair-only because the quant dependency is reported as
`quant_health_not_configured`, active TCA is stale, promotion candidates are missing, and the proof floor is
zero-notional. Jangar aggregate quant health can be fresh, but the account-scoped health for `paper` is empty and the
live account `PA3SX7FYNUTF` request times out under the operator budget.

The decision is to consume a Jangar account/window quant witness as **observe-mode route-reentry evidence**, not as a
live submission dependency. Torghut should use that witness to retire the `quant_health_not_configured` route-warrant
blocker when the witness is current for the same account and window. Torghut must keep `TRADING_JANGAR_QUANT_HEALTH_URL`
out of the live submission gate until the witness is proven reliable and independent capital gates are still in force.

The tradeoff is that route warrants get a little more complex before they get more profitable. That is the right price.
The system already has enough proof contracts; the missing piece is correct account-level custody so the contracts can
retire the smallest blocker without opening capital.

## Governing Runtime Requirements

Every run must cite the governing Torghut design or runtime requirement before changing code. Implementation stages
must produce production PRs that improve readiness, profit evidence, data freshness, execution quality, or capital
safety. Verify stages must merge only green PRs and prove image promotion, Argo sync, live service health, and trading
or evidence status after rollout. Final handoff must name the revenue metric improved or the smallest blocker
preventing revenue impact.

This design maps to the value gates:

- `zero_notional_or_stale_evidence_rate`: replace the generic `quant_health_not_configured` route-warrant debt with
  account-scoped witness states.
- `routeable_candidate_count`: admit routeable candidates only when the quant witness, TCA, routeability, profit
  signal, proof floor, and source-serving evidence all match.
- `post_cost_daily_net_pnl`: require current quant evidence before any post-cost profit claim can graduate from repair
  to paper.
- `fill_tca_or_slippage_quality`: keep TCA stale states independent of quant witness freshness.
- `capital_gate_safety`: keep every witness and repair lot at `max_notional=0` until live submission gates allow
  capital separately.

## Read-Only Evidence Snapshot

Assessment used Kubernetes reads and service HTTP reads. I did not apply Kubernetes resources, directly mutate database
rows, change trading flags, submit orders, or create AgentRuns. One source finding is that Jangar's quant health GET
starts the quant runtime by design; this document treats that runtime warm-up as architecture evidence and not as a
direct data-store or trading mutation.

### Cluster And Runtime

- Jangar was available on image `f5ed7394`; `/ready` returned `status=ok`.
- Jangar control-plane status reported database connected, migration consistency healthy, rollout health healthy, and
  watch reliability healthy with `0` errors and `0` restarts in the 15 minute window.
- Torghut live revision `torghut-00347` and sim revision `torghut-sim-00445` were ready. Options catalog, options
  enricher, options TA, live TA, live/sim WebSocket services, ClickHouse, Keeper, Postgres, and guardrail exporters
  were running.
- Sim `/readyz` returned `status=ok`, while live `/readyz` returned degraded because capital-facing dependencies
  intentionally remain blocked.
- Recent Torghut events showed rollout readiness probe misses during revision activation and recurring
  whitepaper/autoresearch workflow failures. These are reliability concerns but not a reason to bypass capital gates.

### Source

- `services/torghut/app/trading/submission_council.py` validates typed Jangar quant health URLs and returns
  `quant_health_not_configured` when no URL is configured.
- `services/torghut/app/main.py` feeds `quant_evidence` into readiness, consumer evidence, route warrants, evidence
  clocks, routeable candidate exchange, profit freshness, and repair-bid settlement.
- `services/torghut/README.md` says production live and paper manifests intentionally leave Jangar quant-health URLs
  unset so the live trading loop is not fail-closed on external Jangar availability.
- `services/jangar/src/routes/api/torghut/trading/control-plane/quant/health.ts` and
  `services/jangar/src/server/torghut-quant-runtime.ts` can produce fresh aggregate quant evidence, but the current
  health contract does not give Torghut a reliable account-scoped witness for route warrants.
- Tests cover many downstream receipts, route warrants, and repair tickets, but the missing test class is aggregate
  quant healthy/account-scoped quant absent.

### Database And Data

- `/readyz` reported Postgres ok, ClickHouse ok, Alpaca live broker ok, universe `8` static symbols, database schema
  current, empirical jobs healthy, and schema head `0031_autoresearch_candidate_spec_epoch_uniqueness`.
- ClickHouse guardrail exporter reported both replicas reachable, disk free ratios above `0.96`, no read-only replicas,
  and current TA timestamps on both `ta_signals` and `ta_microbars`.
- Jangar aggregate quant health returned `latestMetricsCount=4536`, `emptyLatestStoreAlarm=false`,
  `metricsPipelineLagSeconds=2`, and runtime enabled.
- `account=paper&window=15m` quant health returned degraded with `latestMetricsCount=0`,
  `emptyLatestStoreAlarm=true`, `missingPipelineHealthStages=true`, and no stages.
- `account=PA3SX7FYNUTF&window=15m` quant health timed out inside a 15 to 20 second operator budget.
- Live route warrants reported `warrant_state=repair_only`, `routeable_candidate_count=0`,
  `accepted_routeable_candidate_count=0`, `zero_notional_or_stale_evidence_rate=0.7`, and seven repair packets.
- Active TCA remains stale with execution samples last created on `2026-04-02T19:00:29.586040+00:00`, average absolute
  slippage `13.8203637593029676` bps, and expected shortfall sample count `0`.
- The options catalog freshness summary logged a Postgres statement timeout in Torghut, which is a data-quality
  pressure signal for options-informed route expansion.

## Problem

Torghut treats quant evidence as not configured, while Jangar can prove aggregate quant freshness and cannot yet prove
account-scoped freshness reliably.

The concrete failure modes are:

1. `quant_health_not_configured` remains in live route warrants even when aggregate Jangar quant metrics are fresh.
2. Account-scoped quant witness quality is unknown, empty, or slow for the accounts Torghut must trade.
3. Configuring the existing Jangar quant health URL as required on live would make live readiness depend on a route
   that has already timed out for the live account.
4. Route warrants cannot retire quant debt without either ignoring account scope or weakening live availability.
5. Zero-notional repair dispatch cannot tell whether the next best action is quant materialization, account alias
   repair, TCA refresh, or promotion candidate generation.
6. The system remains capital-safe, but revenue impact is blocked because `routeable_candidate_count=0`.

## Alternatives Considered

### Option A: Enable Required External Quant Health In Live

Set `TRADING_JANGAR_QUANT_HEALTH_URL` to the typed Jangar quant health route and require it for live.

Advantages:

- Reuses existing Torghut configuration and validator.
- Would remove the "not configured" reason code quickly.
- Gives `/readyz` an explicit external quant dependency.

Disadvantages:

- Conflicts with the documented production rule that live and paper services do not fail closed on Jangar quant health.
- Observed live account scope times out, so this would trade a stale-evidence blocker for a readiness dependency.
- Does not solve account aliasing, stage completeness, or aggregate/account mismatch.

Decision: reject for live and paper capital gates.

### Option B: Keep Quant Evidence Informational Until TCA And Promotion Clear

Do nothing now. Let TCA, promotion, and proof-floor repairs clear first, then revisit quant.

Advantages:

- No new contract.
- Avoids adding another cross-service dependency.
- TCA and promotion are real blockers anyway.

Disadvantages:

- Leaves `zero_notional_or_stale_evidence_rate` inflated by a generic configuration reason.
- Makes repair dispatch less precise.
- Allows aggregate/account quant mismatch to remain invisible until late in the routeability path.

Decision: reject. Quant witness custody is cheap enough to specify now and blocks later false confidence.

### Option C: Consume A Jangar Account-Scoped Quant Witness In Observe Mode

Torghut consumes a compact Jangar witness that proves aggregate and account/window quant status separately. The witness
can retire `quant_health_not_configured` only for route-warrant evidence; it cannot authorize paper or live submission.

Advantages:

- Preserves live availability and capital safety.
- Gives route warrants account/window truth.
- Converts account-scoped timeout into a zero-notional repair lot.
- Lets route reentry improve from measurable evidence instead of config presence.
- Keeps TCA, proof floor, and submission gates independent.

Disadvantages:

- Requires a new Torghut consumer field and tests.
- Requires Jangar to publish a stable witness id and TTL.
- Requires deployer checks for account aliasing and timeout behavior.

Decision: select Option C.

## Architecture

Torghut adds an observe-mode bridge packet to `/trading/consumer-evidence`:

```text
torghut.quant-witness-bridge.v1
  bridge_id
  generated_at
  account
  window
  source = jangar.quant-account-witness.v1
  witness_ref
  witness_state = current | stale | empty | timeout | unavailable | not_configured
  aggregate_latest_metrics_count
  account_latest_metrics_count
  metrics_pipeline_lag_seconds
  missing_pipeline_health_stages
  reason_codes[]
  route_warrant_effect
    can_retire_quant_not_configured
    can_clear_quant_route_debt
    target_value_gates[]
  capital_safety
    max_notional = "0"
    paper_notional_limit = "0"
    live_notional_limit = "0"
```

Torghut rules:

- No witness configured: keep existing `quant_health_not_configured` semantics.
- Witness unavailable or timeout: emit `quant_account_witness_unavailable` or `quant_account_witness_timeout`, keep
  route warrant `repair_only`, and create a zero-notional repair lot.
- Aggregate current but account empty: emit `quant_account_latest_store_empty`; do not clear quant route debt.
- Account current but TCA stale: clear only the quant dependency; keep routeability held by TCA.
- Account current and all other gates current: allow routeable candidate count to increase only up to the independent
  proof-floor and live-submission limits.
- Any bridge packet that asks for paper or live notional is invalid.

The bridge is not the same as `TRADING_JANGAR_QUANT_HEALTH_REQUIRED`. It is evidence for route warrants, not a live
submission health dependency.

## Implementation Scope

Engineer milestone 1:

- Add a Torghut config for the Jangar quant witness route with default disabled.
- Add `torghut.quant-witness-bridge.v1` to `/trading/consumer-evidence`, `/trading/status`, and `/readyz`.
- Add tests for not configured, timeout, aggregate healthy/account empty, account current/TCA stale, and account
  current/all-other-gates-current.

Engineer milestone 2:

- Feed the bridge into `build_route_warrant_exchange`.
- Retire `quant_health_not_configured` only when witness account, window, TTL, and stage health are current.
- Add repair packets for `quant_account_witness_timeout`, `quant_account_latest_store_empty`, and
  `quant_pipeline_stage_missing`.

Engineer milestone 3:

- Wire Jangar `dispatch_repair` to consume bridge repair lots only when `max_notional=0`, dedupe keys are present, and
  validation commands are declared.
- Keep `routeable_candidate_count=0` while TCA, routeability, profit signal, proof floor, or live submission gates
  remain blocked.

Deployer milestone:

- Capture Jangar aggregate quant health and account-scoped witness health.
- Capture Torghut `/trading/consumer-evidence` and show `torghut.quant-witness-bridge.v1` with `max_notional=0`.
- Capture Torghut `/readyz` and prove capital remains degraded until proof floor and live submission gates clear.

## Validation Gates

Local checks:

- `bunx oxfmt --check docs/agents/designs/189-jangar-account-scoped-quant-witness-custody-and-route-reentry-2026-05-13.md docs/torghut/design-system/v6/193-torghut-account-scoped-quant-witness-bridge-and-route-reentry-2026-05-13.md docs/torghut/design-system/v6/index.md`
- `git diff --check`

Engineer checks:

- `pytest services/torghut/tests/test_route_warrant_exchange.py -k quant`
- `pytest services/torghut/tests/test_jangar_continuity.py -k quant`
- Jangar quant witness unit tests for account alias, timeout, and aggregate/account mismatch.

Runtime checks:

- Aggregate Jangar quant health remains current.
- Account-scoped witness responds within the service budget.
- Torghut route warrants stop emitting `quant_health_not_configured` only when the witness is current.
- `zero_notional_or_stale_evidence_rate` falls only by the quant dependency contribution.
- `capital_gate_safety` remains `zero_notional_safe`.

## Rollout

1. Deploy the Jangar witness route in observe mode.
2. Deploy Torghut bridge consumption disabled by default.
3. Enable the bridge for sim, then live observe mode.
4. Compare route-warrant blocker sets before and after for one market session.
5. Allow zero-notional repair dispatch to consume bridge repair lots.
6. Keep paper and live notional blocked until independent capital gates pass.

## Rollback

- Disable Torghut bridge consumption and fall back to existing `quant_health_not_configured` behavior.
- Disable the Jangar witness route if it causes account-scoped query pressure.
- Preserve current route warrants, proof floor, and live submission gate behavior; no rollback should change broker
  settings or notional limits.

## Risks

- Account alias mismatch can produce false empty-store evidence. The bridge must expose the canonical account and
  aliases used.
- A current account witness can make route warrants look closer to reentry while TCA is still stale. The route warrant
  tests must prove TCA remains independently blocking.
- Options catalog query pressure is already visible. The bridge must not add unbounded database scans.
- Operators may expect `/readyz` to turn healthy when quant is configured. It should not; readiness remains degraded
  until capital gates clear.

## Handoff

Revenue metric improved by this design: `zero_notional_or_stale_evidence_rate` should fall by retiring generic quant
configuration debt, and `routeable_candidate_count` gets an account-scoped quant prerequisite instead of an aggregate
dashboard proxy.

Smallest blocker preventing revenue impact today: live account quant witness reliability is not proven. Until it is,
Torghut keeps `max_notional=0`, `warrant_state=repair_only`, and live submission blocked.
