# 99. Torghut Profit Proof Escrow And Repair Dividend SLO (2026-05-05)

Status: Accepted for engineer and deployer handoff

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented: metrics/renderers, structured logs and OpenTelemetry, guardrail exporters, and operational manifests exist; full SLO/on-call process is mostly doc/runbook-level.
- Matched implementation area: Observability, metrics, traces, alerts, and operations.
- Current source evidence:
  - `services/torghut/app/metrics/core.py`
  - `argocd/applications/torghut/llm-guardrails-exporter.yaml`
  - `argocd/applications/torghut/clickhouse/clickhouse-guardrails-exporter.yaml`
  - `docs/torghut/production-readiness-proof-runbook.md`
- Design drift note: Operational docs need runtime status and alerting readback before being treated as complete.


## Decision

Torghut should publish a **profit proof escrow** that Jangar can consume as a launch-escrow input, not as a trading
permission shortcut.

The current system is broker-safe: live submission is blocked, capital is shadow, and no hypothesis is promotion
eligible. That is good. The profitability problem is that stale empirical jobs and zero executions do not yet turn into
a ranked repair queue with measurable expected value. Torghut should score every zero-notional repair by expected proof
freshness gain, expected capital unlock value, route cost, and falsification risk. Jangar then uses that score only to
decide which repair can spend scarce launch capacity.

The tradeoff is discipline over speed. We will delay paper/live capital until proof escrow has real execution and TCA
evidence, even if historical simulations look attractive.

## Evidence Snapshot

All evidence for this pass was read-only.

- Torghut `/db-check` returned `ok=true`, current/expected Alembic head
  `0029_whitepaper_embedding_dimension_4096`, no missing heads, no unexpected heads, and lineage-ready state with known
  parent-fork warnings.
- Torghut `/readyz` and `/trading/health` returned HTTP 503 but with structured data: Postgres, ClickHouse, Alpaca, and
  database schema were OK; live submission was blocked by `simple_submit_disabled`; capital stage was `shadow`.
- Alpha readiness reported three hypotheses, zero promotion-eligible hypotheses, and three rollback-required hypotheses.
- `/trading/empirical-jobs` returned four stale completed jobs: `benchmark_parity`, `foundation_router_parity`,
  `janus_event_car`, and `janus_hgrm_reward`.
- `/trading/profitability/runtime` returned a 72-hour window with 8 decisions, 0 executions, and 0 TCA samples.
- Options catalog `/healthz` returned `ready=true` while `last_success_ts=null` and last error detail was a timeout.
- ClickHouse guardrail metrics showed both replicas reachable, free-disk ratios around 0.97, no read-only replicated
  tables, fresh TA timestamps, and nonzero low-memory fallback counters.

## Problem

Torghut has enough proof to keep capital closed, but not enough structure to rank the next repair by profitability.
That leaves three gaps:

1. Stale empirical jobs are named, but the system does not attach a repair dividend to refreshing each job.
2. Historical or simulated profit evidence can be present while live execution and TCA evidence are zero.
3. Jangar sees degraded empirical jobs but cannot know which repair has the best expected payoff per launch budget.

Profitability should improve through controlled repair, not by relaxing capital gates.

## Alternatives Considered

### Option A: Refresh All Stale Empirical Jobs On The Next Window

Pros:

- Simple operator model.
- Restores freshness if capacity is available.

Cons:

- Treats all stale proof as equal.
- Can overload route and workflow budgets during degraded control-plane windows.
- Does not record which repair actually unlocked value.

Decision: reject as the default. It can be an emergency manual action, not the architecture.

### Option B: Promote The Best Historical Candidate To Paper Capital

Pros:

- Directly tests profitability.
- Shortens time to observed trading data.

Cons:

- Current runtime has zero executions and zero TCA samples.
- Live submission is explicitly disabled.
- Empirical jobs are stale and dependency quorum is blocked.

Decision: reject. This violates the current guardrails.

### Option C: Profit Proof Escrow And Repair Dividend SLO

Pros:

- Converts stale proof into ranked zero-notional repair.
- Keeps capital fail-closed until execution realism is present.
- Gives Jangar a measurable repair value for launch escrow.
- Preserves falsification pressure by requiring every repair to name success and rollback evidence.

Cons:

- Requires another compact proof object.
- Needs route-cost and data-freshness instrumentation to avoid optimistic scoring.

Decision: select Option C.

## Chosen Architecture

Torghut emits one `profit_proof_escrow` sample per proof window:

```text
profit_proof_escrow
  escrow_id
  generated_at
  fresh_until
  schema_head
  hypothesis_summary
  empirical_jobs
  profitability_runtime
  execution_realism
  tca_summary
  route_cost
  repair_candidates
  capital_reentry_decision
  evidence_refs
```

Each `repair_candidate` carries:

```text
repair_candidate
  repair_id
  target
  stale_reason
  expected_freshness_gain
  expected_capital_unlock_value
  route_budget_ms
  max_runtime_seconds
  falsification_check
  success_evidence_ref
  rollback_trigger
```

The repair dividend is:

```text
expected_capital_unlock_value * probability_of_success - route_cost - falsification_risk_cost
```

The score is not money to trade. It is a scheduling priority for zero-notional repair.

## Capital Guardrails

Paper or live capital remains blocked until all of these are true:

- database schema is current and lineage ready;
- empirical jobs are fresh or explicitly waived by a current proof escrow;
- dependency quorum is allow;
- live submission is not blocked by `simple_submit_disabled`;
- execution count is greater than zero in the active window;
- TCA sample count is greater than zero and within tolerance;
- no hypothesis is in rollback-required state for the selected capital lane;
- Jangar launch escrow for the capital action class is fresh.

## Implementation Scope

Engineer stage:

- Add a deterministic proof-escrow builder using existing empirical jobs, hypothesis runtime, profitability runtime, and
  guardrail metrics.
- Persist or cache escrow samples with digest and freshness.
- Add route output that Jangar can consume without calling the heavy trading status path.
- Add tests for the current degraded state: stale empirical jobs, zero executions, zero TCA samples, shadow capital, and
  options catalog ready without success timestamp.

Deployer stage:

- Verify the proof escrow route answers within the declared route budget.
- Verify zero-notional repair candidates are ranked and include success evidence.
- Verify paper/live capital remains blocked until execution and TCA evidence are nonzero.

## Rollout And Rollback

Rollout starts in shadow mode. Jangar may read the proof escrow and log repair rankings, but no schedule enforcement
depends on it until the Jangar settlement SLO is live. After shadow parity, Jangar may spend zero-notional repair launch
escrow on the highest positive repair dividend.

Rollback is simple: disable proof-escrow consumption in Jangar, keep Torghut capital blocked, and fall back to the
existing empirical-job degraded status. Do not promote capital as a rollback workaround.

## Handoff

The next profitable move is not live capital. It is proof freshness repair. Refresh or rerun the stale empirical jobs
with the highest repair dividend, prove execution realism with zero-notional or paper-safe samples, then let Jangar
settlement decide whether capital can reenter. If the proof escrow cannot name a positive repair dividend, do not spend
launch capacity on that repair.
