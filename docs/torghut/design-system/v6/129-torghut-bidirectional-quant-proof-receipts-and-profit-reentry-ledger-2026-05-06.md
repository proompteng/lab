# 129. Torghut Bidirectional Quant Proof Receipts And Profit Reentry Ledger (2026-05-06)

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

Torghut will introduce a **bidirectional quant proof receipt and profit reentry ledger**. Torghut will produce durable
receipts for hypotheses, metrics, empirical jobs, and route observations. Jangar will replicate those receipts, compare
them against its own quant latest store and controller evidence, and return material-action admission verdicts.

This is the direction I am choosing for the next six months of the quant system. It is more ambitious than refreshing a
single stale job or adding another dashboard. It makes the core profit loop explicit:

1. Torghut proposes a hypothesis with expected edge, cost model, fillability expectations, and source manifest.
2. Torghut proves the hypothesis with persisted metric windows and empirical job refs.
3. Jangar independently checks that the proof is fresh and admissible for the same account/window/hypothesis.
4. Torghut uses Jangar's verdict to choose observe, repair, paper, live micro, or live scale.

The current evidence requires this. Torghut is serving cheap health and database checks, but `/trading/health` is
degraded, `/readyz` and `/trading/status` timed out, Jangar quant health is empty for `paper/1d`, runtime metrics show
no decisions or feature batches, and the database has zero persisted hypothesis custody rows or metric windows. There
are fresh empirical job rows, but they are not connected to current persisted hypothesis windows. Torghut has enough
runtime state to diagnose; it does not yet have enough durable proof to ask for paper or live capital.

The tradeoff is higher ceremony before paper reentry. I accept that because the system is currently optimized for
generating status fragments, not for proving which hypothesis should receive the next dollar of risk.

## Success Metrics

The architecture is successful when:

- Every loaded runtime hypothesis has a persisted custody row with source manifest ref and payload digest.
- Every paper/live candidate has at least one persisted `strategy_hypothesis_metric_windows` row for the requested
  account/window/stage.
- Jangar quant health is non-empty for the same account/window before paper is eligible.
- Torghut emits a proof receipt even when it chooses no-trade or repair-only.
- `/trading/status` is not required for capital admission if the durable proof receipt and DB watermarks are fresh.
- Paper canary can start only when Jangar returns `paper_canary=allow` for that receipt.
- Live micro and live scale remain zero notional until paper settlement proves clean route provenance, slippage, and
  empirical freshness.

## Evidence Snapshot

All evidence was collected read-only.

### Cluster Evidence

- Jangar pods were ready, `/ready` returned `status=ok`, leader election was healthy, runtime kits were healthy, and
  execution trust was healthy.
- Jangar control-plane status reported dependency quorum `allow`, rollout health healthy for `agents` and
  `agents-controllers`, watch reliability healthy, and 28 of 28 migrations applied.
- The same Jangar status still marked normal dispatch `repair_only` because the controller ingestion witness was
  unknown, and paper/live capital was held on missing Torghut consumer evidence.
- Torghut live, sim, options, TA, websocket, ClickHouse, and Postgres pods were running.
- Recent Torghut events included readiness 503s around revision rollover and duplicate ClickHouse PDB matches.
- The agent service account cannot exec into pods and cannot list Knative services or statefulsets in these namespaces.

### Runtime Evidence

- `http://torghut-00240.torghut.svc.cluster.local/healthz` returned OK.
- `/db-check` returned `ok=true`, current Alembic head `0029_whitepaper_embedding_dimension_4096`, and schema lineage
  ready with known parent-fork warnings.
- `/trading/health` returned `503`.
- `/readyz` timed out after 10 seconds.
- `/trading/status` timed out after 10 seconds.
- `/metrics` reported:
  - `torghut_trading_decisions_total 0`
  - `torghut_trading_orders_submitted_total 0`
  - `torghut_trading_feature_batch_rows_total 0`
  - `torghut_trading_drift_detection_checks_total 0`
  - `torghut_trading_evidence_continuity_checks_total 0`
  - `torghut_trading_alpha_readiness_hypotheses_total 3`
  - `torghut_trading_hypothesis_state_total{state="shadow"} 2`
  - `torghut_trading_hypothesis_state_total{state="blocked"} 1`
  - `torghut_trading_alpha_readiness_promotion_eligible_total 0`
  - `torghut_trading_tca_order_count 13775.0`
  - `torghut_trading_tca_avg_abs_slippage_bps 568.6138848199565`

### Database And Data Evidence

- The Torghut app database credential could read the primary service with `default_transaction_read_only=on`.
- `torghut-db-ro.torghut.svc.cluster.local` refused TCP connections during the read-only probe.
- `trade_decisions` contained `147606` rows.
- The newest `trade_decisions.created_at` was `2026-05-04T17:25:57.901Z`; rows in the last day were `0`.
- `strategy_hypotheses`, `strategy_hypothesis_versions`, and `strategy_hypothesis_metric_windows` existed but had
  zero rows.
- `vnext_empirical_job_runs` had `20` completed rows, with newest update `2026-05-06T16:27:32.941Z` and four rows
  updated in the last day.
- Jangar quant health for `account=paper&window=1d` returned `status=degraded`, `latestMetricsCount=0`,
  `emptyLatestStoreAlarm=true`, runtime started/enabled, and no latest pipeline stages.

### Source Evidence

- `services/torghut/app/main.py` owns `/readyz`, `/db-check`, `/trading/status`, `/trading/health`, metrics, and
  control-plane contract projection.
- `services/torghut/app/trading/hypotheses.py` loads source-controlled hypothesis manifests, compiles runtime
  readiness, and summarizes hypothesis states, but that runtime summary can exist while the database custody tables
  are empty.
- `services/torghut/app/trading/runtime_window_import.py` already knows how to persist `StrategyHypothesis`,
  `StrategyHypothesisVersion`, `StrategyHypothesisMetricWindow`, `StrategyCapitalAllocation`, and
  `StrategyPromotionDecision`; this is the right implementation seam for durable proof windows.
- `services/torghut/app/trading/empirical_jobs.py` and `services/torghut/app/trading/empirical_manifest.py` define the
  empirical job proof surface.
- `services/jangar/src/server/torghut-quant-metrics-store.ts` owns Jangar quant latest, series, alerts, and pipeline
  health storage.
- `services/jangar/src/routes/api/torghut/trading/control-plane/quant/health.ts` degrades when the latest store is
  empty or stale, which is the right behavior for capital admission.
- Existing tests cover hypothesis governance migration idempotency, runtime window import, empirical jobs, quant metrics
  store lookups, and quant runtime materialization, but no current test proves the full cross-plane condition:
  runtime hypothesis present plus empty custody tables plus empty Jangar latest must hold paper/live capital.

## Problem

Torghut has built many useful pieces: manifests, runtime hypotheses, empirical jobs, TCA summaries, market-context
checks, Jangar quant health, and Jangar action receipts. The failure is not lack of components. The failure is that a
capital decision can still depend on whichever component happened to answer first.

Runtime hypotheses can be present while database custody rows are empty. Historical decisions can exist while there are
no decisions in the last day. Jangar can be healthy while its account/window latest store is empty. Empirical jobs can
be fresh while no metric windows connect those jobs to a hypothesis. `/trading/status` can be too slow for a deployer
gate while `/metrics` still exposes enough negative evidence to hold capital.

Profitability improves when the system stops treating evidence as status and starts treating it as a balance sheet.
Every hypothesis needs assets, liabilities, expiry, repair cost, and capital eligibility. The proof receipt is the asset.
Missing Jangar latest, empty metric windows, stale decisions, route timeouts, and controller witness gaps are
liabilities. The reentry ledger decides whether the next action buys information, enters paper, or risks live capital.

## Alternatives Considered

### Option A: Repair The Empty Jangar Quant Latest Store First

Pros:

- Directly addresses the current `emptyLatestStoreAlarm`.
- Likely unlocks some Jangar health surfaces quickly.
- Keeps scope narrow for engineers.

Cons:

- Does not persist Torghut hypothesis custody rows.
- Does not connect empirical jobs to strategy metric windows.
- Does not solve `/trading/status` latency as a capital gate.
- Leaves Jangar as the only visible source of freshness even when Torghut has local runtime truth.

Decision: reject as the architecture direction. It is a required repair, not a sufficient design.

### Option B: Persist Runtime Hypotheses And Let Torghut Promote Locally

Pros:

- Fixes the database gap directly.
- Keeps trading decisions close to strategy code.
- Can be implemented without a new cross-plane protocol.

Cons:

- Makes Torghut the only judge of its own paper/live readiness.
- Ignores Jangar controller witness, runtime-kit, rollout, and quant latest evidence.
- Does not give deployers one material-action verdict.

Decision: reject. Local persistence is required, but admission has to stay cross-plane.

### Option C: Bidirectional Proof Receipts And Profit Reentry Ledger

Torghut emits durable proof receipts and Jangar returns material-action verdicts for the same account/window/hypothesis.

Pros:

- Turns today's contradictory evidence into deterministic capital states.
- Lets Torghut keep innovating on hypotheses while Jangar owns material action safety.
- Makes no-trade and repair-only cycles useful because they still emit receipts.
- Creates a testable handoff for engineer and deployer stages.
- Supports ambitious profit experiments without removing zero-notional guardrails.

Cons:

- Adds schema and protocol work.
- Requires careful burn-in before enforcing paper/live.
- Requires engineers to connect existing runtime-window import code to the live scheduler path.

Decision: select Option C.

## Architecture

### Profit Reentry Ledger

Torghut stores one ledger entry per account/window/hypothesis/action cycle.

```text
profit_reentry_ledger
  ledger_id
  generated_at
  expires_at
  account
  window
  hypothesis_id
  strategy_id
  source_manifest_ref
  torghut_receipt_id
  jangar_verdict_ref
  current_stage              # observe, repair, shadow, paper, live_micro, live_scale
  requested_stage
  decision                   # allow, observe_only, repair_only, hold, block
  max_notional
  expected_gross_edge_bps
  post_cost_expectancy_bps
  avg_abs_slippage_bps
  sample_count
  feature_batch_rows
  drift_checks
  evidence_continuity_checks
  empirical_job_refs
  trade_decision_watermark
  metric_window_watermark
  missing_evidence
  required_repairs
```

This can start as a JSON payload stored through the existing strategy governance tables before becoming a dedicated
table. The important contract is that the ledger entry is durable, has expiry, and names the Jangar verdict used for
material action.

### Quant Proof Receipt Producer

Torghut emits receipts on every scheduler cycle where a hypothesis is evaluated, even when no trade is produced.

Rules:

1. If no feature rows were ingested, emit `repair_only` with `feature_batch_rows=0`.
2. If no drift checks or evidence-continuity checks ran, emit `repair_only`.
3. If runtime hypotheses are loaded but custody tables are empty, emit `repair_only` and persist custody before paper.
4. If trade decisions are stale but market session is open, emit `hold` unless an explicit no-signal receipt explains
   the stale tail.
5. If Jangar latest metrics are empty for the account/window, request `observe` or `repair`, never paper.
6. If empirical jobs are fresh and metric windows are persisted, request paper only after Jangar confirms the same
   account/window/hypothesis.

### Hypothesis Custody Repair

The first engineer slice is not a new strategy. It is custody repair:

- load current source manifests;
- persist `strategy_hypotheses` and `strategy_hypothesis_versions` for active runtime hypotheses;
- persist a zero-notional metric window when a scheduler cycle observes no trades but does evaluate the hypothesis;
- link the metric window to empirical job refs and source manifest digest;
- make the absence of feature rows, drift checks, or evidence-continuity checks explicit in the payload.

### Profit Experiments

The ledger enables three high-leverage experiments without granting live capital prematurely.

1. Fillability-first semiconductor microstructure paper lane:
   - hypothesis: current edge is lost mostly to fillability and slippage, not signal direction;
   - metric: reduce `avg_abs_slippage_bps` by at least 35 percent from the current TCA sample before paper widening;
   - guardrail: no paper if route provenance coverage is missing or Jangar latest metrics are empty.
2. Opening-window no-trade receipt lane:
   - hypothesis: explicit no-trade receipts reduce false repair work and identify real data stalls;
   - metric: every market-open scheduler cycle produces either a decision, a no-trade receipt, or a typed repair;
   - guardrail: stale `trade_decisions` during market hours requires a no-trade receipt before paper eligibility.
3. Options-informed context lane:
   - hypothesis: options surface and market-context freshness improve semiconductor entry filters;
   - metric: paper candidates must cite options TA freshness and market-context quality before receiving paper;
   - guardrail: options or context degradation discounts expected edge to zero, but observation remains enabled.

These are not ticket titles. They are measurable trading hypotheses with proof, cost, and rollback constraints.

## Implementation Scope

Engineer stage should deliver:

- receipt schema and validation;
- scheduler-side receipt emission for observe/no-trade/repair cycles;
- custody persistence for loaded manifests and versions;
- metric-window persistence for zero-notional observation cycles;
- Jangar verdict consumption in the submission council or equivalent capital gate;
- tests that replay the current state and keep paper/live blocked.

Deployer stage should deliver:

- route validation for `/healthz`, `/db-check`, `/metrics`, Jangar quant health, and Jangar control-plane status;
- confirmation that no deployer gate depends on pod exec;
- confirmation that `torghut-db-ro` behavior is either repaired or documented with a read-only primary fallback;
- post-rollout sample showing the ledger entry and Jangar verdict for at least one hypothesis.

## Validation Gates

The system is not ready for paper until all of these pass:

- `strategy_hypotheses` has one active row per loaded manifest.
- `strategy_hypothesis_versions` has one active row per active manifest version.
- `strategy_hypothesis_metric_windows` has at least one current row per paper candidate.
- Jangar quant health for the requested account/window has `latestMetricsCount > 0` and no empty-store alarm.
- `/trading/health` is healthy or the durable receipt path explains the degraded route with a bounded repair action.
- `trade_decisions` has a fresh decision, or a typed no-trade receipt explains the lack of decisions during market
  hours.
- Empirical jobs cited by the receipt are completed and fresh.
- Paper max notional is explicit and non-negative.
- Live max notional remains zero until paper settlement passes.

Regression tests must include:

- runtime hypotheses present with empty custody tables yields paper hold;
- Jangar latest empty yields paper hold even if Torghut receipt is fresh;
- stale trade decisions with no no-trade receipt yields repair;
- fresh no-trade receipt during market hours does not create an order;
- fresh metric window plus fresh Jangar latest can request paper but not live scale.

## Rollout

1. Add receipt validation and ledger projection behind a disabled enforcement flag.
2. Persist custody rows and zero-notional windows while keeping capital at shadow.
3. Expose receipts in `/trading/status` and a cheap route that does not require full scheduler status assembly.
4. Let Jangar replicate receipts and project verdicts in shadow mode for one market session.
5. Enforce repair-only and observe-only holds for empty latest store, empty metric windows, and stale decisions.
6. Enable paper canary for one hypothesis only after the validation gates pass.
7. Keep live micro and live scale blocked until paper TCA, route provenance, and empirical renewal are clean.

## Rollback

Rollback keeps observation and repair available:

- disable receipt enforcement but continue writing receipts for audit;
- cap all paper/live max notional at zero;
- fall back to existing `/readyz`, `/db-check`, metrics, and Jangar material action receipts;
- clear only the new enforcement flag, not persisted ledger rows;
- keep Jangar paper/live admission holds if quant latest or metric windows are empty.

If the ledger writes cause scheduler latency, disable writes and keep the pure receipt builder in tests. If Jangar
replication fails, Torghut remains in observe/repair mode.

## Risks

- Ledger writes could add scheduler latency. Mitigation: write compact rows, use async/background persistence where
  safe, and expose a cheap latest receipt route.
- No-trade receipts could hide real signal stalls. Mitigation: require explicit reason codes and market-session
  freshness checks.
- Jangar and Torghut can disagree. Mitigation: disagreement is a first-class `hold` with required repairs, not a
  manual interpretation step.
- Engineers may try to start with a new alpha. Mitigation: custody and receipt repair is the first acceptance gate.

## Handoff

Engineer: start with custody persistence and a pure receipt builder. The first passing implementation should reproduce
today's evidence: three runtime hypotheses, zero custody rows, empty Jangar latest, stale decisions, and paper/live
blocked with repair actions named.

Deployer: validate from the same surfaces the swarm can use: service routes, Jangar status, metrics, and read-only SQL
where credentials are available. Do not make pod exec or Knative list access part of the required gate.

Owner acceptance: I will consider paper reentry only when the ledger shows one active hypothesis with fresh custody,
fresh metric window, fresh empirical refs, non-empty Jangar latest metrics, and a Jangar paper verdict for the same
account/window/hypothesis.
