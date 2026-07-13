# 93. Torghut Recovery Budget Profit Ladder and Session Cost Ledger (2026-05-05)

Status: Accepted for engineer and deployer handoff

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented: metrics/renderers, PostHog hooks, guardrail exporters, and operational manifests exist; full SLO/on-call process is mostly doc/runbook-level.
- Matched implementation area: Observability, metrics, PostHog, alerts, and operations.
- Current source evidence:
  - `services/torghut/app/metrics/core.py`
  - `argocd/applications/torghut/llm-guardrails-exporter.yaml`
  - `argocd/applications/torghut/clickhouse/clickhouse-guardrails-exporter.yaml`
  - `docs/torghut/production-readiness-proof-runbook.md`
- Design drift note: Operational docs need runtime status and alerting readback before being treated as complete.


## Decision

Torghut should add a **RecoveryBudgetProfitLadder** and a **SessionCostLedger** that consume Jangar settlement
authority before spending proof or capital budget.

The current state is safe at the broker boundary but weak for profitability. Live service health is up, the schema is
current, options catalog readiness has recovered, and live submission is blocked. At the same time, Jangar status fetch
from Torghut failed with connection refused, empirical jobs are stale from March 21, the latest live decision is from
May 4, all active hypotheses have zero capital multiplier, none are promotion eligible, and all require rollback.

I am choosing a profit ladder that spends scarce recovery budget in this order:

1. keep broker exposure blocked while Jangar settlement is closed;
2. fund cheap session-cost measurement and zero-notional replay;
3. repair stale empirical and options proof when the expected information value beats the database/route cost;
4. open paper probes only after Jangar `paper_submit` settlement and Torghut profit receipts are fresh;
5. open live probes only after Jangar `live_submit` settlement, causal replay, TCA, and rollback proof are fresh.

This turns blocked market time into measured proof work instead of repeated readiness polling.

## Evidence Snapshot

All cluster and database checks for this pass were read-only.

### Runtime and Route Evidence

- Torghut live revision `torghut-00222` was Running and `/healthz` returned HTTP 200.
- `/readyz` returned `status=degraded`; the live gate was blocked by `simple_submit_disabled`, capital stage was
  `shadow`, configured live promotion was false, and promotion-eligible total was zero.
- `/trading/status` reported build `v0.568.5-16-g59511b6b6`, commit
  `59511b6b6af8b160aaf00b9fb5f44b7a62c61c5c`, active revision `torghut-00222`, and
  `last_decision_at=2026-05-04T17:25:57.901670Z`.
- The hypothesis summary reported three hypotheses: `H-CONT-01`, `H-MICRO-01`, and `H-REV-01`. All had capital
  multiplier `0`; zero were promotion eligible; three required rollback.
- The hypothesis dependency quorum was `unknown` with reason `jangar_status_fetch_failed` because Jangar status fetch
  failed with connection refused.
- `/db-check` returned `ok=true`, `schema_current=true`, current and expected head
  `0029_whitepaper_embedding_dimension_4096`, no missing or unexpected heads, no duplicate revisions, no orphan
  parents, and known parent-fork lineage warnings.
- Direct SQL was blocked by Kubernetes RBAC because this identity cannot create `pods/exec` in the Torghut namespace.

### Profit and Data Evidence

- Empirical jobs were `ready=false`, `status=degraded`, `authority=blocked`, and stale for
  `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and `janus_hgrm_reward`.
- The stale empirical evidence cites dataset snapshot `torghut-full-day-20260318-884bec35`. That proof can be truthful
  and still too stale for capital.
- Continuation and event-reversion hypotheses were in `shadow`; microstructure breakout was `blocked`.
- The active hypotheses reported signal lag just over the 90 second threshold and high historical average absolute
  slippage in the status payload.
- The options catalog returned `/readyz` as ready during this pass, but the shared evidence immediately before this run
  showed a catalog cycle failure caused by an oversized `ANY(symbols)` query. Source still contains `contract_symbol =
ANY(:symbols)` paths in the options repository.
- Jangar quant-health could not be used as a current proof input when the Jangar service refused connections.

### Source Evidence

- `services/torghut/app/trading/submission_council.py::build_live_submission_gate_payload` already has strong proof
  vocabulary: dependency quorum, empirical jobs, quant evidence, DSPy readiness, promotion certificates, capital
  stage, reason codes, segment summaries, and lineage references.
- `services/torghut/app/main.py::_build_live_submission_gate_payload` still short-circuits simple live mode through a
  local toggle path and returns `dependency_quorum_decision=informational_only`.
- `services/torghut/app/trading/empirical_jobs.py::build_empirical_jobs_status` already classifies stale jobs and
  authority.
- `services/torghut/app/options_lane/catalog_service.py` now publishes provisional hot-set readiness while discovery
  is still running. That is useful for serving, but capital needs a stronger distinction between a usable cache and
  current capital-relevant catalog proof.

## Problem

Torghut is not currently unsafe because live submission is blocked. The profitability problem is that the system does
not spend blocked time well enough.

Three things are true at once:

1. broker exposure must stay closed while Jangar settlement is closed or unknown;
2. proof debt is real: stale empirical jobs and missing Jangar quant health prevent capital progress;
3. not all proof work has equal value or cost.

If the system keeps retrying expensive stale proof producers, it competes with Jangar recovery and delays the proof that
would actually unlock profitable paper or live capital. If it freezes everything, it loses market sessions without
learning.

## Alternatives Considered

### Option A: Keep All Capital Frozen Until Every Dependency Is Green

Require Jangar status, quant health, empirical jobs, options catalog, market context, TCA, and local toggles to all be
green before any proof or capital work advances.

Pros:

- Very safe at the broker boundary.
- Simple to explain.
- Avoids spending proof budget during platform instability.

Cons:

- Stops zero-notional learning when the market is open.
- Treats cheap replay the same as live order admission.
- Does not repair stale empirical proof.
- Gives no ranking for options, quant, or market-context recovery work.

Decision: keep as emergency posture only.

### Option B: Locally Repair Empirical Jobs and Options Queries

Chunk the options `ANY(symbols)` query, rerun empirical jobs, and keep capital blocked until the existing readiness
routes go green.

Pros:

- Directly addresses two observed blockers.
- Small implementation surface.
- Improves local Torghut readiness.

Cons:

- Does not consume Jangar settlement authority.
- Can still over-spend database and route budget during Jangar recovery.
- Does not decide whether replay, catalog repair, or empirical refresh is the next highest-value proof unit.
- Leaves simple live mode outside the proof-aware council.

Decision: required tactical work, but not sufficient architecture.

### Option C: RecoveryBudgetProfitLadder and SessionCostLedger

Rank proof work by expected capital unlock value, falsification value, and cost. Consume Jangar settlement authority as
the external platform gate. Keep broker exposure blocked while funding zero-notional and repair work that can produce
fresh profit evidence without widening risk.

Pros:

- Converts blocked market time into measured learning.
- Prevents Torghut proof producers from worsening Jangar pressure.
- Gives options and empirical repair a shared cost language.
- Makes paper/live capital depend on both Jangar settlement and Torghut profit evidence.
- Closes the simple-mode bypass by requiring the same settlement authority field.

Cons:

- Adds scoring rules that must be kept honest.
- Requires staged enforcement to avoid starving useful background work.
- Needs conservative defaults when expected information value is unknown.

Decision: select Option C.

## Chosen Architecture

### SessionCostLedger

Every proof-producing session writes a compact cost and outcome record.

```text
session_cost_ledger
  ledger_id
  session_id
  market_session
  producer                    # empirical_jobs, quant_health, options_catalog, replay, market_context, tca
  hypothesis_id
  account_scope
  jangar_settlement_decision
  jangar_settlement_ref
  route_ms
  database_ms
  rows_read
  rows_written
  parameter_bytes
  proof_outcome               # learned, falsified, unchanged, timed_out, blocked
  expected_information_value
  realized_information_value
  capital_unlock_class        # none, replay, paper_probe, live_probe, live_scaled
  observed_at
  fresh_until
  reason_codes
```

Rules:

- If Jangar settlement is `hold` or `block`, live and paper submissions remain blocked.
- Zero-notional replay can continue under Jangar `repair_only` when it does not require expensive Jangar route proof.
- A proof producer with repeated timeouts or over-budget reads loses priority until its query shape changes.
- A stale but truthful empirical job counts as proof debt, not capital authority.

### RecoveryBudgetProfitLadder

The ladder picks the next work unit:

```text
profit_priority_score =
  expected_information_value
  + falsification_value
  + capital_unlock_value
  - database_cost
  - route_cost
  - stale_retry_penalty
  - jangar_settlement_penalty
```

Ladder:

1. `blocked`: live submission off, collect only cheap health and ledger data.
2. `observe`: run session-cost measurement and no-order replay.
3. `repair`: fund empirical refresh, options catalog chunking, or quant mirror repair when value exceeds cost.
4. `paper_probe`: allow paper only when Jangar `paper_submit=allow` and profit receipts are fresh.
5. `live_probe`: allow live canary only when Jangar `live_submit=allow`, TCA is fresh, rollback proof is current, and
   expected post-cost edge beats the configured threshold.
6. `live_scaled`: scale only after live probe receipts settle across the configured sessions.

### CapitalAdmissionContract

Every live gate payload must include:

```text
capital_admission_contract
  jangar_settlement_decision
  jangar_settlement_ref
  recovery_budget_stage
  latest_session_cost_ledger_id
  empirical_jobs_fresh
  options_catalog_capital_relevant
  quant_health_fresh
  tca_fresh
  rollback_ready
  decision
  reason_codes
```

Simple mode cannot reduce cross-plane authority to `informational_only`. It can still keep local toggles, but Jangar
settlement and proof freshness must be part of the decision payload before paper or live capital opens.

## Engineer Scope

1. Add pure `SessionCostLedger` and `RecoveryBudgetProfitLadder` builders with deterministic fixtures.
2. Add a typed Jangar settlement authority input to Torghut status and submission-council paths.
3. Remove the simple live-mode bypass by making `_build_live_submission_gate_payload` call the proof-aware council or
   compose the same authority fields.
4. Add options catalog cost receipts for page count, parameter bytes, rows read, rows written, and cycle duration.
5. Chunk `ANY(symbols)` paths or replace them with bounded temp-table/page reads before they can become
   capital-relevant proof.
6. Mark provisional hot-set readiness as `serve_catalog_cache`; require a separate `capital_relevant_catalog_current`
   proof for capital.
7. Add empirical job refresh priority from stale age, hypothesis impact, and expected information value.
8. Add tests that Jangar `hold` blocks paper/live even when local schema and `/healthz` are green.

## Validation Gates

- Unit: simple live mode with `simple_submit_enabled=true` still blocks when Jangar settlement is `hold`.
- Unit: stale empirical jobs are truthful proof debt, not capital authority.
- Unit: options catalog over-budget cost receipt yields `repair` or `hold`, not `paper_probe`.
- Unit: zero-notional replay is allowed under `repair_only` when route/database costs are within budget.
- Unit: paper probe requires Jangar `paper_submit=allow`, fresh empirical proof, fresh quant health, and current
  rollback proof.
- Integration: `/trading/status` includes the capital admission contract with Jangar settlement ref and latest
  session-cost ledger id.
- Integration: `/readyz` can be degraded for capital while `/healthz` remains healthy.

## Rollout Plan

1. Ship ledger and ladder builders in shadow mode.
2. Project the capital admission contract in `/trading/status` and `/readyz` without changing live gate behavior.
3. Record one full market session of cost ledger entries for empirical, options, quant, replay, and TCA producers.
4. Enforce Jangar settlement holds for paper first.
5. Enforce options catalog capital relevance after query chunking and cost receipts are stable.
6. Enforce live probe admission only after two sessions of paper and zero-notional evidence show no false allows.

## Rollback Plan

- Set ladder enforcement to `shadow`; continue emitting ledger entries.
- If ledger writes add pressure, switch to local file or in-memory aggregation with periodic low-priority flush.
- If simple-mode unification blocks emergency operations, keep broker kill switch on and explicitly waive through an
  incident record rather than removing settlement fields.
- If options catalog chunking under-serves the hot set, fall back to cached `serve_catalog_cache` while holding
  `capital_relevant_catalog_current`.

## Risks and Tradeoffs

- The ladder may underfund a slow but valuable proof producer. Mitigation is explicit falsification value and manual
  override with a ledger entry.
- Expected information value can be gamed if it is only producer supplied. Mitigation is to compare expected and
  realized value by session.
- Keeping replay open during brownout is safer than live capital but still uses compute and some data budget. It must
  remain bounded by Jangar settlement and Torghut cost receipts.
- Profitability improves only if we stop treating "safe" as the final state. Safe shadow mode is the floor; fresh,
  costed, causal proof is the path to profitable capital.

## Handoff Contract

Engineer acceptance gates:

- Live gate payloads include Jangar settlement authority in both simple and non-simple modes.
- Session-cost ledger builders and options cost receipts are tested.
- Options catalog distinguishes cache-serving readiness from capital-relevant catalog proof.
- Empirical stale jobs feed the recovery ladder with expected information value and stale age.

Deployer acceptance gates:

- No paper or live capital opens unless Jangar settlement is `allow` for the matching action class.
- If Jangar settlement is `hold`, deployer expects Torghut `/healthz` to stay green while `/readyz` remains degraded for
  capital.
- Rollback is to shadow enforcement plus existing local gate behavior, with broker exposure still disabled by toggles.
