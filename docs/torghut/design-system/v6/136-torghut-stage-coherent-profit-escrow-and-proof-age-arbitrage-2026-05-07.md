# 136. Torghut Stage-Coherent Profit Escrow And Proof-Age Arbitrage (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Gideon Park, Torghut Traders Architecture
Scope: Torghut quant profitability, stage-coherent capital admission, proof-age settlement, read-only data quality
evidence, Jangar dependency quorum consumption, repair hypotheses, rollout gates, rollback, and deployer handoff.

Companion Jangar contract:

- `docs/agents/designs/132-jangar-stage-freshness-escrow-and-capital-authority-reclocking-2026-05-07.md`

Extends:

- `135-torghut-capital-qualified-alpha-router-and-execution-repair-ladder-2026-05-06.md`
- `134-torghut-profitability-proof-floor-and-evidence-repair-market-2026-05-06.md`
- `129-torghut-bidirectional-quant-proof-receipts-and-profit-reentry-ledger-2026-05-06.md`
- `127-torghut-fillability-first-alpha-reentry-and-observation-backed-proof-exchange-2026-05-06.md`

## Decision

I am selecting **stage-coherent profit escrow with proof-age arbitrage** as the next Torghut quant architecture step.

The current system is safer than it was on May 5, but it is still not allowed to spend capital. On the read-only
sample from `2026-05-07T04:55Z`, Torghut live and sim were both serving the latest `00250` revisions, the scheduler,
Postgres, ClickHouse, Alpaca broker, database, universe, and empirical jobs were route-healthy, and Jangar plus the
agents controllers were rolled out. Jangar's collaboration runtime kit also proved that `codex-nats-publish`,
`codex-nats-soak`, and `nats` are present, which closes the earlier missing-NATS runtime-kit defect.

The blocking evidence is now more subtle. Jangar dependency quorum is `delay`, not `allow`, because execution trust is
degraded: discover, plan, implement, and verify stages for the Jangar control-plane lane are stale. Torghut `/readyz`
is still HTTP `503` with status `degraded`. Live submission is closed by `simple_submit_disabled`, capital is
`shadow`, and the profitability proof floor is `repair_only` with `max_notional=0`. The proof floor blocks on
`hypothesis_not_promotion_eligible`, `execution_tca_stale`, and `simple_submit_disabled`.

The data plane confirms why a fresh empirical proof is not enough. Read-only Postgres showed current Alembic head
`0029_whitepaper_embedding_dimension_4096`, `147623` trade decisions, `13778` executions, `13775` TCA metric rows,
one active persisted hypothesis (`H-MICRO-01`), and three persisted metric windows from `2026-05-06`. Those windows
record `dependency_quorum_decision=allow`, `capital_stage=shadow`, and one six-minute paper window with five orders
and `24.304747534` bps average absolute slippage. That is useful evidence, but it is not current authority because
Jangar's live dependency quorum is now `delay`.

ClickHouse gives the same warning in another shape. `ta_microbars` and `ta_signals` are populated, with about
`1.75M` and `1.17M` rows respectively, but their newest ingest timestamp is `2026-05-06T20:59:37Z`, about `28699`
seconds old at the sample. Jangar quant health reports `latestMetricsCount=144`, fresh compute, and no missing-update
alarm, but the scoped ingestion stage is unhealthy with about `40265` seconds of lag and materialization is also
unhealthy. The options feature lane is worse: `options_contract_bars_1s`, `options_contract_features`, and
`options_surface_features` are all empty.

The selected design refuses to let any proof window, empirical job, metric window, or paper outcome carry capital
authority unless it can be reconciled against the current Jangar stage freshness epoch. Torghut may still use stale
or partially stale evidence to rank repair work. It may not use it to authorize paper widening, live micro canaries,
or live scale. Proof-age arbitrage is the repair loop: when evidence is stale but otherwise promising, Torghut assigns
zero-notional repair capital to the stale proof that has the highest expected unblock value per minute of repair time.

The tradeoff is that Torghut will sometimes hold a profitable-looking candidate after it just produced a good paper
window. I accept that. A candidate that only looks profitable under yesterday's Jangar authority and yesterday's
ClickHouse ingest is not a capital candidate. It is a repair candidate.

## Runtime Objective And Success Metrics

This contract increases profitability by making proof freshness itself a priced input to the alpha router. It
increases reliability by making stale Jangar stages and stale data-plane rows invalidate capital authority without
blocking zero-notional repair.

Success means:

- Every paper or live candidate carries a `stage_coherence_epoch` issued by Jangar.
- Torghut rejects capital authority when the current Jangar dependency quorum is `delay`, `block`, or `unknown`, even
  if a persisted metric window recorded an earlier `allow`.
- Persisted metric windows can rank repair priority, but cannot authorize capital after their Jangar epoch expires.
- Quant ingestion lag above threshold is capital-blocking for promotion, not merely informational, once a candidate
  requests paper or live notional.
- Market-context status with `last_freshness_seconds=null` is treated as `unknown`, not `pass`, for any action that
  depends on LLM review, news, fundamentals, regime, or event context.
- Empty options feature tables block options sleeves and hedged execution experiments from capital admission.
- The proof-age arbitrage loop emits zero-notional repair intents with measurable expected unblock value.
- A deployer can validate the gate without pod exec, Secret reads, or database writes by using Jangar status, Torghut
  status/readyz/db-check, read-only Postgres, read-only ClickHouse, and GitHub CI evidence.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database records, ClickHouse rows, broker
state, trading flags, empirical artifacts, or GitOps manifests.

### Cluster And Rollout Evidence

- Workspace branch was `codex/swarm-torghut-quant-discover` at `origin/main`
  `6c84303fe chore(jangar): promote image 39c27b12 (#5775)` before edits.
- `kubectl config current-context` was initially unset; I bootstrapped the in-cluster context from the mounted service
  account and verified identity as `system:serviceaccount:agents:agents-sa`.
- Torghut live `torghut-00250-deployment-68df6ccfd8-nqdm2` was `2/2 Running`; Torghut sim
  `torghut-sim-00350-deployment-6bdbbd5669-k9gmc` was `2/2 Running`.
- Recent Torghut rollout events show DB migrations completed, revisions `torghut-00250` and `torghut-sim-00350`
  created and ready, previous `00249` revisions scaled down, and transient startup/readiness probe failures during
  warmup.
- Torghut supporting services were running: ClickHouse replicas, Keeper, Postgres, TA, sim TA, options TA, options
  catalog, options enricher, websocket services, guardrail exporters, Alloy, and Symphony.
- Recent Torghut events still show `MultiplePodDisruptionBudgets` warnings for both ClickHouse pods, with the
  controller choosing a PDB arbitrarily. RBAC forbids listing PodDisruptionBudgets, so Jangar must project this as
  event evidence rather than requiring direct PDB inspection.
- Jangar `jangar-56bdb9885b-dss9q` was `2/2 Running`; Jangar DB, Redis, Open WebUI, Bumba, Alloy, and Symphony pods
  were running.
- Agents `agents-664f557846-twfrz` and both `agents-controllers-8459c79974` pods were running.
- Agents events show older cron-run jobs failing across Jangar and Torghut swarm lanes, while current manual and
  scheduled jobs were completing or running. The current Jangar status summarizes the last 15 minutes as
  `recent_failed_jobs=0`.
- RBAC allows named Secret reads but forbids pod exec, statefulset listing, PDB listing, and CNPG cluster listing in
  `torghut`. Validation cannot depend on privileged shell access.

### Route And Control-Plane Evidence

- Jangar `/health` returned HTTP `200`.
- Jangar `/api/agents/control-plane/status?namespace=agents` at `2026-05-07T04:55:41Z` reported:
  - `dependency_quorum.decision=delay`
  - reason `execution_trust_degraded`
  - healthy agents, supporting, and orchestration controller heartbeats
  - workflow, job, and temporal runtime adapters configured
  - runtime kit `collaboration` healthy with `codex-nats-publish`, `codex-nats-soak`, and `nats` present
  - rollout health healthy for `agents` and `agents-controllers`
  - execution trust degraded because Jangar discover, plan, implement, and verify stages are stale
- Torghut `/healthz` returned HTTP `200`.
- Torghut `/readyz` returned HTTP `503` with status `degraded`.
- Torghut readiness dependencies were route-healthy for scheduler, Postgres, ClickHouse, Alpaca, database, universe,
  and empirical jobs.
- Torghut readiness was degraded because live submission was closed, profitability proof floor was `repair_only`, and
  quant evidence was degraded.
- `/trading/status` reported `mode=live`, live submission gate `allowed=false`, reason `simple_submit_disabled`,
  `capital_stage=shadow`, `configured_live_promotion=false`, `promotion_eligible_total=0`, proof floor
  `capital_state=zero_notional`, and `max_notional=0`.
- The proof floor blocked on `hypothesis_not_promotion_eligible`, `execution_tca_stale`, and
  `simple_submit_disabled`.
- Jangar quant health for account `PA3SX7FYNUTF`, window `15m`, returned `status=degraded`,
  `latestMetricsCount=144`, latest metrics updated at `2026-05-07T04:55:40Z`, compute lag `1` second, ingestion lag
  about `40265` seconds, materialization lag `16-17` seconds, and `maxStageLagSeconds=40265`.
- Torghut empirical jobs were healthy and promotion-authority eligible for `benchmark_parity`,
  `foundation_router_parity`, `janus_event_car`, and `janus_hgrm_reward`, all tied to candidate
  `chip-paper-microbar-composite@execution-proof` and dataset `torghut-chip-full-day-20260505-5e447b6d-r1`.
- `/trading/tca` reported `13775` orders, average absolute slippage `568.6138848199565` bps, and
  `last_computed_at=2026-04-02T20:59:45Z`.
- Recent `/trading/decisions` samples were blocked decisions on `2026-05-06T17:29Z-17:44Z` for the
  `microbar_cross_sectional_entry` continuation strategy.
- Recent `/trading/executions` samples were canceled April orders; no current execution sample proves fresh fillability.

### Database And Data Evidence

- `/db-check` reported `ok=true`, `schema_current=true`, and expected/current Alembic head
  `0029_whitepaper_embedding_dimension_4096`.
- `/readyz` reported schema graph lineage ready, with parent-fork warnings at:
  - `0010_execution_provenance_and_governance_trace`
  - `0015_whitepaper_workflow_tables`
- Read-only Postgres through `torghut-db-app` ran as `torghut_app` against database `torghut` at
  `2026-05-07T04:59:00Z`.
- Postgres counts/freshness:
  - `trade_decisions`: `147623` rows, newest `2026-05-06T17:44:19Z`, about `40481` seconds old
  - `executions`: `13778` rows, newest `2026-04-02T20:59:45Z`, about `2966355` seconds old
  - `execution_tca_metrics`: `13775` rows, newest `2026-04-02T20:59:45Z`, about `2966355` seconds old
  - `strategy_hypotheses`: `1` row, newest `2026-05-06T22:34:19Z`
  - `strategy_hypothesis_metric_windows`: `3` rows, newest `2026-05-06T18:01:00Z`
  - `vnext_empirical_job_runs`: `20` rows, newest `2026-05-06T16:27:32Z`
  - `autoresearch_epochs` and `autoresearch_candidate_specs`: `0` rows
- The active persisted hypothesis row is `H-MICRO-01`, lane `microstructure-breakout`, family
  `microstructure_breakout`.
- The three persisted metric windows are paper/shadow windows for candidate
  `chip-paper-microbar-composite@execution-proof`. The most recent window ended `2026-05-06T18:01Z` with `5`
  decisions, `5` trades, `5` orders, `dependency_quorum_decision=allow`, `capital_stage=shadow`,
  `avg_abs_slippage_bps=24.304747534`, and `post_cost_expectancy_bps=24.304747534`.
- ClickHouse tables:
  - `ta_microbars`: `1749621` rows, newest ingest `2026-05-06T20:59:37Z`, about `28699` seconds old
  - `ta_signals`: `1165933` rows, newest ingest `2026-05-06T20:59:37Z`, about `28699` seconds old
  - `options_contract_bars_1s`: `0` rows
  - `options_contract_features`: `0` rows
  - `options_surface_features`: `0` rows
- Direct ClickHouse without credentials returns `REQUIRED_PASSWORD`; direct Postgres pod exec and CNPG listing are
  forbidden. The read-only assessment used application credentials and no database writes.

### Source Evidence

- `services/torghut/app/main.py` is `4124` lines and still owns many control-plane projections: readiness, db-check,
  trading status, proof floor, empirical jobs, TCA, decisions, executions, and quant evidence.
- `services/torghut/app/trading/submission_council.py` is `1199` lines and already joins dependency quorum, empirical
  proof, quant evidence, market context, promotion evidence, and TCA into gate payloads.
- `services/torghut/app/trading/proof_floor.py` is `558` lines and already emits a conservative zero-notional proof
  floor with ranked repair ladder.
- `services/torghut/app/trading/hypotheses.py` is `764` lines and already turns dependency quorum, market context,
  missing feature rows, drift checks, and signal lag into blocker reasons.
- `services/torghut/app/trading/empirical_jobs.py` is `561` lines and verifies freshness, truthfulness, candidate ids,
  dataset refs, artifact refs, and promotion authority.
- `services/jangar/src/server/control-plane-status.ts` is `781` lines and already emits dependency quorum, execution
  trust, runtime kits, rollout health, and negative evidence.
- Torghut has `152` test files, including targeted tests for proof floor, submission council, hypotheses, empirical
  jobs, market context, TCA policy, quant readiness, profitability evidence, and strategy runtime.
- The missing layer is not another raw health endpoint. It is a stage-coherence reducer that reconciles persisted proof
  windows with the current Jangar stage epoch before those windows can influence capital.

## Problem

Torghut now has enough proof surfaces to look disciplined, but the proof surfaces disagree about time.

The dangerous gap is not that Torghut ignores stale data entirely. The proof floor already catches stale TCA and keeps
notional at zero. The gap is that several stale or nullable surfaces are still treated as informational, pass-like, or
historically authoritative:

1. Persisted metric windows can record `dependency_quorum_decision=allow` while current Jangar dependency quorum is
   `delay`.
2. Quant ingestion can be unhealthy for more than ten hours while `quant_evidence.required=false` leaves it
   non-blocking.
3. Market-context freshness can be `null` and still appear as a pass for the current proof floor.
4. Fresh empirical jobs can outrun stale execution proof and stale TA ingest.
5. Options infrastructure can be running while every options feature table is empty.
6. Source ownership is concentrated in large reducers, so humans can misread the live state unless the system emits one
   stage-coherent receipt.

Profitability requires the system to know the difference between **profitable if refreshed** and **profitable enough to
receive capital now**.

## Alternatives Considered

### Option A: Trust The Latest Persisted Paper Window Until A New Window Replaces It

This option treats the `2026-05-06T18:01Z` paper metric window as the leading capital signal because it recorded five
orders, `dependency_quorum_decision=allow`, and positive post-cost expectancy.

Pros:

- Fastest path back to paper activity.
- Uses a concrete persisted metric window instead of waiting for a full redesign.
- Converts the fresh empirical jobs into near-term learning.

Cons:

- Ignores current Jangar dependency quorum `delay`.
- Ignores current quant ingestion lag above `40000` seconds.
- Ignores stale executions and TCA from April.
- Treats a six-minute shadow/paper window as durable capital authority.

Decision: reject.

### Option B: Freeze All Strategy Work Until Every Surface Is Fully Fresh

This option blocks all strategy, repair, and research work until Jangar stage freshness, Torghut readiness, quant
ingestion, TCA, market context, and options feature tables are fully healthy.

Pros:

- Strong capital safety.
- Easy to explain during an incident.
- Avoids every stale-proof false positive.

Cons:

- Throws away useful empirical evidence and paper windows.
- Blocks zero-notional repair even though repair is the lowest-risk work.
- Gives engineers no ordering between TCA replay, TA ingest repair, options feature bootstrap, and Jangar stage
  rehydration.
- Slows the profit loop by treating all degraded surfaces as equally urgent.

Decision: reject.

### Option C: Stage-Coherent Profit Escrow With Proof-Age Arbitrage

This option keeps all capital authority in escrow unless the candidate's proof can be reconciled against the current
Jangar stage freshness epoch. Stale evidence is not discarded; it becomes a priced repair candidate.

Pros:

- Removes the failure mode where yesterday's `allow` authorizes today's capital path.
- Keeps zero-notional repair running during partial degradation.
- Converts stale proof into ranked work with expected unblock value.
- Gives engineer and deployer stages one receipt to validate.
- Supports options innovation without letting empty options features bypass guardrails.

Cons:

- Requires a new stage-coherence reducer and receipt field in Torghut.
- Requires Jangar to issue a stable stage freshness epoch.
- Will slow paper reentry when ingestion or Jangar stages are stale.

Decision: select Option C.

## Architecture

Torghut adds a `stage_coherent_profit_escrow` receipt to the proof floor and alpha router.

```text
stage_coherent_profit_escrow
  escrow_id
  generated_at
  account_label
  torghut_revision
  candidate_id
  hypothesis_id
  market_window
  requested_action_class
  requested_max_notional
  current_jangar_stage_epoch
  persisted_evidence_refs
  evidence_age_seconds
  stage_coherence_state        # coherent, repairable_stale, incoherent, unknown
  capital_authority_state      # zero_notional, paper_hold, paper_allowed, live_hold, live_allowed
  proof_age_arbitrage_score
  blocking_reasons
  repair_intents
  rollback_target
```

The reducer consumes:

- Current Jangar dependency quorum and execution trust.
- Current Jangar stage freshness epoch from the companion contract.
- Current Torghut proof floor.
- Persisted strategy hypothesis metric windows.
- Empirical job status.
- Quant evidence, including per-stage lag.
- TCA summary.
- Market-context status.
- ClickHouse table freshness and options feature table occupancy.

Capital authority rules:

- `current_jangar_stage_epoch.decision != allow` keeps capital at `zero_notional` or `paper_hold`.
- `current_jangar_stage_epoch.generated_at` older than the candidate's maximum proof age keeps capital at hold.
- Persisted metric windows whose stored dependency quorum differs from the current Jangar epoch may rank repair, but
  cannot authorize capital.
- Quant ingestion stale above the candidate threshold blocks paper/live capital, even when quant evidence is configured
  as optional for readiness.
- `market_context.last_freshness_seconds=null` is `unknown`; it blocks candidates that declare market-context
  dependency.
- Empty options feature tables block options sleeves and hedged overlays.
- TCA older than one full trading day blocks paper/live widening unless the candidate is explicitly zero-notional
  observation.

Proof-age arbitrage score:

```text
score =
  expected_unblock_value
  * empirical_confidence_multiplier
  * candidate_profit_persistence_multiplier
  / max(1, repair_eta_minutes)
  / max(1, proof_age_hours)
```

Initial repair scoring uses conservative constants:

- Jangar stage rehydration: `expected_unblock_value=9`, `repair_eta_minutes=30`
- TA ingestion catch-up: `expected_unblock_value=8`, `repair_eta_minutes=45`
- TCA replay: `expected_unblock_value=7`, `repair_eta_minutes=60`
- Hypothesis feature/drift repair: `expected_unblock_value=5`, `repair_eta_minutes=90`
- Options feature bootstrap: `expected_unblock_value=4`, `repair_eta_minutes=120`
- Market-context rehydration: `expected_unblock_value=3`, `repair_eta_minutes=45`

## Measurable Trading Hypotheses

The design funds three zero-notional repair hypotheses before any capital widening.

### H1: Stage-Coherent Microbar Continuation Can Preserve Positive Paper Expectancy

Claim: `H-MICRO-01` remains worth paper capital only if fresh Jangar stages, fresh TA ingestion, and fresh TCA replay
confirm the May 6 paper-window edge.

Acceptance gate:

- Current Jangar dependency quorum is `allow`.
- Current stage epoch is younger than `15` minutes.
- TA ingestion lag is below `180` seconds during the target session.
- TCA is recomputed for the current or previous full trading day.
- At least three consecutive `15m` paper windows have positive post-cost expectancy after slippage and spread costs.
- Average absolute slippage is at or below the candidate guardrail.

Rollback:

- Return to `repair_only` and `max_notional=0` when any epoch, TA, or TCA gate expires.

### H2: Proof-Age Arbitrage Reduces Time To Promotion-Eligible Repair

Claim: Ranking repairs by expected unblock value per proof-age hour reduces time to the next promotion-eligible
hypothesis compared with static repair order.

Acceptance gate:

- The repair queue records at least five repair intents with proof-age arbitrage scores.
- Median time from blocker detection to blocker retirement is lower than the previous seven-day static baseline.
- No repair intent carries nonzero notional.
- Repaired evidence is traceable to a Jangar stage epoch and Torghut proof-floor receipt.

Rollback:

- Fall back to the existing proof-floor repair ladder when the score inputs are missing or contradictory.

### H3: Options Feature Bootstrap Is Valuable Only After Underlying Stage Coherence

Claim: Options features should be built as a hedged experiment lane only after underlying equity evidence is stage
coherent; empty options feature tables are a data product gap, not a capital opportunity.

Acceptance gate:

- `options_contract_bars_1s`, `options_contract_features`, and `options_surface_features` are non-empty.
- Feature freshness is below `180` seconds during the target session.
- Option spread and quote-staleness guardrails are populated for the hot set.
- The underlying equity candidate has a current stage epoch and passes paper-only capital gate.

Rollback:

- Keep all options overlays in `observe_only` when any options feature table is empty or stale.

## Engineer Handoff

Implement this as a small reducer and receipt extension, not as another large route.

Required code scope:

- Add a pure stage-coherence/proof-age reducer under `services/torghut/app/trading/`.
- Extend proof-floor receipt payloads with `stage_coherent_profit_escrow`.
- Add a source adapter for Jangar's stage freshness epoch from the companion contract.
- Add read-only ClickHouse freshness summarization for TA and options feature tables.
- Treat quant ingestion as capital-blocking when action class is paper/live, even when readiness marks it optional.
- Treat market-context `null` freshness as `unknown` for candidates that require market context.
- Add focused tests for stale persisted quorum, stale TA ingestion, empty options features, nullable market context, and
  zero-notional repair intent generation.

First implementation slice:

- No schema migration is required for the first slice. Emit the receipt in `/readyz`, `/trading/status`, and scheduler
  blocked-decision metadata.
- Persist later only after the reducer contract is stable.

Validation commands:

- `uv sync --frozen --extra dev`
- `uv run --frozen pytest services/torghut/tests/test_profitability_proof_floor.py services/torghut/tests/test_submission_council.py services/torghut/tests/test_hypotheses.py`
- `uv run --frozen pyright --project pyrightconfig.json`
- Read-only route checks against `/readyz`, `/trading/status`, `/trading/empirical-jobs`, `/trading/tca`, and Jangar
  quant health.

Acceptance gates:

- A test proves a persisted metric window with `dependency_quorum_decision=allow` is capital-held when current Jangar
  dependency quorum is `delay`.
- A test proves stale quant ingestion blocks paper/live but still permits zero-notional repair.
- A test proves empty options feature tables block options capital.
- A test proves nullable market-context freshness is not a pass for market-context-dependent candidates.
- A test proves repair intents never carry nonzero notional.

## Deployer Handoff

Do not widen Torghut paper or live capital until these checks are true:

- Jangar status shows dependency quorum `allow`.
- Jangar stage freshness epoch is current for discover, plan, implement, and verify.
- Torghut `/readyz` is not degraded by proof floor, live submission, quant evidence, or stale TCA.
- Torghut `/trading/status` proof floor is not `repair_only` for the candidate.
- Postgres metric windows are reconciled to the current Jangar stage epoch.
- ClickHouse TA ingest lag is below threshold during the target session.
- Options feature tables are non-empty before options sleeves are enabled.
- TCA has been recomputed for the current or previous full trading day.

Rollout sequence:

1. Ship the receipt extension in shadow mode with `capital_authority_state=zero_notional`.
2. Observe one full market session and compare proof-age repair ranking with the existing repair ladder.
3. Enable paper-only stage coherence for `H-MICRO-01` after Jangar stage freshness and TA ingestion are fresh.
4. Keep live submission disabled until paper windows and TCA satisfy the guardrails.
5. Enable options observation only after options feature tables populate and freshness gates pass.

Rollback:

- Revert to the existing proof-floor receipt and force `capital_authority_state=zero_notional`.
- Keep `TRADING_SIMPLE_SUBMIT_ENABLED=false`.
- Clear any paper/live candidate state derived from a stale stage epoch.
- Keep options sleeves in `observe_only`.

## Risks

- The first reducer may over-hold capital if thresholds are too strict. That is acceptable for the first slice because
  the cost is missed paper observations, not live losses.
- ClickHouse freshness can be expensive if queried too often. Cache table freshness at a short TTL and never place the
  query on the hot order-submission path.
- Market-context null handling may expose that current candidates do not declare dependencies precisely. Treat unknown
  dependencies as repair work, not capital authority.
- Jangar stage freshness must be stable and monotonic enough for Torghut to consume. The companion contract owns that
  producer-side guarantee.

## Final Position

The next six months of Torghut quant should not optimize for more optimistic paper promotions. It should optimize for
capital authority that survives contact with current control-plane and data-plane evidence.

My decision is to keep capital in escrow until proof is stage-coherent. Use stale profitable-looking evidence to buy
repair, not trades.
