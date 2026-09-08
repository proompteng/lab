# 145. Torghut Proof Renewal Leases And Capital Reentry State Market (2026-05-07)

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

I am selecting **a capital reentry state market backed by proof renewal leases** as Torghut's next quant architecture
step.

The evidence says Torghut should keep learning, but it should not spend capital. Live and sim revisions are Running.
Postgres schema checks pass. ClickHouse and Alpaca are reachable through Torghut health. Jangar dependency quorum has
recovered to `allow`. Empirical job receipts are fresh enough to guide repair work. Those facts justify observe and
zero-notional repair.

The same evidence rejects paper/live promotion. Live `/trading/health` returns HTTP `503`; proof floor is
`repair_only`; capital state is `zero_notional`; live submission is blocked by `simple_submit_disabled`; no hypothesis
is promotion eligible; all three runtime hypotheses require rollback; live TCA is from `2026-04-02T20:59:45Z`; average
absolute slippage is about `568.61` bps; order-feed event materialization has `0` live rows; and source/database
hypothesis custody is divergent because source control has three manifests while Postgres has one persisted
hypothesis.

I am not choosing a candidate-generation push. The system already has too many ways to produce candidate evidence and
not enough ways to prove which evidence is current, source-owned, and capital-safe. I am choosing a state market:
Torghut ranks proof renewal work by the capital state it can unlock, the expected profit value of the hypothesis it
protects, the age and source of the evidence, and the rollback consequence if the proof regresses.

The tradeoff is that we slow the path to paper. I accept that because paper capital without fresh TCA, feature/drift
coverage, scoped quant ingestion, source/database custody, and submission intent is not productive experimentation; it
is a noisy data spend.

## Runtime Objective And Success Metrics

Success means:

- Torghut emits one `capital_reentry_state_market` receipt per account, revision, and market window.
- Each repair bid names the expired proof lease, source of truth, expected capital state unlock, measurable profit
  hypothesis, validation command, and rollback target.
- Fresh empirical jobs can raise bid priority but cannot bypass stale TCA, source/database divergence, feature/drift
  gaps, scoped quant ingestion, order-feed reconciliation, or submission gate requirements.
- Paper canary remains blocked until all paper-required leases are current.
- Live micro canary remains blocked until paper settlement and live-required leases are current across the configured
  window.
- Deployer can disable enforcement while keeping receipts visible for audit.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database rows, ClickHouse tables, broker
state, trading flags, GitOps resources, empirical artifacts, or AgentRun records.

### Cluster And Rollout Evidence

- Argo CD reported the relevant applications Synced and Healthy, including Jangar, Agents, NATS, Torghut, Torghut
  options, and Argo Workflows.
- Torghut live `torghut-00252-deployment` and sim `torghut-sim-00352-deployment` were `2/2` Running.
- Postgres, ClickHouse, Keeper, TA, sim TA, options TA, options catalog, options enricher, WebSocket services,
  guardrail exporters, Alloy, and Symphony were Running in the `torghut` namespace.
- The database migration job was Running during the first pod read, then logs showed the app database and superuser
  database ready, Alembic completed, and simulation runtime privileges granted.
- Torghut events still had operational debt: repeated ClickHouse `MultiplePodDisruptionBudgets` warnings, a
  `torghut-ws-options` readiness `503`, and transient readiness failure on the previous live Knative revision.
- Direct pod exec is forbidden for this service account, so database evidence used the Torghut app credential over the
  Postgres service and stayed read-only.

### Runtime Evidence

- Live `GET /healthz` returned `{"status":"ok","service":"torghut"}`.
- Live `GET /db-check` returned HTTP `200`, `ok=true`, current head `0029_whitepaper_embedding_dimension_4096`, one
  schema graph root, one current head, and known parent-fork lineage warnings.
- Sim `GET /db-check` returned HTTP `200` with the same head and divergence roots explicitly allowed.
- Live `GET /trading/health` returned HTTP `503`, `status=degraded`.
- Live dependencies were mostly reachable: Postgres `ok`, ClickHouse `ok`, Alpaca `ok`, universe `ok`, empirical jobs
  `healthy`, DSPy runtime informational, and quant evidence informational.
- Live proof floor was `repair_only`, capital state `zero_notional`, max notional `0`, and blocked by
  `hypothesis_not_promotion_eligible`, `execution_tca_stale`, and `simple_submit_disabled`.
- Live quant evidence had `latest_metrics_count=144`, latest update `2026-05-07T10:10:25Z`, pipeline lag `14`
  seconds, `stage_count=3`, and max stage lag `59145` seconds because ingestion was stale.
- Live `/trading/status` reported `mode=live`, `promotion_eligible_total=0`, `rollback_required_total=3`, one blocked
  and two shadow hypotheses, and dependency quorum `allow`.
- Sim `/trading/health` returned HTTP `200`, but sim proof floor was still `repair_only`; TCA had only `7` samples and
  average absolute slippage about `17.43` bps against an `8` bps guardrail.

### Database And Data Evidence

- Live Postgres has `69` public tables.
- `trade_decisions` has `147623` rows. Latest live decision was created at `2026-05-06T17:44:19Z`; status counts were
  `63569` blocked, `69909` rejected, `13555` filled, `370` planned, `217` canceled, and `3` expired.
- `executions` has `13778` rows with latest update `2026-04-03T05:32:38Z`.
- `execution_tca_metrics` has `13775` rows with latest computed timestamp `2026-04-02T20:59:45Z` and average
  absolute slippage about `568.61` bps for the live account.
- `execution_order_events` has `0` rows, so order-feed reconciliation cannot yet support paper/live authority.
- `strategy_hypotheses` has `1` row while source control has `3` manifests in
  `services/torghut/config/trading/hypotheses`.
- `strategy_hypothesis_metric_windows` has `3` rows, all for `H-MICRO-01` in paper stage, latest window ending
  `2026-05-06T18:01:00Z`.
- `vnext_empirical_job_runs` has `20` completed, promotion-authority eligible receipts across benchmark parity,
  foundation-router parity, Janus event CAR, and Janus HGRM reward, all updated at `2026-05-06T16:27:32Z`.
- Data consistency checks found zero null decision hashes, zero unlinked order events, zero TCA rows without an
  execution, and zero inactive persisted hypotheses.

### Source And Test Evidence

- `services/torghut/app/trading/proof_floor.py` is conservative and already converts stale or degraded proof
  dimensions into `repair_only` and `zero_notional`.
- `services/torghut/app/trading/hypotheses.py` loads source-controlled manifests and compiles blockers from signal
  lag, feature rows, drift checks, evidence continuity, market context, Jangar dependency quorum, and TCA age.
- The three source manifests are H-CONT-01, H-MICRO-01, and H-REV-01. Their promotion contracts require fresh signal
  continuity, evidence continuity, feature rows or market context, drift checks, positive post-cost expectancy, and
  slippage guardrails between `8` and `12` bps.
- `services/torghut/app/main.py` composes `/trading/status`, `/trading/health`, `/db-check`, `/trading/tca`,
  `/trading/profitability/runtime`, decisions, executions, empirical jobs, and proof floor.
- Tests already cover proof floor, hypotheses, empirical jobs, TCA adaptive policy, feature quality, scheduler safety,
  runtime closure, trading API, and migration graph checks. The missing test surface is a state-market fixture tying
  stale TCA, source/DB mismatch, fresh empirical receipts, scoped quant degradation, and closed submission into one
  capital decision.

## Problem

Torghut has evidence fragments, but they are not yet organized as a capital reentry market.

The fragments are useful:

- services are reachable;
- schema is current;
- empirical receipts are present;
- Jangar quorum is currently `allow`;
- source manifests define concrete hypotheses and guardrails;
- quant compute/materialization are active.

The blockers are decisive:

- live TCA is more than a month old;
- average absolute slippage is far outside the tightest guardrail;
- order-feed reconciliation is empty;
- source/database hypothesis custody is divergent;
- feature, drift, and evidence continuity counters are not enough to promote any hypothesis;
- live submission is intentionally disabled;
- sim TCA is fresher but too small and too expensive after slippage;
- scoped live quant ingestion is stale.

Without a state market, engineers can chase whichever proof is loudest. With a state market, each proof renewal bid is
ranked by capital unlock and expected profit value.

## Alternatives Considered

### Option A: Keep The Existing Proof-Floor Repair Ladder

Pros:

- Already implemented.
- Correctly blocks capital today.
- Simple to expose in `/trading/health` and `/trading/status`.

Cons:

- It ranks repair actions locally but does not issue renewal leases with expiry and source custody.
- It does not explicitly price source/DB mismatch or order-feed absence.
- It cannot tell Jangar which proof classes are current enough for paper/live authority.

Decision: reject as the complete architecture. Keep the proof floor as the first input to the state market.

### Option B: Reopen Paper From Fresh Empirical Receipts

Pros:

- Fastest path to new observations.
- Uses the freshest positive evidence.
- Could increase sample count quickly.

Cons:

- Bypasses stale TCA and high slippage.
- Bypasses source/database custody divergence.
- Bypasses missing order-feed reconciliation.
- Bypasses feature and drift coverage gaps.
- Risks training the system on expensive, hard-to-explain paper data.

Decision: reject.

### Option C: Capital Reentry State Market Backed By Proof Renewal Leases

Pros:

- Converts every blocker into a lease with owner, expiry, and renewal command.
- Lets fresh empirical receipts increase repair priority without bypassing harder proof.
- Gives Jangar a single custody surface to consume.
- Keeps observe and repair moving while paper/live remain blocked.
- Creates measurable acceptance gates for engineer and deployer stages.

Cons:

- Requires a new Torghut route or status payload.
- Requires additive DB/source witness logic.
- Requires careful scoring so the market does not become arbitrary.

Decision: select Option C.

## Architecture

Torghut emits one `capital_reentry_state_market` receipt per account, revision, and market window.

```text
capital_reentry_state_market
  schema_version = torghut.capital-reentry-state-market.v1
  generated_at
  fresh_until
  account_label
  torghut_revision
  market_window
  current_capital_state
  proof_leases[]
  repair_bids[]
  paper_entry_passport
  live_entry_passport
  rollback_target
```

Each proof lease is a Torghut source-custody object.

```text
torghut_proof_lease
  proof_class
  source_of_truth
  source_ref
  observed_at
  fresh_until
  state                    # current, renewable, expired, contradicted, blocked, informational
  observed_value
  threshold
  capital_effect
  renewal_owner
  renewal_command_ref
  reason_codes
```

The first required proof classes are:

- `execution_tca`: current TCA samples, max age, slippage, and expected shortfall coverage.
- `order_feed_reconciliation`: materialized order feed events and linked executions.
- `hypothesis_source_db_parity`: source manifests versus persisted hypotheses and metric windows.
- `feature_coverage`: non-zero feature rows for the selected hypothesis.
- `drift_governance`: non-zero and recent drift checks for the selected hypothesis.
- `evidence_continuity`: recent evidence continuity check.
- `quant_ingestion_scope`: scoped account/window quant stages.
- `empirical_receipts`: completed and truthful vNext jobs.
- `submission_gate`: explicit paper/live submission intent.
- `jangar_state_exchange`: current Jangar proof renewal lease set.

Repair bids are ranked by expected unlock, not by subjective urgency.

```text
repair_bid
  bid_id
  lease_ref
  hypothesis_id
  target_capital_state       # observe, repair, paper_canary, live_micro, live_scale
  expected_profit_unlock_bps
  evidence_age_seconds
  sample_gap
  data_cost
  risk_penalty
  priority_score
  validation_gate
  rollback_target
```

Paper passport rules:

- TCA lease current and inside the selected hypothesis slippage guardrail.
- Source/DB hypothesis parity current.
- Feature and drift leases current for the selected hypothesis.
- Evidence continuity current.
- Scoped quant ingestion current for the account/window.
- Empirical receipts current, truthful, and source-linked.
- Submission gate intentionally configured for paper.
- Jangar trading proof renewal leases allow `paper_canary`.

Live passport rules:

- Paper passport current.
- Paper settlement has enough samples and stays inside guardrails.
- Order-feed reconciliation current and linked.
- Expected shortfall coverage present.
- Rollback lease current.
- Submission gate intentionally configured for live.
- Jangar trading proof renewal leases allow `live_micro_canary` or `live_scale`.

## Implementation Scope

Engineer scope:

1. Add a Torghut `build_capital_reentry_state_market` reducer that consumes proof floor, hypotheses, TCA summary,
   empirical job status, quant health, DB/source witness, and Jangar lease state.
2. Expose the receipt through `/trading/status` and a focused `/trading/proof-renewal` route.
3. Add a read-only DB/source witness that reports source manifest count, persisted hypothesis count, metric window
   coverage by hypothesis, order-feed event count, TCA freshness, and empirical job freshness.
4. Add a TCA renewal bid that can be validated without enabling paper/live submission.
5. Add source/DB parity repair instructions for seeding or reconciling missing hypothesis rows.
6. Add tests for:
   - fresh empirical receipts with expired TCA;
   - source manifests `3` versus persisted hypotheses `1`;
   - zero order-feed reconciliation rows;
   - scoped quant ingestion stale while compute/materialization are current;
   - sim health green but paper passport blocked by slippage and sample count;
   - paper/live passports blocked while observe/repair remain allowed.

Deployer scope:

1. Treat `/trading/proof-renewal` as shadow-only until the Jangar lease set is also shadowing.
2. Do not enable paper submission from empirical receipts alone.
3. Require a current paper passport before paper canary and a current live passport before live.
4. Keep rollback target `zero_notional` until paper/live leases stay current through the configured validation window.

## Validation Gates

Local validation:

- `bunx oxfmt --check docs/torghut/design-system/v6/145-torghut-proof-renewal-leases-and-capital-reentry-state-market-2026-05-07.md`
- `cd services/torghut && uv run --frozen pytest tests/test_profitability_proof_floor.py tests/test_hypotheses.py tests/test_empirical_jobs.py`
- `cd services/torghut && uv run --frozen pytest tests/test_trading_api.py -k proof`

Cluster validation:

- `GET /trading/proof-renewal` returns a receipt for live and sim.
- Live receipt shows observe/repair allowed and paper/live blocked for stale TCA, source/DB parity, feature/drift,
  scoped quant ingestion, and submission gate reasons.
- Sim receipt shows paper blocked until slippage guardrail and sample requirements pass.
- Receipt cites Jangar lease state and does not treat Jangar quorum `allow` as capital permission.

Database validation:

- TCA renewal makes latest `execution_tca_metrics.computed_at` current before any paper passport is issued.
- Source/DB parity repair makes persisted hypothesis coverage match source manifests before any paper passport is
  issued.
- Order-feed reconciliation has materialized linked events before any live passport is issued.
- All checks remain read-only until an engineer/deployer task explicitly owns repair implementation.

## Rollout Plan

1. Land the state-market reducer shadow-only.
2. Expose `/trading/proof-renewal` and embed a summarized receipt in `/trading/status`.
3. Run two market sessions comparing proof-floor repair ladder, state-market bids, and Jangar lease actions.
4. Enable warnings when paper/live would bypass a missing or expired lease.
5. Enable hard paper holds.
6. Enable live holds only after paper settlement validates the state-market passport.

## Rollback Plan

- Disable state-market enforcement with `TRADING_PROOF_RENEWAL_MARKET_ENABLED=false` while leaving the payload visible
  if possible.
- Keep proof floor as the capital authority during rollback.
- Set target capital state to `zero_notional`.
- Do not delete evidence rows or mutate historical TCA/empirical data.
- If the route payload regresses, remove the additive route from deployer checks and continue using `/trading/health`
  and `/trading/status`.

## Risks And Mitigations

- Risk: the state market creates a scoring system that looks precise before it is calibrated.
  Mitigation: score only by documented inputs and shadow for two sessions before enforcement.
- Risk: empirical receipts are overweighted because they are fresh.
  Mitigation: empirical receipts can raise repair priority but cannot satisfy TCA, feature, drift, parity, or submission
  leases.
- Risk: source/DB parity repair becomes a seeding side quest.
  Mitigation: classify it as a paper/live prerequisite and keep observe/repair available while it is renewable.
- Risk: engineers conflate sim health with paper readiness.
  Mitigation: sim receipt must carry its own slippage and sample-count blockers.

## Handoff Contract

Engineer acceptance gates:

- `capital_reentry_state_market` exists and is covered by focused tests.
- State-market output preserves current proof-floor behavior for live capital.
- Fresh empirical jobs plus stale TCA keeps paper/live blocked.
- Source/DB hypothesis divergence is visible and blocks paper/live.
- Scoped quant ingestion is required for capital passports.

Deployer acceptance gates:

- Shadow receipts are captured from live and sim before enforcement.
- Paper canary remains off until the paper passport is current.
- Live remains off until paper settlement, order-feed reconciliation, rollback, TCA, and Jangar live leases are current.
- Rollback returns to proof-floor-only `zero_notional` without data mutation.
