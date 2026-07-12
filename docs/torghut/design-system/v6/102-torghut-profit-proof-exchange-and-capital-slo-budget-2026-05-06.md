# 102. Torghut Profit Proof Exchange And Capital SLO Budget (2026-05-06)

Status: Accepted for engineer and deployer handoff

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented: metrics/renderers, PostHog hooks, guardrail exporters, and operational manifests exist; full SLO/on-call process is mostly doc/runbook-level.
- Matched implementation area: Observability, metrics, PostHog, alerts, and operations.
- Current source evidence:
  - `services/torghut/app/metrics/core.py`
  - `services/torghut/app/observability/posthog.py`
  - `argocd/applications/torghut/llm-guardrails-exporter.yaml`
  - `argocd/applications/torghut/clickhouse/clickhouse-guardrails-exporter.yaml`
  - `docs/torghut/production-readiness-proof-runbook.md`
- Design drift note: Operational docs need runtime status and alerting readback before being treated as complete.


## Decision

Torghut should implement a **profit proof exchange with a capital SLO budget** before paper or live capital leaves
shadow.

The live system is operationally healthier than a hard-stop incident. The Torghut route answers, the current live and
simulation revisions are running, Postgres and options services are reachable, options watermarks are fresh, and Jangar
has a fresh quant latest-store projection. That is enough to keep observe and zero-notional repair open.

It is not enough to widen capital. The database evidence is plain: `strategy_hypotheses` is empty, `research_runs` only
has skipped rows, and historical `trade_decisions` are dominated by rejected and blocked statuses. Those are not
abstract warnings. They mean Torghut cannot currently prove a specific hypothesis, in a specific account/window, has
positive expected edge after costs, quote-quality filters, rejection drag, and drawdown limits.

The exchange turns that proof into a compact contract Jangar can consume. Torghut publishes account/window/hypothesis
receipts, Jangar prices them into its action SLO budget, and capital only moves when the receipt passes. Shadow repair
can continue without pretending it is capital authority.

The tradeoff is slower capital reentry. I accept that. A slower reentry path with measurable proof is more profitable
than a fast toggle that recreates the rejected/blocked decision distribution already visible in the database.

## Evidence Snapshot

All assessment was read-only. No database rows, Kubernetes resources, or trading controls were changed.

### Cluster And Route Evidence

- `kubectl get pods -n torghut -o wide` showed live revision `torghut-00226-deployment-55998f8b99-9pffb` at
  `2/2 Running` and simulation revision `torghut-sim-00307-deployment-bdbbfc8dd-fcdpx` at `2/2 Running`.
- ClickHouse, Keeper, Torghut Postgres, TA, TA sim, options catalog, options enricher, options TA, websocket services,
  Alloy, and guardrail exporters were running.
- `GET http://torghut.torghut.svc.cluster.local/` returned status `ok`, version `v0.568.5-99-gbc400c770`, and commit
  `bc400c7709cc114f52d6e90f53c014e2574887ba`.
- The earlier shared soak reported a Torghut sim ImagePullBackOff, but the current read-only check shows the current sim
  revision recovered.

### Database, Schema, Freshness, And Consistency

- Torghut SQL connected as application user `torghut_app` to database `torghut` at `2026-05-06T01:23:59.394Z`.
- Alembic head was `0029_whitepaper_embedding_dimension_4096`.
- `torghut_options_watermarks` had 5,085 rows, newest successful timestamp `2026-05-06T01:26:27.508Z`, and max retry
  count `0`.
- `torghut_options_contract_catalog` carried roughly 2.38 million live tuples and 234 thousand dead tuples, with
  autoanalyze at `2026-05-06T01:24:29.642Z`. This is usable evidence but also a pressure point for catalog freshness and
  bloat-aware proof queries.
- `strategies` had 16 rows and newest update at `2026-05-05T21:05:17.101Z`.
- `strategy_hypotheses` had zero rows.
- `research_runs` had 48 skipped rows and no non-skipped proof chain.
- `position_snapshots` had 40,759 rows and newest `as_of` at `2026-05-05T20:59:06.001Z`.
- `trade_decisions` counted 69,909 `rejected`, 63,552 `blocked`, 13,555 `filled`, 370 `planned`, 217 `canceled`, and 3
  `expired` rows. Newest rejected decision was `2026-05-04T17:25:57.901Z`.
- `whitepaper_design_pull_requests` had one opened row with null CI status from March, so design-PR bookkeeping is not a
  runtime gate.

### Jangar Dependency Evidence

- Jangar SQL connected and reported fresh `torghut_control_plane.quant_metrics_latest` evidence: 3,780 rows and newest
  `as_of` `2026-05-06T01:26:25.075Z`.
- Jangar controller heartbeats were fresh and healthy, so Torghut can trust the Jangar projection as a current
  observation surface.
- Jangar action budget, as defined in the companion contract, must still block paper/live capital while hypothesis proof
  rows are absent and rejection drag remains unretired.

### Source And Test Evidence

- `services/torghut/app/trading/hypotheses.py` defines the runtime hypothesis manifest, dependency capabilities,
  promotion eligibility, rollback requirement, and capital stages.
- `services/torghut/app/trading/submission_council.py` owns live submission admission, quant evidence consumption,
  dependency quorum, and capital-state decisions.
- `services/torghut/app/trading/discovery/promotion_contract.py`,
  `services/torghut/app/trading/discovery/validation.py`, and
  `services/torghut/scripts/verify_quant_readiness.py` already contain promotion and proof validation primitives.
- `services/torghut/app/options_lane/repository.py` and related options services maintain the fresh options watermark
  plane that options hypotheses should cite.
- Torghut has broad Python tests around trading, hypotheses, governance, empirical jobs, readiness, options, and quant
  verification. The missing regression is the proof-exchange gate: route liveness plus fresh options watermarks must
  not unlock capital when hypothesis and research proof tables are empty.

## Problem

Torghut has the parts of a profitable control plane, but the proof is spread across routes, database tables, metrics,
and scripts. That spread creates five failure modes:

1. **Capital toggles can outrun proof.** A route or config toggle can look ready before hypothesis evidence exists.
2. **Fresh data is not scoped to profit.** Options watermarks are fresh, but no active hypothesis cites them with
   account/window proof.
3. **Historical rejection drag is unpriced.** The decision table shows a large rejected/blocked population. Capital
   gates must price that drag, not ignore it.
4. **Research output is not populated.** Empty hypothesis rows and skipped-only research runs mean there is no current
   promotion chain to audit.
5. **Jangar cannot consume large local semantics.** Jangar needs compact receipts that say what is proven, what is stale,
   and which action class is allowed.

## Alternatives Considered

### Option A: Keep Torghut Shadow Until Manual Review Clears A Toggle

Pros:

- Safest immediate capital posture.
- Requires little new code.
- Matches the current fact that capital should remain closed.

Cons:

- Does not define how a hypothesis earns paper capital.
- Does not give Jangar a durable proof contract.
- Makes profitability a manual review bottleneck.

Decision: reject as the architecture. Manual review remains a rollback and exception path, not the main gate.

### Option B: Require Fresh Options And Quant Metrics Only

Pros:

- Builds on two currently healthy surfaces: options watermarks and Jangar quant latest metrics.
- Fast path for options-dependent strategies.
- Easy to expose through existing metrics and route checks.

Cons:

- Does not prove a named hypothesis has edge after costs.
- Does not price rejection drag or drawdown.
- Does not address empty strategy hypothesis and research proof tables.

Decision: reject as insufficient. These are necessary inputs, not the full proof.

### Option C: Profit Proof Exchange And Capital SLO Budget

Torghut publishes compact, expiring receipts for each hypothesis/account/window. Jangar consumes those receipts and
maps them to shadow, paper, and live capital action classes.

Pros:

- Forces every capital decision to cite a measurable hypothesis.
- Uses fresh options, quant, market context, cost, rejection, and risk evidence together.
- Keeps shadow repair open while paper/live remain fail-closed.
- Gives deployers objective rollback and reentry gates.

Cons:

- Requires new route or projection contracts.
- Requires data retention discipline for receipts.
- Requires staged enforcement to avoid blocking useful zero-notional repair.

Decision: select Option C.

## Chosen Architecture

### ProfitProofReceipt

Torghut emits one receipt per hypothesis/account/window:

```text
profit_proof_receipt
  receipt_id
  hypothesis_id
  strategy_family
  account
  window
  generated_at
  fresh_until
  evidence_digest
  data_freshness
  cost_model
  rejection_drag
  risk_limits
  quant_digest
  market_context_digest
  decision
  rollback_trigger
```

The receipt decision is one of:

- `observe_only`
- `shadow_repair_allowed`
- `paper_capital_allowed`
- `live_capital_allowed`
- `blocked`

### Required Measurements

Every paper or live receipt must include:

- minimum sample size for the strategy family and window;
- expected gross edge and expected net edge after fees and slippage;
- realized or replayed rejection ratio;
- quote-quality pass rate;
- max drawdown and drawdown delta against the rollback threshold;
- p-value or sequential-trial confidence where available;
- market-context freshness by domain;
- options catalog and watermark freshness for options hypotheses;
- Jangar quant latest-store digest for the account/window;
- current dependency quorum decision;
- rollback trigger and owner.

### Capital SLO Budget

Torghut publishes a capital budget summary:

```text
capital_slo_budget
  account
  window
  generated_at
  fresh_until
  shadow_allowed
  paper_allowed
  live_allowed
  blocking_debts[]
  allowed_receipts[]
  rejection_budget
  drawdown_budget
  stale_data_budget
```

Initial budget rules:

- Shadow is allowed for zero-notional repair when broker and database routes are healthy.
- Paper is blocked while `strategy_hypotheses` is empty or no receipt has `paper_capital_allowed`.
- Live is blocked until paper receipts pass, drawdown budget is positive, rejection drag is below threshold, and rollback
  drills are current.
- Options-dependent hypotheses require fresh options watermarks and bounded catalog dead-tuple pressure.
- Any missing Jangar quant digest downgrades to `observe_only`.

### Jangar Exchange Contract

Jangar consumes only compact receipt summaries:

```text
profit_proof_exchange
  exchange_id
  generated_at
  fresh_until
  receipts[]
  capital_slo_budget
  blocked_action_classes[]
  source_route_digests[]
```

Jangar does not infer profit from Torghut route liveness. It reads the exchange and maps decisions to action classes:

- `observe_only` -> allow `observe`.
- `shadow_repair_allowed` -> allow `torghut_shadow_capital` and `dispatch_repair`.
- `paper_capital_allowed` -> allow `torghut_paper_capital` only for the named account/window/hypothesis.
- `live_capital_allowed` -> allow `torghut_live_capital` only after paper evidence and deployer gates pass.
- `blocked` -> hold paper/live and keep repair open if a debt target is named.

## Implementation Scope

Engineer stage:

1. Add a pure proof receipt builder over existing Torghut hypothesis, empirical, options, quant, and decision evidence.
2. Add a read-only route or database projection for `profit_proof_exchange`.
3. Add tests for the current database shape: zero hypotheses, skipped-only research, fresh options, and high rejection
   counts must produce shadow repair allowed but paper/live blocked.
4. Wire Jangar to consume the compact exchange in shadow mode.
5. Add a fixture for at least one synthetic profitable receipt to prove paper capital can open only when all required
   measurements are present.
6. Keep design-PR records as audit artifacts only; do not make ticket state or whitepaper PR rows runtime gates.

Deployer stage:

1. Verify Torghut root and trading health routes.
2. Verify options watermarks and Jangar quant latest-store freshness.
3. Verify proof exchange output for the current state blocks paper/live.
4. Run a zero-notional repair job that targets missing hypothesis proof.
5. Enable paper capital for one hypothesis only after a receipt passes and Jangar action budget allows the action class.
6. Do not enable live capital until paper evidence, rollback drill, and drawdown budget all pass.

## Validation Gates

- Unit tests reject receipts with missing hypothesis id, missing account/window, stale market context, stale options
  watermarks, missing Jangar quant digest, high rejection ratio, or drawdown over threshold.
- Integration tests prove route liveness and fresh options watermarks alone do not open paper/live.
- `verify_quant_readiness.py` accepts a generated profitability proof manifest and rejects malformed proof.
- Database checks confirm Alembic head is current and no duplicate heads are present.
- A deployer run captures:
  - `kubectl get pods -n torghut -o wide`
  - Torghut health and proof-exchange route output
  - Jangar quant latest freshness
  - Torghut decision distribution

## Rollout Plan

1. Ship proof-exchange route in read-only shadow mode.
2. Populate receipts from existing state and confirm current capital remains blocked.
3. Generate one synthetic profitable fixture and prove tests open paper only for that fixture.
4. Wire Jangar shadow action budget to consume the exchange.
5. Enable paper for one hypothesis after a real receipt passes.
6. Keep live disabled until paper rollback drills and loss stops are proven.

## Rollback

- If the proof exchange is unreachable or stale, Jangar fails closed for paper/live and keeps observe/repair open.
- If receipts are wrong or overly broad, disable exchange enforcement and continue shadow output for audit.
- If rejection ratio rises above budget after paper opens, demote the hypothesis to shadow and emit a rollback receipt.
- If options watermark freshness stales, demote options-dependent hypotheses to observe-only.

## Risks

- Proof receipts can become too heavy. Keep them compact and store bulky evidence by digest.
- Empty hypothesis tables may hide source-controlled manifest evidence. The first engineer step must reconcile manifests
  with database projections and name the authority.
- Rejection drag thresholds need calibration. Start conservative and require deployer approval before relaxing them.
- Options catalog bloat can make proof queries expensive. Use watermarks and targeted indexed summaries rather than full
  catalog scans in the hot path.

## Handoff Contract

Engineer acceptance:

- `profit_proof_exchange` returns compact receipts and capital budget decisions.
- The current live database shape blocks paper/live and allows only observe plus zero-notional repair.
- A synthetic complete receipt opens paper for one account/window/hypothesis in tests.
- Jangar consumes the exchange in shadow mode without privileged DB shells or Kubernetes exec.

Deployer acceptance:

- The exchange is visible and fresh for two evidence windows.
- Paper/live stay blocked while hypothesis and research proof tables are empty.
- A repair job can target missing proof without enabling capital.
- Rollback demotes any hypothesis whose receipt expires, loses Jangar quant freshness, breaches drawdown, or exceeds
  rejection budget.
