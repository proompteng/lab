# 86. Torghut Profit Debt Ledger and Repair SLA Experiments (2026-05-05)

Status: Approved for implementation (`discover`)

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

Torghut should add a **Profit Debt Ledger** and **Repair SLA Experiments** on top of profit evidence leases. When
non-shadow capital is held, Torghut should not only report the blocker. It should record the estimated opportunity
debt, the proof gap that caused the hold, the repair experiment that can close the gap, the deadline, and the capital
stage that becomes eligible if the experiment succeeds. Capital stays in shadow until proof is fresh, but blocked
market time becomes ranked learning work instead of idle status.

I am choosing this because the current evidence shows the right broad capital posture but a weak profitability loop.
Torghut is alive, schema-current, and shadow-safe. `/trading/health` is 503 because live submission is held, and
`/trading/status` reports `capital_stage=shadow`, `promotion_eligible_total=0`, and three rollback-required
hypotheses. Empirical jobs are truthful but stale from March 21, quant evidence is not configured, Jangar dependency
quorum blocks on empirical jobs, signal continuity is alerting, and Jangar proof routes timed out in this sample.

The profitable move is not to bypass those holds. The profitable move is to assign each hold an experiment that can
prove or falsify a capital unlock quickly.

## Scope and Success Metrics

This contract defines the Torghut-side consumer of Jangar authority-clearance cells. It does not authorize broker
orders directly. Broker admission still needs an order warrant and a fresh profit evidence lease.

Success means:

1. every non-shadow capital hold creates one or more profit-debt records with typed blockers;
2. every profit-debt record links to either a Jangar `external_capital` clearance cell, a local proof gap, or both;
3. every repair experiment has a bounded runtime budget, expected proof output, stop condition, and promotion ceiling;
4. stale empirical jobs, missing quant health, signal-continuity alerts, feature gaps, drift gaps, and Jangar platform
   holds are ranked by expected capital unlock value;
5. shadow, observe, replay, and repair continue while paper/live capital remains held.

## Evidence Snapshot

All cluster and database checks were read-only.

### Cluster and Rollout Evidence

Torghut was operational but not quiet:

- `kubectl get pods -n torghut -o wide` showed the main Torghut revision, simulation revision, Postgres, ClickHouse,
  Keeper, websocket forwarders, options services, TA services, exporters, Symphony, and Alloy running.
- Torghut DB and ClickHouse pods had recent restarts during the broader cluster window.
- Events showed `torghut-db-migrations`, `torghut-whitepaper-semantic-backfill`,
  `torghut-whitepapers-bootstrap`, and `torghut-empirical-jobs-backfill` jobs completing or turning over.
- Events also showed startup/readiness probe failures during revision turnover, scheduling pressure for backfills, and
  ClickHouse pods matching multiple PodDisruptionBudgets.

Interpretation: the system can produce evidence and repair work, but rollout and data-plane context should remain part
of capital proof.

### Runtime API Evidence

Application routes showed mixed readiness:

- `/healthz` returned HTTP 200 with `{"status":"ok","service":"torghut"}`.
- `/db-check` returned HTTP 200 with `ok=true`, `schema_current=true`, current head
  `0029_whitepaper_embedding_dimension_4096`, and `schema_graph_lineage_ready=true`.
- `/trading/health` returned HTTP 503 because `live_submission_gate.ok=false` with detail `simple_submit_disabled`.
- `/readyz` also returned HTTP 503 with database schema proof healthy but live submission held.
- `/trading/status` reported mode `live`, execution lane `simple`, `kill_switch_enabled=false`,
  `live_submission_gate.allowed=false`, `reason=simple_submit_disabled`, and `capital_stage=shadow`.
- The same status payload reported three hypotheses, two shadow and one blocked, all `capital_multiplier=0`,
  `promotion_eligible_total=0`, and `rollback_required_total=3`.
- Signal continuity was actionable but alerting on `cursor_tail_stable`.

Interpretation: Torghut should keep observing and replaying, but no current evidence supports non-shadow capital.

### Database, Data, and Profit Evidence

Direct SQL was unavailable because the runner service account cannot create `pods/exec` in the `torghut` namespace.
Application routes still exposed enough proof to hold capital:

- empirical jobs `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and `janus_hgrm_reward` were all
  stale, with proof artifacts created on `2026-03-21T09:03Z`;
- Jangar dependency quorum was `block` with reason `empirical_jobs_degraded`;
- quant evidence reported `status=not_required` and `reason=quant_health_not_configured`;
- feature batch rows, drift detection checks, and evidence continuity checks were zero in the live status metrics;
- TCA evidence had `order_count=13775`, but `last_computed_at=2026-04-02T20:59:45.136640Z` and average absolute
  slippage around `568.6` bps;
- Jangar quant-health and market-context proof routes timed out after 8 seconds from this runner.

Interpretation: schema is current, but profit proof is stale or missing. The correct capital posture is shadow plus
repair experiments.

## Problem

Torghut already explains many blockers, but explanation is not prioritization. During a held capital window, several
things can be true at once:

1. empirical artifacts are stale;
2. quant health is not configured;
3. signal continuity is alerting;
4. market context may be stale or unreachable;
5. Jangar platform authority may hold `external_capital`;
6. a hypothesis may still produce useful shadow decisions.

If each blocker is treated as equally urgent, the next market session is spent on whatever alert is loudest. The system
needs to rank blockers by expected profitability impact and by the probability that repairing the blocker unlocks a
capital stage safely.

## Options Considered

### Option A: Manual Repair Queue

Keep the current shadow-only posture and let operators choose whether to refresh empirical jobs, configure quant
health, repair signal continuity, or rerun strategy experiments.

Pros:

- low runtime complexity;
- safe for broker capital;
- easy to start immediately.

Cons:

- no economic priority;
- weak audit trail for why one repair won;
- repair work may chase liveness instead of profit;
- hard to measure opportunity cost while capital is held.

Decision: reject. It is safe but too slow for profitable autonomy.

### Option B: Capital Marketplace Reads Raw Status

Let the capital guardrail marketplace read raw status routes, empirical jobs, TCA, and Jangar routes directly, then rank
hypotheses and repairs.

Pros:

- direct route to capital allocation;
- uses existing marketplace concepts;
- can rank hypotheses quickly.

Cons:

- repeats heavy request-time proof reads;
- route timeouts become marketplace stalls;
- mixes current proof with stale historical artifacts;
- broker admission still lacks one durable proof id.

Decision: reject until proof is leased and debt is recorded.

### Option C: Profit Debt Ledger With Repair SLA Experiments

Record capital holds as profit debt. Score each debt by expected information value, capital unlock probability, and
downside risk. Launch only bounded repair experiments whose output can close a debt or falsify a hypothesis.

Pros:

- keeps capital safe while making blocked time productive;
- ties repair priority to measurable profit hypotheses;
- creates an audit trail for why a repair ran;
- gives Jangar clearance cells a Torghut-side economic consumer;
- separates counterfactual replay from executable capital proof.

Cons:

- adds storage and scoring work;
- expected value estimates can be wrong and need conservative caps;
- requires route, scheduler, and broker-parity tests.

Decision: select Option C.

## Chosen Architecture

### ProfitDebtRecord

Torghut should persist or materialize one record per account/window/hypothesis blocker:

```text
profit_debt_record
  debt_id
  account
  window
  hypothesis_id
  strategy_family
  release_digest
  jangar_clearance_cell_id
  profit_evidence_lease_id
  blocker_code
  blocker_evidence_refs
  capital_stage_blocked
  capital_stage_ceiling_after_repair
  estimated_opportunity_bps
  expected_information_value
  expected_capital_unlock_probability
  downside_risk_score
  priority_score
  opened_at
  due_at
  state                     # open, experiment_running, closed, falsified, expired
```

The ledger should be append-oriented. A debt is closed by proof, not by disappearance from a status route.

### RepairSlaExperiment

Each selected debt creates a bounded experiment:

```text
repair_sla_experiment
  experiment_id
  debt_id
  experiment_kind            # empirical_refresh, quant_health_config, replay, signal_repair, market_context_refresh
  hypothesis
  expected_output_refs
  max_runtime_minutes
  max_compute_budget
  max_notional               # must be zero for repair-only and replay experiments
  stop_condition
  success_condition
  falsification_condition
  started_at
  expires_at
  result_refs
```

Repair experiments do not authorize broker capital. They produce or refresh evidence that can later support a profit
evidence lease and order warrant.

### Scoring Rules

Initial scoring should be conservative:

- stale empirical jobs rank high when they block all hypotheses and can be refreshed without live capital;
- quant-health configuration ranks high when Jangar route proof is missing for the account/window;
- signal-continuity repair ranks high during market hours if it affects all hypotheses;
- market-context refresh ranks high only for hypotheses that require market-context freshness;
- drift and feature gaps rank high for microstructure hypotheses but should not block unrelated continuation lanes;
- stale TCA ranks high only if recent execution or replay samples exist to evaluate.

The priority score should downweight any experiment that requires widening Jangar rollout, broker capital, or privileged
database access.

## Implementation Scope

Engineer-stage work should land in bounded slices:

1. Add a `ProfitDebtRecord` builder from `/trading/status`, `/trading/health`, empirical jobs, Jangar dependency
   quorum, and Jangar clearance cells.
2. Add route fields showing open profit debt counts and top blockers without changing broker admission.
3. Add scheduler output that records repair SLA experiments for stale empirical jobs, quant-health configuration,
   signal-continuity repair, and replay.
4. Add broker-admission tests proving open debt cannot authorize non-shadow capital.
5. Add replay and empirical-refresh tests proving repair experiments can close or falsify debts.

## Validation Gates

Required local validation for implementation PRs:

- `uv run --frozen pytest services/torghut/tests/test_trading_api.py -k \"live_submission_gate or empirical_jobs\"`
- `uv run --frozen pytest services/torghut/tests/test_submission_council.py`
- `uv run --frozen pytest services/torghut/tests/test_trading_scheduler_safety.py`
- all three required Torghut Pyright profiles when runtime code changes touch `services/torghut`.

Required deployed validation:

- `/trading/status`, `/trading/health`, scheduler snapshots, and broker admission show the same open-debt digest;
- current May 5 style evidence produces debt records and `capital_stage=shadow`;
- a stale empirical-job repair experiment can refresh proof without broker capital;
- closing one debt does not clear unrelated Jangar platform holds or unrelated hypothesis blockers.

## Rollout Plan

1. **Shadow ledger:** emit profit debt records and repair experiment recommendations with no scheduler behavior change.
2. **Route parity:** expose the same open-debt digest through status, health, readyz, and control-plane snapshots.
3. **Repair scheduling:** allow bounded repair experiments to run from open debts.
4. **Capital gate integration:** require no open capital-blocking debt before paper or live broker warrants.
5. **Auction integration:** let the capital marketplace allocate canary budget only to hypotheses with fresh leases and
   no open high-severity debt.

## Rollback Plan

Rollback must preserve learning:

- disable debt enforcement before disabling debt emission;
- keep shadow, observe, replay, and repair routes running;
- do not delete historical debt or experiment records;
- return broker admission to the prior profit evidence lease and warrant policy;
- publish a rollback note that lists any open debts ignored by the rollback.

## Risks and Tradeoffs

The main risk is false precision in expected value scoring. Early scoring should be ordinal and conservative. A repair
that can safely refresh global proof should outrank a speculative strategy experiment, but no score should bypass
capital warrants.

The second risk is repair-loop churn. Experiments need budgets and stop conditions. If a route keeps timing out or an
empirical job keeps going stale, the ledger should escalate the debt rather than repeatedly launching the same repair.

The tradeoff is slower paper/live reentry. I accept that because the objective is profitable capital allocation. Shadow
evidence without ranked repair is safe but not enough.

## Handoff Contract

Engineer acceptance gates:

- build profit-debt records from current status and Jangar clearance inputs;
- add route-parity tests for status, health, readyz, scheduler snapshots, and broker admission;
- add repair experiment fixtures for stale empirical jobs, missing quant health, signal-continuity alerts, feature
  gaps, and drift gaps.

Deployer acceptance gates:

- do not promote Torghut capital while high-severity profit debt is open for the account/window;
- verify that disabling enforcement leaves debt emission and repair recommendations visible;
- capture debt digest and top blockers in release handoffs.

Jangar handoff:

- publish `external_capital` clearance cells with stable digests;
- keep least-privilege route proof available so Torghut can cite platform holds without database exec;
- treat Torghut debt closure as local profit proof, not as platform clearance by itself.
