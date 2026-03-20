# 60. Torghut Hypothesis Passports and Profit Guardrail Admission Contract (2026-03-20)

Status: Approved for implementation (`plan`)
Date: `2026-03-20`
Owner: Victor Chen (Jangar Engineering)
Mission: `codex/swarm-jangar-control-plane-plan`
Swarm impacts:

- `jangar-control-plane`
- `torghut-quant`

Companion doc:

- `docs/agents/designs/61-jangar-runtime-kit-ledger-and-execution-class-admission-contract-2026-03-20.md`

Extends:

- `59-torghut-lane-balance-sheet-and-dataset-seat-auction-contract-2026-03-20.md`
- `58-torghut-profit-cohort-auction-and-freshness-insurance-contract-2026-03-20.md`
- `55-torghut-hypothesis-settlement-exchange-and-lane-capability-leases-2026-03-20.md`

## Executive summary

The decision is to make every profitability decision depend on a durable **Hypothesis Passport** and a
**Profit Guardrail Admission**. Torghut will stop treating fresh quant metrics, stale market-context evidence, and
failing simulation history as one blended readiness impression. Each tradeable hypothesis will instead prove the exact
dataset seat, execution admission, simulation proof, and guardrail state that authorized it.

The reason is visible in live data on `2026-03-20`:

- `torghut_control_plane.quant_metrics_latest`
  - `504` rows
  - `latest_as_of=2026-03-20T22:40:11.868Z`
- `torghut_control_plane.quant_alerts`
  - `29` rows with `1` still open
- `torghut_control_plane.quant_pipeline_health`
  - `9,582,819` rows total
  - `3,195,032` failing rows overall
  - last-hour sample still shows `ingestion` entirely `ok=false`
- `torghut_market_context_snapshots`
  - only `25` rows
  - `latest_as_of=2026-03-16T19:36:22.853Z`
- `torghut_market_context_runs`
  - `11` nonterminal rows
  - one row still `running` from `2026-03-11`
- `torghut_control_plane.simulation_runs`
  - `58` rows total with `40` in `failed` status
  - latest updates stop at `2026-03-19T10:08:32.162Z`
- `torghut_control_plane.simulation_lane_leases`
  - `4` rows
  - all lanes currently `available`, none actively bound to proof work

The tradeoff is more additive state and stricter live-capital rules. I am keeping that trade because the current
profitability failure mode is false confidence: one fresh surface can look healthy while the market-context and
simulation evidence required to trust it are already stale.

## Mission inputs and success criteria

Observed mission inputs:

- repository: `proompteng/lab`
- base: `main`
- head: `codex/swarm-jangar-control-plane-plan`
- swarmName: `jangar-control-plane`
- swarmStage: `plan`
- objective: improve Jangar resilience and define Torghut profitability architecture with measurable hypotheses and
  guardrails

This artifact succeeds when:

1. every tradeable Torghut hypothesis can cite one `hypothesis_passport_id`, one `dataset_seat_id`, and one
   `execution_admission_id`;
2. stale market context, simulation debt, and quant-ingestion failures clamp only the affected hypotheses instead of
   flattening all profitability readiness;
3. `/trading/status`, `/trading/profitability/runtime`, live submission gate payloads, and promotion tooling project
   the same passport ids;
4. canary and live capital require explicit guardrail admission that is stricter than diagnostic or probe evaluation.

## Assessment snapshot

### Cluster and control-plane implications

The live Jangar surface can now serve while still carrying degraded execution trust. That is useful for Torghut only if
Torghut consumes the degradation precisely instead of translating it into broad capital pessimism or optimism.

- Jangar `/ready` is serving with degraded trust rather than hard blocked;
- requirement jobs still fail on missing Huly runtime assets;
- `jangar-control-plane` and `torghut-quant` still carry stale freeze debt from March 11, 2026.

Interpretation:

- Torghut needs a profitability contract that can survive bounded Jangar degradation;
- it also needs a more explicit way to reject stale upstream evidence when the trading hypothesis depends on it.

### Source architecture and high-risk modules

The Torghut runtime still keeps too much profitability truth in route-time composition.

- `services/torghut/app/main.py`
  - builds `/ready`, `/trading/status`, and `/trading/profitability/runtime` from a mixture of scheduler state,
    empirical jobs, quant evidence, and live submission gate payloads;
  - does not project a durable hypothesis-scoped passport object.
- `services/torghut/app/trading/scheduler/pipeline.py`
  - composes live submission gate payloads from hypothesis summary, empirical jobs, and quant evidence;
  - still treats those surfaces as immediate inputs rather than as one persisted profitability contract.
- `services/torghut/app/trading/submission_council.py`
  - resolves capital stage and blocking reasons at decision time;
  - does not bind those decisions to one dataset seat, simulation proof, or Jangar execution admission.
- `services/torghut/app/trading/empirical_jobs.py`
  - correctly models freshness and truthfulness per empirical job type;
  - still stops at job readiness and does not mint a durable hypothesis-scoped profitability object.
- `services/torghut/app/trading/scheduler/state.py`
  - contains rich in-memory metrics and counters;
  - should remain a fast cache and telemetry source, not the long-term authority for profitability admission.

The highest-risk test gaps are now cross-surface:

- no regression test proves a hypothesis stays blocked when market context is stale even though quant metrics remain
  fresh;
- no test proves a stale simulation proof clamps live promotion while allowing `observe` or `probe`;
- no endpoint parity test proves `/trading/status` and `/trading/profitability/runtime` expose the same profitability
  object ids.

### Data, schema, freshness, and consistency evidence

Torghut already has the additive persistence needed for a stronger contract.

- `torghut_control_plane.quant_metrics_latest`, `quant_alerts`, and `quant_pipeline_health`
  - provide fresh but mixed quant truth
- `torghut_market_context_snapshots`, `torghut_market_context_runs`, and `torghut_market_context_evidence`
  - provide durable market-context lineage, but that lineage is currently stale
- `torghut_control_plane.simulation_runs`, `simulation_run_events`, `simulation_artifacts`, `dataset_cache`, and
  `simulation_lane_leases`
  - provide durable simulation and dataset state, but the latest updates are stale and failure-heavy

Interpretation:

- Torghut does not need a new database;
- it needs a hypothesis-level object that composes these additive tables into a deterministic profitability answer.

## Problem statement

Torghut still has five profitability-critical gaps:

1. fresh quant metrics can mask stale market-context and simulation evidence;
2. live submission gate logic still resolves too much profitability truth at request time;
3. hypothesis-level evidence is not durably bundled into one replayable object;
4. guardrails do not yet distinguish `observe`, `probe`, `canary`, and `live` with enough hypothesis-specific rigor;
5. Jangar execution degradation is not yet consumed as an explicit profitability input with bounded blast radius.

That is good enough for dashboards. It is not good enough for live capital.

## Alternatives considered

### Option A: keep dataset seats and lane balance sheets as the final profitability contract

Summary:

- continue the current March 20 direction with dataset seats and lane balance sheets only;
- let submission and promotion logic read those objects directly.

Pros:

- smallest delta from the latest Torghut plan stack;
- already grounded in existing simulation and dataset tables.

Cons:

- still leaves hypothesis identity and guardrail state spread across multiple payloads;
- does not make Jangar execution admission a first-class profitability input;
- keeps too much live-vs-probe logic in route-time council code.

Decision: rejected.

### Option B: centralize final profitability gating back inside Jangar

Summary:

- let Jangar publish the final tradeability answer for Torghut hypotheses;
- keep Torghut mostly as an execution engine.

Pros:

- one operator-facing authority surface;
- less Torghut-side compiler work.

Cons:

- couples platform runtime truth to trading economics too tightly;
- reduces Torghut-local option value for new research lanes and guardrails;
- makes a Jangar mistake more expensive than it should be.

Decision: rejected.

### Option C: hypothesis passports plus profit guardrail admissions

Summary:

- Torghut compiles one passport per hypothesis from dataset seats, simulation proofs, market-context evidence, quant
  health, and Jangar execution admissions;
- guardrail admission turns that passport into an explicit `observe`, `probe`, `canary`, `live`, or `quarantine`
  decision.

Pros:

- makes mixed freshness actionable without globalizing it;
- gives every promotion and rollback one replayable evidence object;
- keeps platform authority in Jangar and trading economics in Torghut.

Cons:

- adds additive tables and a stricter compiler;
- requires endpoint parity and shadow rollout before any capital effect;
- exposes stale profitability debt more plainly than current summary payloads do.

Decision: selected.

## Decision

Adopt **Option C**.

Torghut will compile hypothesis passports and profit guardrail admissions, then bind live submission, profitability
status, and promotion logic to those durable objects instead of inferring the same decision differently on each route.

## Architecture

### 1. Hypothesis passports

Add additive Torghut tables:

- `hypothesis_passports`
  - `hypothesis_passport_id`
  - `hypothesis_id`
  - `lane_id`
  - `dataset_seat_id`
  - `execution_admission_id`
  - `market_context_ref`
  - `simulation_proof_ref`
  - `quant_health_ref`
  - `empirical_bundle_ref`
  - `decision_window`
  - `freshness_budget_seconds`
  - `passport_class` (`observe`, `probe`, `canary`, `live`)
  - `status` (`allow`, `degrade`, `block`, `quarantine`)
  - `reason_codes_json`
  - `issued_at`
  - `expires_at`
- `hypothesis_passport_inputs`
  - `hypothesis_passport_id`
  - `source_name`
  - `source_status`
  - `freshness_seconds`
  - `truthfulness`
  - `evidence_ref`

Rules:

- a passport is per hypothesis and per lane, not account-global;
- fresh quant metrics alone cannot mint a live-class passport;
- a passport expires when any required evidence surface exceeds its freshness budget.

### 2. Profit guardrail admissions

Add additive tables:

- `profit_guardrail_admissions`
  - `profit_guardrail_admission_id`
  - `hypothesis_passport_id`
  - `capital_stage`
  - `max_notional`
  - `max_drawdown_bps`
  - `max_slippage_bps`
  - `required_simulation_recency_seconds`
  - `required_market_context_status`
  - `required_quant_health_status`
  - `decision` (`observe`, `probe`, `canary`, `live`, `quarantine`)
  - `reason_codes_json`
  - `issued_at`
  - `expires_at`
- `profit_guardrail_events`
  - `profit_guardrail_admission_id`
  - `event_type`
  - `before_decision`
  - `after_decision`
  - `reason_code`
  - `evidence_ref`
  - `created_at`

Rules:

- `observe`
  - allowed when the hypothesis can still be scored diagnostically
- `probe`
  - allowed only with a valid passport and bounded stale debt
- `canary`
  - allowed only with fresh market context, fresh simulation proof, healthy quant health, and Jangar promotion
    admission `allow`
- `live`
  - requires repeated positive canary evidence and no open blocking guardrail reason
- `quarantine`
  - is automatic when a bound passport expires or a required surface turns invalid

### 3. Source cutover expectations

Implementation scope implied by this contract:

- `services/torghut/app/main.py`
  - project `hypothesis_passport_id` and `profit_guardrail_admission_id` through `/trading/status` and
    `/trading/profitability/runtime`
- `services/torghut/app/trading/scheduler/pipeline.py`
  - write passports and guardrail admissions after evaluating hypothesis summary, empirical jobs, and quant health
- `services/torghut/app/trading/submission_council.py`
  - stop being the final authority for capital stage on its own
  - consume the latest profit guardrail admission instead
- `services/torghut/app/trading/empirical_jobs.py`
  - keep compiling truthful empirical readiness
  - also emit the references needed to mint or invalidate a hypothesis passport
- `services/torghut/app/trading/scheduler/state.py`
  - remain an in-memory telemetry and fast-cache layer only

### 4. Guardrail semantics for the current live evidence

The current `2026-03-20` evidence implies:

- fresh `quant_metrics_latest` may support `observe` or bounded `probe`;
- stale `torghut_market_context_snapshots` from `2026-03-16` block `canary` and `live`;
- `40` failed simulation runs and idle lane leases block any passport class that requires fresh replay proof;
- persistent `ingestion ok=false` in recent `quant_pipeline_health` must become a named guardrail reason, not a
  detail hidden inside a large payload.

### 5. Validation and acceptance gates

Engineer acceptance gates:

- unit tests for:
  - passport compilation under fresh quant but stale market context;
  - guardrail admission under stale simulation proofs;
  - route parity between `/trading/status` and `/trading/profitability/runtime`
- replay tests using:
  - the stale market-context snapshot state from `2026-03-16`
  - the simulation failure-heavy state from `2026-03-19`
  - the fresh quant metrics state from `2026-03-20`
- regression proving Jangar execution admission degradation can clamp only the affected hypotheses

Deployer acceptance gates:

- `probe` capital only on first rollout, with explicit notional caps from guardrail admissions;
- no `canary` or `live` capital while market context or simulation proof remains stale;
- rollback or quarantine is automatic when the latest guardrail admission drops below the currently active capital
  stage.

## Rollout plan

Phase 0. Add tables and shadow writes.

- keep current live submission gate behavior
- expose passport and guardrail ids in shadow mode only

Phase 1. Endpoint parity.

- `/trading/status` and `/trading/profitability/runtime` both project the latest passport and guardrail ids
- no capital effect yet

Phase 2. Probe-only adoption.

- live submission council may consume guardrail admissions only for `observe` and tightly capped `probe`
- stale market context or stale simulation proof clamps probe notional to near zero

Phase 3. Canary cutover.

- canary requires fresh market context, recent simulation proof, healthy quant inputs, and valid Jangar promotion
  admission

Phase 4. Live promotion.

- live capital requires repeated positive canary history plus a currently `allow` guardrail admission

## Rollback

If the passport compiler or guardrail policy is wrong:

1. set all profit guardrail admissions to `observe`;
2. stop using guardrail decisions for live or canary capital;
3. preserve passports and guardrail events for replay and audit;
4. repair the compiler in shadow mode before re-enabling capital effects.

## Risks and open questions

- Passport TTL that is too short will create avoidable probe churn.
- Passport TTL that is too long will let stale market-context or simulation evidence linger past credibility.
- The first implementation increment must decide whether replay jobs or live runtime writes mint the initial passports.
  I prefer replay-first so profitability guardrails stay empirical before they become promotional.

## Handoff to engineer and deployer

Engineer handoff:

- implement hypothesis-passport and profit-guardrail tables and compiler
- project passport and guardrail ids through the trading status surfaces
- add regression coverage for stale market context, stale simulation proof, and bounded probe admission

Deployer handoff:

- require passport and guardrail ids in rollout and promotion evidence
- keep capital capped at `observe` or `probe` until market-context and simulation freshness are restored
- treat `quarantine` or expired passports as automatic demotion triggers

The acceptance bar is not "the runtime still has some fresh metrics." The acceptance bar is being able to prove which
hypothesis had which evidence, which guardrail, and which capital class at the moment it was allowed to act.
