# torghut

FastAPI service scaffold for an autonomous Alpaca paper trading bot powered by Codex.

## Local dev (uv-native)

```bash
cd services/torghut
uv venv .venv
source .venv/bin/activate
uv pip install .

# configure env (DB_DSN defaults to local compose: postgresql+psycopg://torghut:torghut@localhost:15438/torghut)
export APP_ENV=dev
# optional:
# export DB_DSN=...               # override if not using local compose
# export APCA_API_KEY_ID=...
# export APCA_API_SECRET_KEY=...
# export APCA_API_BASE_URL=...

# shortcuts
# normal server
uv run uvicorn app.main:app --host 0.0.0.0 --port 8181

# hot reload
uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8181

# type checking
uv run pyright
```

Health checks:

- `GET /healthz` – liveness (default port 8181)
- `GET /db-check` – requires reachable Postgres at `DB_DSN`, matching Alembic heads, and schema-lineage policy checks
  (`schema_graph_*` diagnostics + lineage warnings/errors) (default port 8181)

Migration lineage guardrail (CI-local parity):

```bash
cd services/torghut
uv run --frozen python scripts/check_migration_graph.py
```

Optional migration-lineage controls:

- `TRADING_DB_SCHEMA_GRAPH_BRANCH_TOLERANCE` (default `1`)
- `TRADING_DB_SCHEMA_GRAPH_ALLOW_DIVERGENCE_ROOTS` (default `false`; use `true` for controlled override windows)
- If a PR intentionally changes migration topology beyond the current allowlist, update
  `DEFAULT_ALLOWED_DIVERGENT_SIGNATURES` in `scripts/check_migration_graph.py` in the same change or land a merge
  migration that brings the graph back within tolerance. CI will reject undocumented divergence.
- Remove the runtime override from GitOps after merge migrations collapse the graph back to the tolerated branch count;
  keep the feature flag default disabled outside explicit rollout windows.

## Pylint size and design guardrails

Torghut uses Pylint for focused refactor guardrails rather than full default lint churn. CI blocks Python modules over
`1000` lines in `app`, `scripts`, `tests`, or `migrations`. The selected design-complexity checks for runtime code in
`app` and `scripts` still run as inventory until that broader debt surface is reduced to zero.

Current rollout commands:

```bash
cd services/torghut
uv run --frozen pylint app scripts tests migrations --disable=all --enable=too-many-lines --score=n
uv run --frozen pylint app scripts --disable=all --enable=too-many-branches,too-many-locals,too-many-return-statements,too-many-statements --score=n
```

The file-length command is blocking in CI. The design-complexity command is intentionally non-blocking inventory until
the remaining findings are refactored without broad suppressions.

## Dead-code audit (Vulture)

Run Vulture from the Torghut service root so it picks up the checked-in `[tool.vulture]` config in
[`pyproject.toml`](/Users/gregkonush/.codex/worktrees/3348/lab/services/torghut/pyproject.toml):

```bash
cd services/torghut
uv run --frozen vulture --config pyproject.toml
```

The current config follows the upstream Vulture guidance for conservative cleanup:

- scan `app` and `scripts`
- exclude test, virtualenv, and migration paths
- only report `100%` confidence findings
- sort by size so larger dead blocks are easier to review first

After removing findings, rerun Vulture because additional dead code may become visible once the first layer is gone.

## Pytest, Hypothesis, and coverage

Torghut now uses `pytest` as the canonical test runner. The existing `unittest.TestCase` suite still runs under pytest,
and new property/stateful tests live under `tests/property/` and `tests/stateful/`.

Install and sync dev tooling:

```bash
cd services/torghut
uv sync --frozen --extra dev
```

Run the full suite with branch coverage:

```bash
cd services/torghut
uv run --frozen pytest --cov --cov-branch --cov-report=term-missing --cov-report=xml
```

Run only property-based tests:

```bash
cd services/torghut
uv run --frozen pytest -m property
```

Run only state-machine tests:

```bash
cd services/torghut
uv run --frozen pytest -m stateful
```

Hypothesis profiles are loaded from `tests/hypothesis_profiles.py`.

- default local profile: `local_debug`
- CI profile: `ci_fast`
- deeper state-machine profile: `ci_stateful`
- nightly/deep profile: `nightly_deep`

Override locally with:

```bash
cd services/torghut
TORGHUT_HYPOTHESIS_PROFILE=ci_stateful uv run --frozen pytest -m stateful
```

Validate changed-file coverage locally after generating `coverage.xml`:

```bash
cd services/torghut
uv run --frozen python scripts/check_diff_coverage.py --coverage-xml coverage.xml --threshold 90
```

Curated mutation-testing entrypoint:

```bash
cd services/torghut
uvx --from mutmut mutmut run app.trading.quantity_rules*
```

Curated CrossHair check for pure helpers:

```bash
cd services/torghut
uvx --from crosshair-tool crosshair check --analysis_kind=asserts app/trading/quantity_rules.py
```

Testing rules for the trading core:

- changes to `app/trading/**` should add or modify tests unless they are comment-only or dead-code removal
- changes to `quantity_rules.py`, `features.py`, `quote_quality.py`, `session_context.py`, `portfolio.py`,
  `decisions.py`, `strategy_runtime.py`, or `scripts/local_intraday_tsmom_replay.py` should include at least one
  property-based or stateful test
- new global Ruff ignores or Pyright suppressions in trading-core files require explicit justification
- new property tests should use the centralized strategies in `tests/strategies/` instead of ad hoc payload builders

## Hypothesis readiness and dependency quorum

- Hypothesis manifests live under `config/trading/hypotheses/` and are loaded at startup from
  `TRADING_HYPOTHESIS_REGISTRY_PATH` (default: `config/trading/hypotheses`).
- `GET /trading/status` now exposes:
  - `hypotheses.registry_loaded`, `hypotheses.registry_errors`, and `hypotheses.items`
  - per-hypothesis `state`, `capital_stage`, `promotion_eligible`, `rollback_required`, and blocker `reasons`
  - `control_plane_contract.alpha_readiness_*` summary counts for blocked, shadow, canary-live, and scaled-live lanes
  - `last_decision_at` from the newest persisted `trade_decisions.created_at` row so status recency matches stored decision truth after restarts
- `GET /trading/health` includes an additive `alpha_readiness` block summarizing readiness totals and any configured
  external quorum state.
- `GET /metrics` exports:
  - `torghut_trading_hypothesis_state_total`
  - `torghut_trading_hypothesis_capital_stage_total`
  - `torghut_trading_alpha_readiness_hypotheses_total`
  - `torghut_trading_alpha_readiness_promotion_eligible_total`
  - `torghut_trading_alpha_readiness_rollback_required_total`
- The live trading-loop manifest sets `TRADING_JANGAR_CONTROL_PLANE_STATUS_URL` to the cluster-local Jangar `/ready`
  route so revenue-repair can import low-latency controller-ingestion carry, verify-foreclosure boards, and
  repair-slot escrow for zero-notional no-delta decisions. Live also pins
  `TRADING_JANGAR_CONTROL_PLANE_TIMEOUT_SECONDS=30` as a defensive upper bound, but routine carry import no longer
  depends on the slower full status route. Paper/sim still leaves that URL unset. The executable universe remains
  declared inside Torghut, and live submission remains gated by Torghut-owned signal, empirical-job, proof-floor,
  routeability, and execution evidence rather than by Jangar serving health alone.
- Optional cross-service dependency quorum checks remain available for off-path experiments by setting
  `TRADING_JANGAR_CONTROL_PLANE_STATUS_URL` on non-production surfaces that need the same bounded carry import.
- Optional external quant-health checks remain available by setting `TRADING_JANGAR_QUANT_HEALTH_URL`. Torghut rejects
  that URL when it does not target the typed `/api/torghut/trading/control-plane/quant/health` surface; use
  `TRADING_JANGAR_QUANT_WINDOW` to align the expected freshness window. The production live and paper trading manifests
  leave this unset so Jangar availability is not part of the live-submission gate.
- The shared live-submission gate now projects `profit_window_contract` with deterministic `profit_window_id` and
  `evidence_escrow_id` values per hypothesis lane. The contract records session class, funded/expired/underfunded
  escrow state for quant health, ClickHouse freshness, empirical jobs, market context, forecast/feature coverage, and
  schema lineage so status, readiness, runtime-profitability, and decision metadata can cite the same lane-local
  authority snapshot.
- `GET /trading/status` and `GET /readyz` also surface `profit_lease_projection`, a shadow-only
  `torghut.profit-lease-provenance.v1` payload for Jangar `torghut_capital` consumers. It source-qualifies proof by
  empirical job freshness, quant metrics, relevant data readiness, promotion-table presence, rejection drag, and the
  Jangar action lease before emitting `observe_only`, `repair_only`, `paper_candidate`, or `live_candidate`.
- `GET /trading/status` and `GET /readyz` also surface `renewal_bond_profit_escrow`, a shadow-only
  `torghut.renewal-bond-profit-escrow.v1` receipt for the May 7 doc 137 contract. It consumes Jangar stage trust,
  stage renewal bonds, proof floor, empirical jobs, quant evidence, market context, TCA, and hypothesis readiness,
  then keeps `max_notional=0` while ranking zero-notional repairs and carrying fresh empirical proof value.
- `GET /trading/status`, `GET /trading/health`, `GET /readyz`, and `GET /trading/autonomy` also surface the May 7 doc
  168 executable-alpha projection: a `torghut.capital-replay-board.v1` board plus
  `torghut.executable-alpha-receipts.v1` candidate receipts. The initial board is observation-only, seeds AAPL route
  rehab, NVDA scoped proof refill, and missing megacap breadth probes from proof-floor/route evidence, and keeps every
  replay and receipt at `max_notional=0` until Jangar contract graduation and fresh scoped proof close.
- `GET /trading/revenue-repair` uses that executable-alpha projection when `repair_alpha_readiness` is the top queue
  item. The digest binds the queue row to `value_gate=routeable_candidate_count`,
  `required_output_receipt=torghut.executable-alpha-receipts.v1`, `max_notional=0`, the current capital replay board,
  and candidate executable-alpha receipts so the alpha-readiness repair is dispatchable as zero-notional evidence
  instead of a generic capital-unblock instruction.
- `GET /trading/revenue-repair` also emits the May 13 doc 197
  `torghut.executable-alpha-repair-receipts.v1` compact receipt collection. When the live queue is topped by
  `repair_alpha_readiness`, it selects zero-notional `torghut.executable-alpha-repair-receipt.v1` work for the
  concrete alpha repair target, maps target reason codes to a repair class, carries validation commands and
  no-delta settlement requirements, and keeps `max_notional=0`. Same-class alpha-window receipts prefer feature/drift
  repair ahead of post-cost and closed-session holds so the selected launch candidate stays aligned with the
  alpha-readiness settlement conveyor and dividend ledger. `/trading/consumer-evidence` mirrors the same compact
  collection for Jangar without making `/readyz` green or enabling paper/live submission.
- `GET /trading/revenue-repair` also emits the May 14 doc 199
  `torghut.executable-alpha-settlement-slots.v1` read-model. It settles the selected executable-alpha repair receipt
  against the current routeable-candidate count, emits no-delta debt when the selected blocker remains unchanged,
  names the material reentry receipt reference, and stays additive with `max_notional=0`. `/readyz` and
  `/trading/consumer-evidence` mirror only the compact
  `torghut.executable-alpha-settlement-slots-ref.v1` fields for Jangar admission.
- `GET /trading/revenue-repair` also emits the May 14 doc 198
  `torghut.alpha-repair-closure-board.v1` board. The board binds the top `repair_alpha_readiness` queue item to the
  selected executable-alpha repair receipt, names the routeable-candidate value gate, records zero-notional
  no-delta debt when candidate count does not move, and keeps the rollback target at `max_notional=0`.
  `/readyz` and `/trading/consumer-evidence` mirror only the compact
  `torghut.alpha-repair-closure-board-ref.v1` fields for Jangar admission.
- The same board now carries the May 14 doc 201 `torghut.alpha-closure-settlement-market.v1` read-model. While
  `repair_alpha_readiness` is the live top queue item, the market reserves the first zero-notional closure slot for
  lineage-ready `H-MICRO-01` feature replay when drift checks, feature rows, or required feature-set evidence remain
  missing. The compact board ref exposes the market id, selected hypothesis, settlement receipt requirement, active
  dedupe key, and no-delta budget state without enabling paper or live notional. The profit-freshness frontier applies
  the same alpha feature-replay priority when required feature rows or feature-set evidence are missing, so the default
  zero-notional repair action aligns with the closure market before lower-value drift-only repair.
- `GET /trading/revenue-repair` also emits the May 14 doc 200 `torghut.alpha-evidence-foundry.v1` read-model. The
  foundry turns the current `repair_alpha_readiness` queue item into hypothesis-scoped
  `torghut.alpha-evidence-window-receipt.v1` receipts with feature, drift, post-cost, market-context, TCA,
  route-universe, no-delta, and zero-notional fields. `/readyz` and `/trading/consumer-evidence` mirror only the
  compact `torghut.alpha-evidence-foundry-ref.v1` fields for Jangar admission.
- `GET /trading/revenue-repair` also emits the May 14 doc 205
  `torghut.alpha-readiness-settlement-conveyor.v1` read-model and the May 14 doc 204
  `torghut.alpha-repair-dividend-ledger.v1` accounting surface. The conveyor selects the current
  zero-notional alpha-readiness lane, and the dividend ledger records whether that lane paid
  `routeable_candidate_count`, produced no-delta debt, or must be blocked/stale before another material repair launch.
  `/readyz` and `/trading/consumer-evidence` mirror compact refs for Jangar custody while keeping `max_notional=0`.
- `GET /trading/revenue-repair` also emits the May 14 doc 206
  `torghut.no-delta-repair-reentry-auction.v1` observe-mode reducer. The auction denies repeat alpha-readiness
  launches while the active no-delta release key is unchanged, selects at most one zero-notional reentry ticket when a
  source, evidence-window, blocker, receipt, selected-hypothesis, or Jangar verify-carry release condition changes, and
  mirrors a compact `torghut.no-delta-repair-reentry-auction-ref.v1` through `/readyz` and
  `/trading/consumer-evidence`. It does not enable paper or live submission.
- `GET /trading/revenue-repair` now also exposes the May 14 doc 212 top-line business contract fields directly:
  `top_repair_queue_item`, `selected_value_gate`, `required_output_receipt`, routeable-candidate before/after counts,
  no-delta reentry decision, repair-bid lot summaries, typed unavailable reason codes, validation commands, and a
  rollback target. `/trading/status` and `/trading/consumer-evidence` mirror the compact top-line fields so Jangar can
  compare the direct revenue-repair source with the consumer-evidence action boundary without inferring
  `repair_queue[0]`. These fields remain additive and keep `max_notional=0`.
- `GET /trading/revenue-repair` also emits the May 14 doc 211
  `torghut.jangar-controller-ingestion-carry.v1` import reducer. It classifies Jangar controller-ingestion carry as
  `current`, `repairable`, `lagging`, `unavailable`, `stale`, or `contradicted`, feeds that state into the no-delta
  auction, and mirrors a compact `torghut.jangar-controller-ingestion-carry-ref.v1` through `/readyz` and
  `/trading/consumer-evidence`. The import carries Jangar repair-slot escrow and rollout-witness refs when available
  so `hold` or `block` settlements can name the exact zero-notional blocker instead of collapsing to a generic missing
  carry. `/trading/consumer-evidence?view=summary` returns the same action-boundary schema with only the compact
  status, receipt, route-profit, and canary fields Jangar needs for readiness. The default route keeps the full
  operator evidence payload. `/trading/consumer-evidence` fetches the Jangar status payload with Torghut
  consumer-evidence expansion explicitly omitted, so the route can mirror current Jangar carry without recursively
  calling itself through Jangar.
  A `jangar_verify_carry` ticket is selectable only for `repairable` carry and always keeps `max_notional=0`.
- `GET /trading/status` and `GET /readyz` now include the May 8 doc 181
  `quality_adjusted_profit_frontier` shadow projection. The reducer ranks zero-notional repair packets from quant
  quality, market-context risk flags, route/TCA state, simulation-cache freshness, and Jangar evidence-quality refs
  while keeping `paper_probe_notional_limit=0` whenever evidence is missing, stale, degraded, or non-promoting.
- `GET /trading/consumer-evidence` is the Jangar-facing action boundary for May 8 doc 182. It returns
  `torghut.consumer-evidence-status.v1`, the compatibility `torghut_consumer_evidence_receipt`, a
  `route_proven_profit_receipt` with serving revision, image digest, route canary id, Jangar parity escrow ref,
  proof-floor state, decision, rollback target, and route repair value, plus the `consumer_evidence_canary` contract.
  `/trading/status` and `/trading/health` include the same route-proven receipt for operators, but paper/live capital
  remains gated by the dedicated consumer-evidence route, proof floor, and Jangar parity.
- `GET /trading/status`, `GET /trading/health`, `GET /readyz`, and `GET /trading/consumer-evidence` also surface the
  May 8 doc 183 `torghut.capital-reentry-cohort-ledger.v1` projection. It groups AAPL receipt settlement,
  high-activity TCA repair, missing-TCA probes, forecast registry repair, and alpha-readiness repair into compact
  cohorts Jangar can cite in paper/live material-action evidence refs. Every cohort stays at `max_notional=0`; the
  ledger is an observe-mode settlement surface, not a submit authorization.
- `GET /trading/status`, `GET /trading/health`, `GET /readyz`, and `GET /trading/consumer-evidence` now include the
  May 12 doc 189 `torghut.clock-settlement-receipt.v1` projection. It compares direct ClickHouse TA freshness, scoped
  Jangar quant, TCA, empirical, promotion, and rollout witnesses against the published `evidence_clock_arbiter`; a fresh
  direct ClickHouse witness with a missing or stale `clickhouse_ta` published clock emits a zero-notional
  `clock_wiring_split` repair packet. The receipt is observe-mode only and keeps `max_notional=0`.
- `GET /trading/status`, `GET /trading/health`, `GET /readyz`, and `GET /trading/consumer-evidence` now also surface
  the May 8 doc 184 `torghut.profit-repair-settlement-ledger.v1` projection. It joins the proof floor, consumer
  evidence receipt, capital reentry cohorts, quality frontier, route/TCA rows, scoped quant health, and Jangar
  execution-trust admission into zero-notional repair lots. Jangar can carry the ledger id and lot ids as evidence refs,
  but every lot keeps `paper_notional_limit=0` and `live_notional_limit=0` until forecast, alpha, quant, route/TCA, and
  execution-trust settlement clear.
- `GET /trading/status`, `GET /trading/health`, `GET /readyz`, and `GET /trading/consumer-evidence` also surface the
  May 8 doc 185 `torghut.routeability-repair-acceptance-ledger.v1` projection, and `/trading/revenue-repair`
  references the same ledger id. The reducer separates quant scoped-stage repair, stale market-context domains, alpha
  readiness, route/TCA, forecast/promotion evidence, submit gate holds, and Jangar routeability admission into compact
  acceptance lots. The ledger is observe-only: unsettled lots keep `paper_notional_limit=0`,
  `live_notional_limit=0`, and `accepted_routeable_candidate_count=0` until every required receipt settles.
- `GET /trading/status`, `GET /trading/health`, `GET /readyz`, and `GET /trading/consumer-evidence` now surface the
  May 12 doc 188 `torghut.profit-freshness-frontier.v1` projection. It ranks zero-notional repairs across scoped quant
  signal freshness, market context, empirical proof, feature coverage, drift checks, route/TCA quality, routeability
  acceptance, schema lineage, and Jangar reliability settlement. When upstream quality-adjusted profit packets include
  expected post-cost daily net PnL unlock, the frontier ranks lots on that value and cites the packet refs; otherwise it
  falls back to the existing bps proxy. The frontier names one selected repair when proof is stale, but
  `paper_notional_limit=0`, `live_notional_limit=0`, and existing proof-floor/submission gates remain the only capital
  authority.
- `GET /trading/status`, `GET /trading/health`, `GET /readyz`, and `GET /trading/consumer-evidence` now surface the
  May 13 doc 192 `torghut.repair-receipt-frontier.v1` projection. It compacts source-serving proof, freshness carry,
  repair-bid settlement, route warrants, and profit-freshness repairs into one ranked zero-notional frontier with paper
  and live cutover requirements. Non-source repairs are held until source-serving proof converges, every frontier lot
  reports `max_notional=0`, and rollback is to ignore the projection while consuming the existing source-serving,
  repair-bid, and profit-freshness payloads.
- `GET /trading/status`, `GET /trading/health`, `GET /readyz`, and `GET /trading/consumer-evidence` now surface the
  May 13 doc 193 `torghut.repair-outcome-dividend-ledger.v1` projection. It binds dispatchable repair-bid lots to
  pending outcome receipts or current terminal receipts, exposes open repair outcome escrows for Jangar terminal-debt
  compaction, and records retired, preserved, or no-delta reason codes. The ledger is observe-mode only:
  `capital_stage=shadow`, `max_notional=0`, and live submit remains disabled while repair results are measured.
- `GET /trading/consumer-evidence` now also surfaces the May 13 doc 196
  `torghut.profit-carry-passport-ledger.v1` projection. It builds observe-mode profit-carry passports for AAPL route
  rehab, NVDA scoped proof refill, megacap breadth probing, and the H-MICRO-01 alpha-readiness refill, then pairs each
  passport with a Jangar repair-capacity future. Every passport keeps `max_notional=0`, blocks paper and live action
  classes, cites required receipts before capital promotion, and rolls back by ignoring the passport ledger while
  preserving existing consumer-evidence, capital-replay, and repair-outcome surfaces.
- `POST /trading/profit-freshness/zero-notional-repair` returns the May 12 doc 188
  `torghut.zero-notional-repair-execution-receipt.v1` executor receipt for the selected frontier repair. The default
  mode is a dry run. With `execute=true`, the only local runner is bounded route/TCA recompute; empirical proof renewal
  and market-context refresh remain admission-gated receipt plans until their external runners are wired. The receipt
  cites the May 13 doc 192 `freshness_carry_ledger` dimension and repair proof SLO for market-context, empirical, and
  TCA freshness repairs; execution fails closed when the SLO is missing or not dispatchable. It always reports
  `order_submission_enabled=false`, `paper_notional_limit=0`, and `live_notional_limit=0`.
- `GET /trading/status`, `GET /trading/health`, and `GET /readyz` also expose the May 8 doc 184
  `torghut.profit-signal-quorum.v1` shadow receipt. It evaluates each hypothesis against scoped quant latest metrics,
  quant pipeline stages, market-context route health, hypothesis lineage, promotion-decision evidence, route/TCA,
  rejection-drag evidence, and Jangar stage-clearance admission. The quorum names the required repair action per lane
  and keeps every candidate at `max_notional=0` until the scoped quorum and an independent capital gate both pass.
- `GET /trading/status`, `GET /trading/health`, `GET /readyz`, and `GET /trading/consumer-evidence` also expose the May
  12 doc 188
  `torghut.evidence-clock-arbiter.v1` and `torghut.routeable-profit-candidate-exchange.v1` shadow payloads. The
  reducer compares ClickHouse TA, scoped Jangar quant, market context, Postgres TCA, empirical replay, hypothesis
  lineage, rollout, routeability acceptance, profit-signal quorum, and capital-gate clocks before any routeable
  candidate can be counted. Split or stale clocks become zero-notional repair lots with target value gates; emitted
  candidates still carry `max_notional=0` until independent capital and Jangar custody receipts allow paper. The
  consumer-evidence copy is the Jangar action boundary: missing or stale stage-custody evidence can hold normal
  dispatch and deploy widening without blocking zero-notional repair dispatch.
- `GET /trading/status`, `GET /trading/health`, `GET /readyz`, `GET /trading/revenue-repair`, and
  `GET /trading/consumer-evidence` also expose the May 12 doc 188 observe-mode
  `torghut.route-evidence-clearinghouse-packet.v1` packet. It never widens notional and keeps stale TCA, missing image
  proof, missing options provider clocks, and zero-notional capital holds out of accepted routeable counts.
- `GET /trading/status`, `GET /trading/health`, `GET /readyz`, `GET /trading/revenue-repair`, and
  `GET /trading/consumer-evidence` also expose the May 13 doc 190
  `torghut.repair-bid-settlement-ledger.v1` ledger. It compacts raw route-evidence repair bids into bounded
  zero-notional lots with dedupe keys, one required output receipt, and at most three Jangar-dispatchable lots per
  account/window. Routeable candidate count remains zero while selected lots are unsettled.
- `GET /trading/status`, `GET /trading/health`, `GET /readyz`, and `GET /trading/consumer-evidence` now expose the
  May 13 doc 190 observe-mode `torghut.route-warrant-exchange.v1` warrant. It reconciles consumer evidence, evidence
  clocks, routeability acceptance, profit freshness, ingestion/materialization proof, active-session TCA, empirical
  replay, market context, rollout image proof, and the live-submission gate before routeability can increase. The
  warrant keeps `max_notional=0`; stale or split dependencies produce zero-notional repair packets mapped to one value
  gate and one expected output receipt. Active-session TCA must also publish a slippage-quality verdict inside the
  route guardrail, with the doc 188 `8` bps average absolute slippage limit as the conservative fallback.
- `GET /trading/status`, `GET /trading/health`, `GET /readyz`, and `GET /trading/consumer-evidence` now expose the
  May 13 doc 191 `torghut.source-serving-repair-receipt-ledger.v1` ledger. It binds repair and routeability evidence
  to the source commit, serving build commit, serving image digest, manifest image digest, and required contract
  canaries. Missing or mismatched source-serving proof keeps the ledger in repair-only zero-notional mode; the Torghut
  release manifest updater now writes `TORGHUT_IMAGE_DIGEST` and `TORGHUT_COMMIT` into runtime/proof surfaces so
  runtime payloads can report the promoted digest and scheduled proof packets can fail closed on stale code lineage.
- `GET /trading/status`, `GET /trading/health`, `GET /readyz`, and `GET /trading/consumer-evidence` now expose the
  May 13 doc 192 `torghut.freshness-carry-ledger.v1` ledger. It derives TA signal, TCA, empirical, market-context,
  quant-evidence, and source-serving freshness dimensions from existing status inputs, emits bounded zero-notional
  repair proof SLOs for non-current dimensions, and keeps `max_notional=0` whenever freshness is partial or
  source-serving proof is not current. Those SLOs also emit `jangar_pressure_refs` with target value gate, output
  receipt, TTL, dedupe key, dispatchability, and `max_notional=0` for pressure-ledger consumers. It is observe-mode
  evidence only; route warrants and live-submission gates remain the capital authority.
- The simple direct-submit lane is no longer an authority bypass in live mode. Before submitting to Alpaca it evaluates
  the same live-submission gate as the scheduler path and persists the gate payload in decision metadata when a
  submission is blocked. Paper-mode simple execution remains unchanged.

## Evidence epochs

The May 5 cross-plane contract is implemented as an additive, shadow-first receipt surface:

- `GET /trading/evidence-epochs/latest` compiles a `torghut.evidence-epoch.v1` payload and persists append-only
  `evidence_epochs` / `evidence_receipts` rows by default.
- `GET /trading/evidence-epochs/{evidence_epoch_id}` returns a persisted epoch by id.
- Query `stage_scope=shadow|research|paper|canary|live|scale` to see the decision that would apply to that stage.
  Shadow stays available while non-shadow scopes quarantine on missing Jangar authority, Torghut health timeouts,
  stale data/empirical jobs, missing artifact parity, or missing portfolio proof.
- Optional artifact parity inputs:
  - `TORGHUT_REQUIRED_IMAGE_PLATFORMS=linux/amd64,linux/arm64`
  - `TORGHUT_OBSERVED_IMAGE_PLATFORMS=linux/amd64,linux/arm64`
  - `TORGHUT_RUNTIME_PULL_FAILURES_JSON='["torghut-sim ImagePullBackOff"]'`

Runtime-closure bundles now also write `runtime-closure/promotion/portfolio-proof-receipt.json`. This does not change
live capital behavior; it gives deployers a receipt id and reason codes before any non-shadow capital request. Rollback
is epoch-scoped: quarantine the active epoch, revert the GitOps image or strategy config through the normal release PR,
and leave prior receipts available for audit.

## Whitepaper workflow (GitHub issue -> Kafka -> AgentRun)

- Kickoff contract in issue body:

```md
<!-- TORGHUT_WHITEPAPER:START -->

workflow: whitepaper-analysis-v1
base_branch: main

<!-- TORGHUT_WHITEPAPER:END -->
```

- Include a `.pdf` attachment URL in the issue body.
- Requeue keyword (GitHub issue comment): post `research whitepaper` on the same issue to re-dispatch a failed run (override keyword with `WHITEPAPER_REQUEUE_COMMENT_KEYWORD`).
- Froussard forwards issue webhook events to Kafka (`WHITEPAPER_KAFKA_TOPIC`) and Torghut consumes them whenever `WHITEPAPER_WORKFLOW_ENABLED=true`.
- Torghut stores source metadata/artifact refs in whitepaper tables, uploads source PDF to Ceph, and dispatches a Codex AgentRun via Jangar (`/v1/agent-runs`) in namespace `agents`.
- Finalization computes deterministic engineering trigger decisions from persisted verdict fields and can auto-dispatch B1 engineering candidates.
- Manual Jangar UI approvals can override below-threshold runs (`approval_source=jangar_ui`) while keeping downstream rollout gates fail-closed.
- Dispatch endpoint uses `WHITEPAPER_AGENTRUN_SUBMIT_URL`; default fallback is `http://agents.agents.svc.cluster.local/v1/agent-runs`.
- Idempotency: `run_id` is deterministic for `(repository#issue_number, attachment_url)` so replays do not create duplicate workflow rows for the same paper in the same issue.
- Optional API auth for manual control endpoints (`/whitepapers/events/github-issue`, `/dispatch-agentrun`, `/finalize`): set `WHITEPAPER_WORKFLOW_API_TOKEN` (or rely on `JANGAR_API_KEY` fallback) and send `Authorization: Bearer <token>`.

Endpoints:

- `GET /whitepapers/status`
- `POST /whitepapers/events/github-issue` (manual replay/debug ingest)
- `POST /whitepapers/runs/{run_id}/dispatch-agentrun`
- `POST /whitepapers/runs/{run_id}/finalize` (AgentRun completion payload)
- `POST /whitepapers/runs/{run_id}/approve-implementation` (manual override B1 dispatch)
- `GET /whitepapers/runs/{run_id}`

## DSPy compile/eval/promotion scaffolding (v5)

- Metric policy: `config/trading/llm/dspy-metrics.yaml`
- Python scaffolding:
  - `app/trading/llm/dspy_programs/` (typed signatures/modules/adapters)
  - `app/trading/llm/dspy_compile/` (compile/eval/promotion artifacts + AgentRun payload builder)
- Runtime gates:
  - `LLM_DSPY_ARTIFACT_HASH=<sha256>` (required for active DSPy runtime)
  - `LLM_DSPY_PROGRAM_NAME`, `LLM_DSPY_SIGNATURE_VERSION`, `LLM_DSPY_TIMEOUT_SECONDS`

AgentRun payload builder (`build_dspy_agentrun_payload`) enforces:

- explicit `idempotencyKey`
- `implementationSpecRef` from DSPy lane catalog
- `vcsPolicy.required=true` with `mode=read-write`
- top-level `ttlSecondsAfterFinished`
- `policy.secretBindingRef`
- string-only `parameters`

Dataset builder helper (matches `torghut-dspy-dataset-build-v1` contract):

```bash
cd services/torghut
uv run python scripts/build_dspy_dataset.py \
  --repository proompteng/lab \
  --base main \
  --head codex/dspy-dataset \
  --artifact-path artifacts/dspy/run-1/dataset-build \
  --dataset-window P30D \
  --universe-ref torghut:equity:enabled
```

Compile helper (matches `torghut-dspy-compile-mipro-v1` contract):

```bash
cd services/torghut
uv run python scripts/compile_dspy_program.py \
  --repository proompteng/lab \
  --base main \
  --head codex/dspy-compile \
  --artifact-path artifacts/dspy/run-1/compile \
  --dataset-ref artifacts/dspy/run-1/dataset-build/dspy-dataset.json \
  --metric-policy-ref config/trading/llm/dspy-metrics.yaml \
  --optimizer miprov2 \
  --schema-valid-rate 0.998 \
  --veto-alignment-rate 0.81 \
  --false-veto-rate 0.02 \
  --fallback-rate 0.02 \
  --latency-p95-ms 1200
```

Eval helper (matches `torghut-dspy-eval-v1` contract):

```bash
cd services/torghut
uv run python scripts/evaluate_dspy_compile.py \
  --repository proompteng/lab \
  --base main \
  --head codex/dspy-eval \
  --artifact-path artifacts/dspy/run-1/eval \
  --compile-result-ref artifacts/dspy/run-1/compile/dspy-compile-result.json \
  --gate-policy-ref config/trading/llm/dspy-metrics.yaml
```

## Feature flags (Flipt)

- Torghut runtime gates are resolved via Flipt boolean evaluations when `TRADING_FEATURE_FLAGS_ENABLED=true`.
- Configure:
  - `TRADING_FEATURE_FLAGS_URL` (feature-flags service URL)
  - `TRADING_FEATURE_FLAGS_NAMESPACE` (default `default`)
  - `TRADING_FEATURE_FLAGS_ENTITY_ID` (default `torghut`)
  - `TRADING_FEATURE_FLAGS_TIMEOUT_MS` (default `500`)
- Canonical flag inventory is in `argocd/applications/feature-flags/gitops/default/features.yaml` (`torghut_*` keys).
- Migration and rollout runbook: `docs/torghut/feature-flags-rollout.md`.

## Autonomy phase manifest contract (governance, canary, rollback)

- Primary authority for rollout governance shape is in `app/trading/autonomy/phase_manifest_contract.py`.
- `build_runtime_and_rollback_governance_payloads(...)` produces all artifacts for the unified runtime governance + rollback proof stage:
  - `runtime_phase` (`runtime-governance`) and `rollback_proof_phase` (`rollback-proof`) phase payloads
  - `runtime_governance` and `rollback_proof` top-level manifest metadata
- `build_phase_manifest_payload_with_runtime_and_rollback(...)` is the single manifest builder used by both lane and scheduler paths:
  - merges canonical runtime and rollback proof phases into the existing manifest phase list
  - rollback evidence is only attached when rollback is actually triggered
  - non-triggered rollback evidence references are dropped from rollback-proof
  - missing evidence while rollback is triggered fails `rollback-proof` via `slo_rollback_evidence_required_when_triggered`
- Phase manifests should be treated as single-source governance evidence for promotion and rollback decisions; avoid manual duplicate assembly outside this helper.
- Profitability manifest `run_context.design_doc` should reference the design document that governed behavior for this run (for example `docs/torghut/design-system/v6/08-profitability-research-validation-execution-governance-system.md`).

## Deploy automation (main -> Argo CD)

- `torghut-ci` validates code changes on PR and push.
- `torghut-build-push` runs on `main` merges touching Torghut sources/scripts, builds/pushes image, and emits a release contract artifact.
- `torghut-release` consumes that artifact, updates `argocd/applications/torghut/knative-service.yaml` digest/version metadata, and opens a release PR (`codex/torghut-release-<tag>`).
- The same release promotion updates `argocd/applications/torghut/db-migrations-job.yaml`, so the migration hook runs with the same image revision.
- `torghut-deploy-automerge` enables squash auto-merge for eligible release PRs.
- Migration safety gate: if the promoted source commit touches `services/torghut/migrations/**`, the release PR is created as draft with `do-not-automerge` and requires manual approval before merge.

## Order-feed ingestion (v3 execution accuracy)

- `TRADING_ORDER_FEED_ENABLED=true` enables Kafka order-update ingestion in the main trading runtime.
- `TRADING_ORDER_FEED_BOOTSTRAP_SERVERS=<host:port,...>` must be set when enabled.
- `TRADING_ORDER_FEED_TOPIC` defaults to `torghut.trade-updates.v1`.
- `TRADING_ORDER_FEED_GROUP_ID` defaults to `torghut-order-feed-v1`.
- `TRADING_ORDER_FEED_CLIENT_ID` defaults to `torghut-order-feed`.
- `TRADING_ORDER_FEED_AUTO_OFFSET_RESET` supports `latest` (default) or `earliest`.
- `TRADING_ORDER_FEED_POLL_MS` (default `250`) controls poll latency.
- `TRADING_ORDER_FEED_BATCH_SIZE` (default `200`) controls max records per poll.

Metrics emitted on `/metrics`:

- `torghut_trading_order_feed_messages_total`
- `torghut_trading_order_feed_events_persisted_total`
- `torghut_trading_order_feed_duplicates_total`
- `torghut_trading_order_feed_out_of_order_total`
- `torghut_trading_order_feed_missing_fields_total`
- `torghut_trading_order_feed_apply_updates_total`
- `torghut_trading_order_feed_consumer_errors_total`

## Historical simulation starter

Use a single command to plan/run/apply/report/teardown historical simulation runs backed by isolated topics + storage:

```bash
cd services/torghut
uv run python -m scripts.historical_simulation_startup \
  --mode plan \
  --run-id sim-2026-02-27-01 \
  --dataset-manifest config/simulation/example-dataset.yaml
```

Run end-to-end lifecycle (`apply -> monitor -> report -> teardown`) with an explicit confirmation phrase:

```bash
cd services/torghut
uv run python -m scripts.historical_simulation_startup \
  --mode run \
  --run-id sim-2026-02-27-01 \
  --dataset-manifest config/simulation/example-dataset.yaml \
  --confirm START_HISTORICAL_SIMULATION
```

If the dataset manifest includes an `autonomy.enabled=true` block, the wrapper now runs the
deterministic autonomous/strategy-factory lane after report generation and writes
`autonomy-report.json` alongside the normal historical-simulation artifacts. That uses explicit
manifest inputs (`signals`, `strategy_config`, `gate_policy`, optional `alpha_*` CSVs) instead of
deriving research fixtures from replay internals.

`--mode apply` remains available for split-run operation:

```bash
cd services/torghut
uv run python -m scripts.historical_simulation_startup \
  --mode apply \
  --run-id sim-2026-02-27-01 \
  --dataset-manifest config/simulation/example-dataset.yaml \
  --confirm START_HISTORICAL_SIMULATION
```

For historical windows, the starter auto-derives
`TRADING_FEATURE_MAX_STALENESS_MS` from `window.start` when no explicit override is supplied.
Set `torghut_env_overrides.TRADING_FEATURE_MAX_STALENESS_MS` only when you want a custom budget.

When `window.profile=us_equities_regular`, the script enforces full U.S. regular session bounds
(`09:30-16:00 America/New_York`, `390` minutes minimum) and fails if coverage is too short.

The manifest can now select `lane: options` with
`schema_version: torghut.options-simulation-manifest.v1`. That lane uses isolated
`torghut.sim.options.*` replay topics plus
`sim_options_contract_bars_1s` / `sim_options_contract_features` /
`sim_options_surface_features` in the simulation ClickHouse database. Example proof-run
manifests live at:

- `config/simulation/options-smoke-open-30m-2026-03-06.yaml`
- `config/simulation/options-full-day-2026-03-06.yaml`

If `argocd.manage_automation=true` in the dataset manifest, `--mode run` automatically sets Torghut
ApplicationSet automation to `manual` during the simulation and restores the prior mode at the end.

For secured Kafka clusters, set `kafka.runtime_*` auth fields in the manifest; the script will inject matching
`TRADING_ORDER_FEED_*` and `TRADING_SIMULATION_ORDER_UPDATES_*` security env vars on the Torghut runtime.

Teardown restores previously captured TA + Torghut runtime config:

```bash
cd services/torghut
uv run python -m scripts.historical_simulation_startup \
  --mode teardown \
  --run-id sim-2026-02-27-01 \
  --dataset-manifest config/simulation/example-dataset.yaml
```

Artifacts are written under `artifacts/torghut/simulations/<run_token>/` for equity runs
and `artifacts/torghut/simulations/options/<run_token>/` for options runs by default:

- `state.json` (pre-simulation cluster config snapshot)
- `source-dump.ndjson` (bounded source-topic dump)
- `run-manifest.json` (apply report)
- `run-state.json` (phase transitions)
- `report/simulation-report.json` (statistical report contract: `torghut.simulation-report.v1`)
- `report/simulation-report.md` (operator summary)
- `report/trade-pnl.csv`
- `report/execution-latency.csv`
- `report/llm-review-summary.csv`

For production execution and empirical evidence capture, use:
`docs/torghut/rollouts/historical-simulation-playbook.md`.

## v3 autonomous lane (phase 1/2 foundation)

Deterministic research -> gate evaluation -> paper candidate patch pipeline:

```bash
cd services/torghut
uv run python scripts/run_autonomous_lane.py \
  --signals tests/fixtures/walkforward_signals.json \
  --strategy-config config/autonomous-strategy-sample.yaml \
  --gate-policy config/autonomous-gate-policy.json \
  --output-dir artifacts/autonomy-lane \
  --repository proompteng/lab \
  --base main \
  --head agentruns/torghut-autonomy \
  --artifact-path artifacts/autonomy-lane \
  --priority-id ARC-2000
```

Outputs:

- `artifacts/autonomy-lane/research/candidate-spec.json`
- `artifacts/autonomy-lane/backtest/walkforward-results.json`
- `artifacts/autonomy-lane/backtest/evaluation-report.json`
- `artifacts/autonomy-lane/gates/gate-evaluation.json`
- `artifacts/autonomy-lane/gates/actuation-intent.json` (governed actuation payload with rollback-readiness evidence links)
- `artifacts/autonomy-lane/paper-candidate/strategy-configmap-patch.yaml` (written when paper is recommended and paper patch preconditions pass)

Safety defaults:

- live promotions are blocked unless gate policy explicitly enables them and approval token requirements are satisfied.
- LLM remains bounded/advisory; deterministic risk/firewall controls remain final authority.

## v3 alpha discovery lane (offline)

Deterministic search -> evaluation -> promotion recommendation pipeline:

```bash
cd services/torghut
uv run python scripts/run_alpha_discovery_lane.py \
  --train-csv /path/to/train-prices.csv \
  --test-csv /path/to/test-prices.csv \
  --output-dir artifacts/alpha-lane \
  --artifact-path artifacts/alpha-lane \
  --repository proompteng/lab \
  --base main \
  --head feature/alpha-discovery \
  --priority-id ARC-1000 \
  --lookbacks 20,40,60 \
  --vol-lookbacks 10,20,40 \
  --target-vols 0.0075,0.01,0.0125 \
  --max-grosses 0.75,1.0 \
  --promotion-target paper
```

Outputs:

- `artifacts/alpha-lane/research/search-result.json`
- `artifacts/alpha-lane/research/best-candidate.json`
- `artifacts/alpha-lane/research/evaluation-report.json`
- `artifacts/alpha-lane/research/recommendation.json`
- `artifacts/alpha-lane/research/candidate-spec.json`
- `artifacts/alpha-lane/stages/candidate-generation-manifest.json`
- `artifacts/alpha-lane/stages/evaluation-manifest.json`
- `artifacts/alpha-lane/stages/promotion-recommendation-manifest.json`
- `artifacts/alpha-lane/notes/iteration-<n>.md` (appended per run)

Fail-safe controls:

- promotion decision is fail-closed: any gate failure marks the recommendation as denied.
- evidence lineage and replay artifact hashes are persisted in `candidate-spec.json`.

## v3 orchestration guard CLI

Validate stage transitions and retry/failure actions with policy-driven guardrails:

```bash
cd services/torghut
uv run python scripts/orchestration_guard.py check-transition \
  --state artifacts/orchestration/candidate-state.json \
  --candidate-id cand-abc123 \
  --run-id run-abc123 \
  --from-stage gate-evaluation \
  --to-stage shadow-paper \
  --previous-artifact artifacts/gates/cand-abc123/report.json \
  --previous-gate-passed \
  --risk-controls-passed \
  --execution-controls-passed \
  --mode gitops
```

```bash
cd services/torghut
uv run python scripts/orchestration_guard.py evaluate-failure \
  --state artifacts/orchestration/candidate-state.json \
  --stage candidate-build \
  --failure-class transient \
  --attempt 2
```
