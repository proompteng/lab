# 145. Torghut Repair Dividend Ledger And Submission Quorum (2026-05-07)

Status: Accepted for engineer and deployer handoff

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented and evolved: execution route/gate/status modules exist, with live submission controlled by scheduler and submission-council gates.
- Matched implementation area: Execution, live submission, and broker path.
- Current source evidence:
  - `services/torghut/app/trading/execution_runtime.py`
  - `services/torghut/app/trading/execution_adapters/adapter_types.py`
  - `services/torghut/app/trading/execution_policy/order_rules.py`
  - `services/torghut/app/trading/submission_council/__init__.py`
  - `services/torghut/app/trading/scheduler/pipeline/submission_policy.py`
- Design drift note: Old monolithic order executor/live path claims are stale; current source uses split execution/runtime/gate modules.


## Decision

I am selecting **a repair dividend ledger with a paper/live submission quorum** as Torghut's next architecture step.

Torghut has enough healthy surfaces to keep learning. At `2026-05-07T10:09Z`, the live revision `torghut-00252` and sim
revision `torghut-sim-00352` were both available, Postgres and ClickHouse were OK, Alpaca was OK for the live account,
the Jangar universe was fresh with 12 symbols, empirical jobs were healthy, and latest quant metrics were updating.

That evidence does not justify paper or live capital. `/trading/health` returned HTTP `503` with
`status=degraded`. The live submission gate was closed by `simple_submit_disabled`, the proof floor was `repair_only`,
capital state was `zero_notional`, and blockers were `hypothesis_not_promotion_eligible`,
`execution_tca_stale`, and `simple_submit_disabled`. TCA was last computed on `2026-04-02T20:59:45.136640Z`; average
absolute slippage was about `568.61` bps against an `8` bps guardrail; expected shortfall coverage was zero; quant
ingestion lag was `59069` seconds; forecast authority was blocked by `registry_empty`; LEAN was still a deterministic
scaffold; and no hypothesis was promotion eligible.

The selected design makes repairs compete by measurable profit dividend. A repair is not just "important" because it
removes a warning. It is valuable if it can retire a capital blocker, improve after-cost proof, reduce stale data risk,
or convert a hypothesis from shadow/blocked to promotion-eligible under a fresh Jangar repair dividend receipt.

The tradeoff is that paper reentry remains slower than a simple "empirical jobs are fresh" path. I accept that because
the fastest way to lose confidence in Torghut is to spend paper or live cycles without current after-cost and
submission evidence.

## Runtime Objective And Success Metrics

Success means:

- Torghut can keep observe and zero-notional repair active while paper/live submission stays closed.
- Repair bids name the stale proof they retire, the hypothesis they help, the expected capital-state dividend, the
  Jangar repair dividend they depend on, and the exact validation command or route.
- The repair ledger ranks TCA renewal, alpha readiness, quant ingestion, feature/drift coverage, forecast registry, and
  submission-gate work by expected profit unlock rather than static priority alone.
- Paper submission requires a quorum: fresh Jangar escrow, fresh TCA, current quant ingestion, non-zero feature/drift
  evidence for the target hypothesis, forecast authority or an explicit waiver, and the submission gate intentionally
  enabled for paper.
- Live submission requires paper settlement plus after-cost guardrails, expected shortfall coverage, Jangar live action
  allow, and no open repair lease touching capital authority.
- Deployer rollback keeps `capital_state=zero_notional` and `simple_submit_disabled` until proof recovers.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database rows, ClickHouse tables, broker
state, trading flags, AgentRun records, GitOps resources, or empirical artifacts.

### Cluster And Rollout Evidence

- `kubectl -n torghut get pods,deploy,job,cronjob -o wide --ignore-not-found` showed `torghut-00252-deployment`
  available `1/1` and `torghut-sim-00352-deployment` available `1/1`.
- Older Torghut live revisions `00247` through `00251` and sim revisions `00347` through `00351` were scaled to `0/0`.
- `torghut-db-1`, ClickHouse replicas, Keeper, TA, sim TA, options TA, options catalog, options enricher, WebSocket
  services, guardrail exporters, Alloy, and Symphony were Running.
- `torghut-db-migrations` was Running during the assessment on a newer image digest. I did not inspect or mutate the
  job beyond read-only resource listing.
- Events repeatedly reported `MultiplePodDisruptionBudgets` for ClickHouse pods and `NoPods` for the Keeper PDB, which
  means disruption policy is ambiguous even while the data plane is Running.
- The service account cannot list Knative services or PodDisruptionBudgets in `torghut`, and cannot list secrets. That
  makes typed service routes and source artifacts the available read-only evidence source for this pass.

### Runtime And Database/Data Evidence

- `GET /trading/health` returned HTTP `503` with `status=degraded`.
- The scheduler was running and outside startup readiness grace.
- Postgres, ClickHouse, Alpaca, universe, readiness cache, empirical jobs, and DSPy informational checks were OK.
- Alpaca account status was `ACTIVE` for account label `PA3SX7FYNUTF`.
- Universe source was Jangar, status `ok`, reason `jangar_fetch_ok`, `symbols_count=12`, and cache age `0`.
- Empirical jobs were healthy and non-required for readiness, with fresh jobs for
  `chip-paper-microbar-composite@execution-proof`.
- Live submission gate was `allowed=false`, reason `simple_submit_disabled`, with `capital_stage=shadow`.
- Profitability proof floor was `repair_only`, `capital_state=zero_notional`, `max_notional=0`.
- Proof-floor blockers were `hypothesis_not_promotion_eligible`, `execution_tca_stale`, and
  `simple_submit_disabled`.
- Quant evidence was not a hard blocker but was degraded: latest metrics count `144`, latest update
  `2026-05-07T10:09:11.915Z`, pipeline lag `22` seconds, stage count `3`, and max stage lag `59069` seconds.
- The quant ingestion stage was not OK, while compute and materialization were current enough to keep observation
  useful.
- TCA order count was `13775`, last computed `2026-04-02T20:59:45.136640Z`, average absolute slippage about `568.61`
  bps, slippage guardrail `8` bps, and expected shortfall sample count `0`.
- Forecast service was configured false and degraded with authority `blocked`, message `registry_empty`, no registry
  ref, and no promotion-authority eligible models.
- LEAN authority was configured but disabled with message `deterministic scaffold only`.
- Hypothesis registry was loaded from `/app/config/trading/hypotheses`; totals were `blocked=1`, `shadow=2`, zero
  promotion eligible, and three rollback required.

### Hypothesis Evidence

- `H-CONT-01` remained shadow with capital multiplier `0`, blocked by `signal_lag_exceeded` and `tca_evidence_stale`.
  It requires signal feed and TCA, with paper/live guardrails of at least `6` bps post-cost expectancy and max `12` bps
  average absolute slippage.
- `H-MICRO-01` remained blocked with capital multiplier `0`, blocked by drift checks missing, feature rows missing,
  unavailable required feature set, signal lag exceeded, and stale TCA. It requires microstructure and order-book
  liquidity features, at least `10` bps post-cost expectancy, and max `8` bps average absolute slippage.
- `H-REV-01` remained shadow with capital multiplier `0`, blocked by market context stale, signal lag exceeded, and
  stale TCA. It requires market context and signal feed, at least `8` bps post-cost expectancy, and max `12` bps
  average absolute slippage.

### Source And Test Evidence

- `services/torghut/app/main.py` has `4124` lines and currently assembles `/trading/status`, `/trading/health`, proof
  floor, TCA summary, quant evidence, forecast status, LEAN status, live submission gate, and hypothesis payloads.
- `services/torghut/app/trading/autonomy/lane.py` has `7377` lines and
  `services/torghut/app/trading/autonomy/policy_checks.py` has `6072` lines, so repair scoring should be isolated from
  the largest orchestration modules.
- `services/torghut/app/models/entities.py` has `3064` lines and is the likely persistence boundary for a future repair
  dividend ledger.
- Tests already cover autonomy evidence, gate policy contracts, feature quality, forecasting, profitability proof floor,
  TCA adaptive policy, and trading scheduler autonomy. The missing test fixture is a single repair-dividend reducer that
  ranks current blockers by after-cost capital unlock and rejects paper/live quorum when any required proof is stale.

## Problem

Torghut has a repair ladder, but it still behaves like a static priority list rather than a profit dividend ledger.

The current ladder is useful. It says live submit gate is closed, alpha readiness must be repaired, execution TCA must
be refreshed, feature coverage must be backfilled, drift governance must run, and signal freshness should be checked at
the next market open. What it does not yet express is the expected value of each repair against a target hypothesis and
capital state.

For example, stale TCA is not just a readiness warning. It directly invalidates the after-cost edge for all three
hypotheses. Quant ingestion lag is not just a pipeline warning. It decides whether a current signal can be trusted.
Forecast registry empty is not just an optional intelligence gap. It decides whether model-family expansion can support
promotion authority. The repair ledger has to rank those gaps by expected profit unlock, not only by operational
severity.

## Alternatives Considered

### Option A: Keep The Current Repair Ladder

Pros:

- Already visible in `/trading/health`.
- Correctly holds paper and live capital.
- Simple enough for deployers to inspect.

Cons:

- Static priorities can become stale as market state changes.
- It does not require every repair to name a hypothesis, guardrail, and capital dividend.
- It does not consume Jangar repair dividend receipts as settlement evidence.

Decision: reject as the complete design.

### Option B: Promote Paper Once Jangar Watch Reliability Recovers

Pros:

- Fast path to paper data.
- Uses the fact that empirical jobs are fresh and truthful.
- Gives the trading system more live-like observations.

Cons:

- Ignores stale TCA, high slippage, missing expected shortfall coverage, zero feature rows, zero drift checks, and
  forecast registry empty.
- Treats Jangar watch reliability as the only missing proof.
- Risks paper activity that cannot prove after-cost profitability.

Decision: reject.

### Option C: Repair Dividend Ledger And Submission Quorum

Pros:

- Converts every repair into an expected after-cost capital dividend.
- Keeps observation and zero-notional repair open while blocking paper/live submission.
- Consumes Jangar repair dividend receipts instead of relying on inferred control-plane recovery.
- Gives paper/live gates a quorum with explicit proof dimensions.
- Lets empirical jobs raise priority without bypassing TCA, quant ingestion, forecast, feature, drift, and submission
  checks.

Cons:

- Requires new scoring logic and persistence.
- Requires guardrail calibration to avoid arbitrary expected-value numbers.
- Requires deployers to treat a repair's business value as part of rollout evidence.

Decision: select Option C.

## Architecture

Torghut emits one repair dividend ledger per account, revision, and market window.

```text
repair_dividend_ledger
  ledger_id
  generated_at
  fresh_until
  account_label
  torghut_revision
  market_window
  jangar_escrow_ref
  proof_floor_ref
  live_submission_gate_ref
  ranked_repair_bids[]
  submission_quorum
  rollback_target
```

Each repair bid names the profit hypothesis and target capital state.

```text
repair_dividend_bid
  bid_id
  blocker_code
  hypothesis_ids[]
  proof_dimension
  current_state
  target_state
  expected_profit_dividend_bps
  expected_capital_state_unlock
  evidence_cost
  required_jangar_dividend_refs[]
  validation_refs[]
  expires_at
```

The submission quorum is explicit.

```text
submission_quorum
  paper
    jangar_escrow_fresh
    tca_fresh
    quant_ingestion_current
    feature_rows_present
    drift_checks_current
    forecast_authority_ready_or_waived
    hypothesis_promotion_eligible
    paper_submit_enabled
  live
    paper_settlement_fresh
    avg_abs_slippage_bps_within_guardrail
    expected_shortfall_coverage_present
    jangar_live_action_allow
    no_open_capital_repair_leases
    live_submit_enabled
```

## Initial Repair Ranking

The initial scoring function should be simple and auditable:

```text
score = capital_unlock_weight + hypothesis_count_weight + stale_age_weight + guardrail_distance_weight - evidence_cost
```

For the current state, this produces the following intended order:

1. Refresh execution TCA because all hypotheses cite stale TCA, slippage is far outside guardrail, and expected
   shortfall coverage is zero.
2. Restore quant ingestion currency because latest metrics are useful but ingestion lag is stale by more than sixteen
   hours.
3. Backfill feature rows and drift checks for `H-MICRO-01` because it is the only blocked hypothesis and has the
   strictest `8` bps slippage guardrail.
4. Restore or explicitly waive forecast registry authority because forecast is blocked by `registry_empty`.
5. Keep simple submission disabled until proof floor and quorum pass.
6. Verify signal freshness at the next market open before any paper quorum can pass.

This order intentionally demotes "enable submit" below proof repairs. Submission is a switch; it is not proof.

## Engineer Handoff

Implementation should be staged in four patches.

1. Add a pure `repair_dividend_ledger` reducer in Torghut that consumes proof floor, TCA, quant evidence, forecast
   authority, hypothesis payloads, signal continuity, and a Jangar escrow receipt.
2. Add route payloads in `/trading/status` and `/trading/health` while keeping the first rollout shadow-only.
3. Persist accepted repair dividends after the reducer is stable; do not start with persistence if route shape and
   scoring are still moving.
4. Add tests that reproduce the `2026-05-07T10:09Z` state and assert paper/live quorum failure with ranked repair bids.

Acceptance gates:

- With stale TCA and `simple_submit_disabled`, paper and live quorum must fail even if empirical jobs are healthy.
- With quant ingestion lag above threshold, the bid ledger must include a quant ingestion repair bid.
- With forecast `registry_empty`, the ledger must either block forecast-dependent promotion or cite an explicit waiver.
- Enabling submission without TCA and proof-floor recovery must not pass quorum.
- Accepted Jangar repair dividends may raise repair priority but may not bypass Torghut proof dimensions.

## Deployer Handoff

Rollout should stay capital-safe.

1. Deploy the ledger in shadow mode.
2. Confirm `/trading/status` exposes the ledger and `/trading/health` remains degraded while current blockers remain.
3. Confirm the top bid is a proof repair, not `simple_submit_enabled`.
4. Run TCA refresh and quant ingestion repair as zero-notional work.
5. Enable paper only after the paper quorum passes with fresh Jangar escrow and current data.
6. Enable live only after paper settlement is fresh and after-cost guardrails pass.

Rollback:

- Keep `simple_submit_disabled` true.
- Keep `capital_state=zero_notional`.
- Disable the ledger route payload only if it breaks clients; otherwise leave it in shadow for audit.
- Do not weaken the existing proof floor or live submission gate to compensate for a ledger issue.

## Validation

Local validation:

- `cd services/torghut && uv sync --frozen --extra dev`
- `cd services/torghut && uv run --frozen pytest tests/test_profitability_proof_floor.py tests/test_tca_adaptive_policy.py`
- `cd services/torghut && uv run --frozen pytest tests/test_forecast_service.py tests/test_feature_quality.py`
- `cd services/torghut && uv run --frozen pyright --project pyrightconfig.json`
- `bunx oxfmt --check docs/torghut/design-system/v6/145-torghut-repair-dividend-ledger-and-submission-quorum-2026-05-07.md`

Runtime validation after deploy:

- `curl -fsS http://torghut.torghut.svc.cluster.local/trading/status | jq '.repair_dividend_ledger'`
- `curl -sS -i http://torghut.torghut.svc.cluster.local/trading/health | sed -n '1,80p'`
- `curl -fsS http://agents.agents.svc.cluster.local/api/agents/control-plane/status?namespace=agents | jq '.controller_witness_escrow'`
- `kubectl -n torghut get pods,deploy,job -o wide --ignore-not-found`

## Risks

- Repair scoring can look objective while hiding arbitrary weights. Mitigation: keep the first scoring function small
  and expose every input.
- TCA refresh may dominate all repair bids. Mitigation: cap stale-age contribution and require target hypothesis impact.
- Forecast registry could block too much if no production model is ready. Mitigation: allow an explicit waiver for
  non-forecast hypotheses, but require the waiver in the quorum receipt.
- Jangar escrow could recover before Torghut proof recovers. Mitigation: Jangar dividends are necessary for capital but
  not sufficient.
- Submission could be enabled manually. Mitigation: proof floor and quorum must still block paper/live until all
  required dimensions pass.

## Summary For Engineer And Deployer

Do not treat a repaired control plane or fresh empirical jobs as capital permission. Torghut should rank repairs by the
profit dividend they can prove, settle those repairs against source evidence, and keep submission closed until the
paper/live quorum is current.
