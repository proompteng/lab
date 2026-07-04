# 147. Torghut Proof Escrow Hypothesis Repair And Capital Settlement (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Victor Chen, Jangar Engineering
Scope: Torghut profitability, Jangar evidence escrow consumption, hypothesis repair ranking, paper/live capital
settlement, validation, rollout, and rollback.

Companion Jangar contract:

- `docs/agents/designs/143-jangar-least-privilege-evidence-escrow-and-capital-proof-settlement-2026-05-07.md`

Extends:

- `146-torghut-submission-quorum-handoff-and-profit-repair-gates-2026-05-07.md`
- `145-torghut-repair-dividend-ledger-and-submission-quorum-2026-05-07.md`
- `144-torghut-state-coherent-profit-auction-and-tca-renewal-governor-2026-05-07.md`
- `140-torghut-post-cost-alpha-reentry-and-proof-query-market-2026-05-07.md`

## Decision

I am selecting **proof escrow hypothesis repair with capital settlement** as Torghut's next profitability architecture
increment.

Torghut is operationally alive but not capital-qualified. At `2026-05-07T11:25Z`, live revision `torghut-00254` and
sim revision `torghut-sim-00354` were available, Postgres and ClickHouse were OK, Alpaca account `PA3SX7FYNUTF` was
`ACTIVE`, the Jangar universe was fresh with `12` symbols, empirical jobs were healthy, and quant latest metrics were
present with `144` rows. The route still returned `status=degraded`, live submission was closed by
`simple_submit_disabled`, the proof floor was `repair_only`, capital state was `zero_notional`, and max notional was
`0`.

The current blockers are specific enough to treat as a portfolio, not a generic outage. Three hypotheses are loaded.
`H-CONT-01` and `H-REV-01` are shadow-only, `H-MICRO-01` is blocked, zero hypotheses are promotion eligible, and all
three require rollback. TCA is stale from `2026-04-02T20:59:45.136640Z`, average absolute slippage is about
`568.61` bps against an `8` bps guardrail, signal lag is about `51,996` seconds against a `90` second entry contract,
feature rows are `0`, drift checks are `0`, and market context is stale.

The decision is to turn proof repair into an escrowed hypothesis repair portfolio. Torghut should keep observe and
zero-notional repair open, but paper and live capital must consume a fresh Jangar evidence escrow plus Torghut's own
hypothesis repair settlement. A repair only earns capital credit when it retires a named blocker, improves an explicit
metric, and leaves a route-readable settlement receipt.

The tradeoff is slower paper reentry. I accept that because the faster path creates paper samples that are not useful
for profit qualification.

## Runtime Objective And Success Metrics

Success means:

- Torghut can run observe and zero-notional proof repair while paper/live submission stays closed.
- Every repair bid is tied to hypothesis IDs, blocker codes, expected capital unlock, expected after-cost dividend, and
  validation evidence.
- Paper submission requires a fresh Jangar `control_plane_evidence_escrow` ref and a Torghut settlement where all
  paper quorum members pass.
- Live submission requires paper settlement, after-cost guardrails, expected shortfall coverage, fresh execution TCA,
  fresh market context where required, and explicit live submit enablement.
- Repairs are ranked by expected after-cost capital unlock, not by static warning severity.
- Closed-market signal staleness is carried as a market-window condition, not silently promoted to live capital.
- Rollback preserves `capital_state=zero_notional` and `simple_submit_disabled`.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database rows, ClickHouse tables, broker
state, trading flags, AgentRun records, GitOps resources, or empirical artifacts.

### Cluster And Runtime Evidence

- `deployment/torghut-00254-deployment` was available `1/1`; older live revisions `00249` through `00253` were scaled
  to `0/0`.
- `deployment/torghut-sim-00354-deployment` was available `1/1`; older sim revisions `00349` through `00353` were
  scaled to `0/0`.
- `torghut-db-1`, both ClickHouse replicas, Keeper, TA, sim TA, options TA, options catalog, options enricher,
  websocket services, Alloy, Symphony, and guardrail exporters were running.
- Recent events showed startup readiness probe failures during revision rollout and repeated ClickHouse
  `MultiplePodDisruptionBudgets` warnings plus a Keeper PDB with no matching pods.
- The empirical artifact retention CronJob completed about seven hours before the assessment.

### Trading Health Evidence

- `GET http://torghut.torghut.svc.cluster.local/trading/health` returned `status=degraded`.
- Dependencies reported:
  - Postgres `ok=true`;
  - ClickHouse `ok=true`;
  - Alpaca `ok=true`, account label `PA3SX7FYNUTF`, account status `ACTIVE`;
  - universe `ok=true`, source `jangar`, reason `jangar_fetch_ok`, `symbols_count=12`, cache age `0`;
  - empirical jobs `ok=true`, authority `empirical`, `required=false`;
  - quant evidence `ok=true`, required `false`, window `15m`, detail `quant_pipeline_stages_missing`.
- Live submission gate was `allowed=false`, reason `simple_submit_disabled`, `capital_stage=shadow`, and
  `promotion_eligible_total=0`.
- Proof floor was `repair_only`, `capital_state=zero_notional`, `max_notional=0`, with blockers
  `hypothesis_not_promotion_eligible`, `execution_tca_stale`, `market_context_stale`, and
  `simple_submit_disabled`.
- Quant control-plane health for account `PA3SX7FYNUTF`, window `15m`, reported `status=ok`,
  `latestMetricsCount=144`, `emptyLatestStoreAlarm=false`, `missingUpdateAlarm=false`, and
  `metricsPipelineLagSeconds=2`; route-level proof still showed pipeline stages missing.
- Direct Torghut DB and CNPG checks were blocked by RBAC: no `pods/exec` in namespace `torghut` and no CNPG cluster get
  permission.

### Hypothesis And Profit Evidence

- Hypothesis registry loaded from `/app/config/trading/hypotheses` with no registry errors.
- Summary: `hypotheses_total=3`, state totals `blocked=1`, `shadow=2`, `promotion_eligible_total=0`,
  `rollback_required_total=3`, and dependency quorum `allow`.
- `H-CONT-01` (`intraday_continuation`) is shadow-only with reasons `signal_lag_exceeded` and `tca_evidence_stale`.
  Its entry contract requires max signal lag `90` seconds and minimum feature rows `1`; observed signal lag was about
  `51,996` seconds and feature rows were `0`.
- `H-MICRO-01` (`microstructure_breakout`) is blocked with reasons `drift_checks_missing`,
  `feature_rows_missing`, `required_feature_set_unavailable`, `signal_lag_exceeded`, and `tca_evidence_stale`.
  Its promotion contract requires at least `10` bps post-cost expectancy and max average slippage `8` bps.
- `H-REV-01` (`event_reversion`) is shadow-only with reasons `market_context_stale`, `signal_lag_exceeded`, and
  `tca_evidence_stale`. Its entry contract requires market-context freshness within `120` seconds.
- TCA evidence spans `13,775` orders but was last computed on `2026-04-02T20:59:45.136640Z`; TCA age was about
  `49,825` minutes.
- Average absolute slippage was about `568.61` bps against an `8` bps guardrail.
- The current post-cost expectancy proxy was positive at about `13.78` bps, which is useful only after TCA freshness,
  signal freshness, feature coverage, drift, and market context blockers are repaired.

### Source Evidence

- `services/torghut/app/main.py` assembles `/trading/health`, `/trading/status`, alpha readiness, live submission gate,
  and proof floor payloads.
- `services/torghut/app/trading/proof_floor.py` builds the proof-floor receipt and static repair ladder.
- `services/torghut/app/trading/submission_council.py` builds the live submission gate and blocks on promotion
  eligibility.
- `services/torghut/app/trading/hypotheses.py` is the current hypothesis summary and registry boundary.
- `services/torghut/app/trading/scheduler/simple_pipeline.py` already blocks live submission on the proof floor before
  submitting orders.
- `services/torghut/app/trading/autonomy/policy_checks.py` and `services/torghut/app/trading/autonomy/lane.py` are
  large orchestration modules; the repair portfolio reducer should not be embedded there.
- There are `31` Alembic version files through `0029_whitepaper_embedding_dimension_4096.py`, but runtime route
  evidence does not expose a least-privilege schema-quality settlement comparable to Jangar's Kysely projection.

## Problem

Torghut has enough proof surfaces to say exactly why capital is closed, but it does not yet turn those surfaces into a
ranked repair portfolio that can be settled against Jangar control-plane evidence.

The current failure modes are:

1. **Operational liveness can be mistaken for capital readiness.** Postgres, ClickHouse, Alpaca, universe, and empirical
   jobs are green while the proof floor correctly stays repair-only.
2. **Repair ranking is too coarse.** The proof-floor ladder names blocker classes but does not bind a repair to
   hypothesis IDs, expected dividend, settlement evidence, or capital unlock.
3. **Jangar proof is not consumed as escrow.** Torghut dependency quorum is green, but capital needs a fresh Jangar
   escrow receipt with database, schema, ingestion, watch, and Torghut consumer members.
4. **A positive expectancy proxy is not enough.** The current `13.78` bps proxy cannot override stale TCA, large
   slippage, stale signals, missing features, missing drift checks, or stale market context.
5. **Least-privilege validation is the normal operating model.** A paper/live gate cannot depend on direct DB shell,
   ClickHouse shell, or CNPG inspection.

## Alternatives Considered

### Option A: Use The Existing Proof-Floor Repair Ladder As The Capital Roadmap

Pros:

- Already deployed.
- Names the main blockers.
- Keeps route shape small.

Cons:

- Does not bind blockers to hypotheses and metrics.
- Does not consume a Jangar escrow ref.
- Does not produce settlement receipts that paper/live gates can cite.

Decision: reject.

### Option B: Reopen Paper For One Micro-Notional Experiment Because Empirical Jobs Are Healthy

Pros:

- Fast new market observations.
- Tests the live route plumbing.
- Uses the positive post-cost expectancy proxy.

Cons:

- Paper evidence would be contaminated by stale TCA, stale signals, missing features, missing drift, and stale market
  context.
- The Jangar escrow member for Torghut consumer proof does not exist yet.
- It bypasses the explicit live submission disablement.

Decision: reject.

### Option C: Proof Escrow Hypothesis Repair And Capital Settlement

Pros:

- Keeps zero-notional learning open while preserving capital safety.
- Prices repair work by expected capital unlock and after-cost dividend.
- Requires fresh Jangar escrow before paper/live settlement.
- Gives deployers one route-readable proof object for paper and live gates.
- Separates closed-market stale-signal handling from true data-plane failure.

Cons:

- Adds a reducer and a new route shape.
- Requires calibration of expected dividend scoring.
- Keeps paper closed until multiple proof members are repaired.

Decision: select Option C.

## Architecture

Torghut emits one repair portfolio settlement per account, market window, and revision.

```text
proof_escrow_hypothesis_repair_settlement
  settlement_id
  generated_at
  fresh_until
  account_label
  torghut_revision
  market_window
  jangar_evidence_escrow_ref
  proof_floor_ref
  live_submission_gate_ref
  hypothesis_repair_bids[]
  paper_capital_quorum
  live_capital_quorum
  rollback_target
```

Each repair bid is measurable.

```text
hypothesis_repair_bid
  bid_id
  hypothesis_ids[]
  blocker_codes[]
  proof_dimension
  current_metric
  target_metric
  expected_after_cost_dividend_bps
  expected_capital_unlock          # observe | shadow | paper | live_micro | live_scale
  validation_refs[]
  required_jangar_member_ids[]
  expires_at
```

Initial repair bid examples:

- `repair_tca_freshness`: applies to all three hypotheses; target TCA age less than `30` minutes for paper and less
  than `1` trading session for shadow proof; must reduce effective slippage below each promotion contract.
- `repair_signal_continuity`: applies to `H-CONT-01`, `H-MICRO-01`, and `H-REV-01`; target signal lag less than
  `90` seconds during market hours.
- `repair_feature_coverage`: applies first to `H-MICRO-01`; target at least one current microstructure and
  order-book-liquidity feature batch.
- `repair_drift_governance`: applies first to `H-MICRO-01`; target at least one current drift check and no blocking
  drift alert.
- `repair_market_context`: applies to `H-REV-01`; target freshness less than `120` seconds during market hours.
- `repair_jangar_consumer_escrow`: applies to paper/live quorum; target one fresh Jangar escrow with accepted Torghut
  consumer member for the account/window/hypothesis set.

## Capital Quorum

Paper quorum requires:

- Jangar evidence escrow is fresh and not in `block` for Torghut consumer proof.
- Proof floor is not `repair_only`.
- Live submission gate may remain disabled, but paper submission intent must be explicit.
- TCA age is within the paper threshold and slippage is inside the hypothesis promotion contract.
- Signal lag is inside the entry contract during market hours.
- Required feature sets and drift checks are present.
- Market context is fresh for hypotheses that require it.
- At least one hypothesis is promotion eligible for paper.

Live quorum requires all paper members plus:

- Paper settlement for the same hypothesis and account is accepted.
- Expected shortfall and drawdown guardrails pass.
- Live submit is explicitly enabled.
- Jangar live action settlement allows `live_micro_canary`.
- No open repair bid touches a live-blocking proof dimension.

## Implementation Scope

Engineer lane:

1. Add a reducer next to `proof_floor.py`, not in the autonomy lane.
2. Project `proof_escrow_hypothesis_repair_settlement` from `/trading/health` and `/trading/status`.
3. Add a client for Jangar `evidence_escrow` with timeout and stale-cache behavior.
4. Persist optional settlement summaries only after route-level shadow output is stable.
5. Add tests for:
   - current state: zero-notional repair only, paper/live blocked;
   - fresh Jangar escrow but stale TCA: paper held;
   - fresh TCA but missing feature/drift for `H-MICRO-01`: paper held for that hypothesis;
   - market closed signal staleness: observe allowed, capital unchanged;
   - all paper quorum members pass: paper canary allowed in shadow only unless paper submit is explicitly enabled.

Deployer lane:

1. Roll out in shadow mode.
2. Capture `/trading/health`, `/trading/status`, Jangar `evidence_escrow`, and quant health before and after rollout.
3. Confirm `capital_state=zero_notional` and `simple_submit_disabled` remain unchanged.
4. Enable paper settlement only after at least one hypothesis has current TCA, signal, feature/drift or market context
   evidence, and a fresh Jangar escrow ref.
5. Do not enable live settlement in this architecture stage.

## Validation Gates

Local:

- `uv run --frozen pytest services/torghut/tests/test_trading_pipeline.py -k "proof_floor or live_submission_gate"`
- `uv run --frozen pytest services/torghut/tests/test_verify_quant_readiness.py`
- `uv run --frozen ruff check services/torghut/app/trading services/torghut/tests`

Route:

- `curl -fsS http://torghut.torghut.svc.cluster.local/trading/health | jq '.proof_escrow_hypothesis_repair_settlement'`
- `curl -fsS http://torghut.torghut.svc.cluster.local/trading/status | jq '.hypotheses.summary'`
- `curl -fsS 'http://jangar.jangar.svc.cluster.local/api/torghut/trading/control-plane/quant/health?account=PA3SX7FYNUTF&window=15m' | jq .`
- `curl -fsS 'http://agents.agents.svc.cluster.local/api/agents/control-plane/status?namespace=agents' | jq '.evidence_escrow'`

Capital:

- Paper remains closed when `promotion_eligible_total=0`.
- Paper remains closed when TCA age exceeds threshold or average slippage exceeds the hypothesis guardrail.
- Paper remains closed when the Jangar escrow ref is missing, stale, or blocking Torghut consumer proof.
- Live remains closed unless paper settlement exists and live submit is explicitly enabled.

## Rollout

1. Add route-only settlement in shadow mode.
2. Render the settlement in Jangar/Torghut control-plane views after payload stability.
3. Add deployer capture to release verification.
4. Use the settlement to rank zero-notional repair work.
5. Enable paper settlement enforcement only after Jangar escrow is available and one hypothesis clears paper quorum.

## Rollback

- Disable settlement enforcement and keep the route in shadow.
- Preserve `capital_state=zero_notional`, `simple_submit_disabled`, and proof-floor blocks.
- Fall back to the existing proof-floor ladder for repair ordering.
- Keep Jangar escrow fetch failures informational until the shadow route is stable.
- If the reducer increases route latency, cache settlement per account/window and expose stale age in the payload.

## Risks And Open Questions

- Expected dividend scoring must not become a vanity number. The first scoring function should be simple: expected
  capital-state unlock, blocker count retired, and after-cost expectancy only after stale proof is repaired.
- Closed-market signal lag needs session-aware handling. It should block capital but not consume emergency budget when
  the market is closed.
- Jangar escrow fetch failures can create circular dependency if Torghut status depends on Jangar and Jangar consumes
  Torghut. Use bounded timeouts and stale-cache evidence.
- Feature and drift repairs may need new persistence or route summaries before they can be settled without DB access.

## Handoff Contract

Engineer accepts this work when:

- `/trading/health` and `/trading/status` expose the settlement in shadow mode.
- Tests prove the current evidence keeps paper/live closed.
- Each repair bid names hypothesis IDs, metric targets, and validation refs.
- Jangar escrow absence or staleness blocks paper/live but does not block observe or zero-notional repair.

Deployer accepts this work when:

- Shadow settlement is captured during rollout.
- `simple_submit_disabled` and `capital_state=zero_notional` are unchanged after rollout.
- Paper is not enabled until one hypothesis has fresh TCA, signal, required feature/drift or market context evidence,
  and a fresh Jangar escrow ref.
- Live remains out of scope for enforcement in this stage.
