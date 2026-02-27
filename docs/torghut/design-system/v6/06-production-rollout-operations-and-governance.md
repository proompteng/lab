# Production Rollout, Operations, and Governance

## Status

- Doc: `v6/06`
- Date: `2026-02-27`
- Maturity: `production design`
- Scope: phased rollout plan for Beyond-TSMOM architecture with explicit SLO, rollback, and governance controls

## Objective

Provide a practical rollout plan from current live posture to fully operational intraday regime-adaptive and DSPy-governed decisioning.

## Rollout Phases

### Phase 0: Baseline capture

- Snapshot current decision quality, drawdown profile, fallback rates, and market-context freshness.
- Freeze baseline artifact references for comparison.

### Phase 1: Evaluation and data integrity hardening

- Enable contamination-safe eval pipeline as promotion prerequisite.
- Validate benchmark reproducibility and lineage capture.

### Phase 2: Regime router shadow mode

- Deploy router and expert-weight outputs in shadow.
- Record path decisions without altering execution.
- Validate entropy triggers and defensive fallbacks.

### Phase 3: DSPy serving cutover over Jangar

- Run DSPy as active decision reasoning path using Jangar OpenAI endpoint.
- Remove legacy runtime network LLM path.
- Keep deterministic fallback and strict timeout budget.

### Phase 4: Controlled live routing activation

- Start with low notional impact and high oversight.
- Increase exposure only on passing SLO windows.
- Keep immediate rollback switches available.

### Phase 5: Alpha-discovery loop activation

- Start offline generation/eval/promote cadence.
- Promote only candidates that pass all evidence gates.

## Runtime SLO Targets

- `>= 99.9%` decision-loop availability.
- Fast-path p95 latency within configured budget.
- DSPy timeout plus fallback rate within policy threshold.
- Market-context freshness target by domain (news and fundamentals).
- Router fallback rate below configured ceiling.

## Alerting and Incident Response

Required alert families:

1. DSPy transport/auth/schema failures.
2. Router feature staleness or high fallback state.
3. Deterministic gate anomaly spikes.
4. Eval drift and promotion-gate failures.
5. Market-context freshness degradation.

Every alert class must map to a runbook action and owner.

## Rollback Controls

Hard rollback switches:

1. disable DSPy path and force deterministic-only advisory fallback,
2. disable regime-adaptive routing and use defensive/static expert weights,
3. revert to prior promoted artifacts for router and DSPy runtime,
4. roll Knative traffic back to last stable revision.

## Governance and Audit

Each rollout stage must produce:

- commit SHA and image digest map,
- active artifact hashes,
- SLO and gate compliance summary,
- unresolved risks and owner assignments.

## Full Operational Exit Criteria

1. Regime-adaptive router is live with verified fallback safety.
2. DSPy over Jangar is the active LLM decision path with lineage and fallback controls.
3. Contamination-safe eval pipeline gates all promotions.
4. Alpha-discovery loop is running through controlled AgentRun lanes.
5. GitOps manifests and deployed state are converged with no unmanaged drift.
