# Priority 4: LLM Multi-Agent Committee with Deterministic Veto

## Objective

Upgrade LLM advisory from single-agent review to a bounded committee architecture that improves reasoning diversity
while preserving strict deterministic veto authority and execution safety.

## Problem Statement

Single-agent LLM advisory can miss adversarial failure cases and may overfit prompt behavior. Multi-agent designs can
improve robustness, but without hard policy boundaries they also increase coordination, hallucination, and latency risk.

## Scope

### In Scope

- role-based committee orchestration,
- structured outputs with confidence and abstain semantics,
- deterministic veto path that blocks unsafe outputs,
- trace storage for audit and replay.

### Out of Scope

- direct order placement by LLM outputs,
- unconstrained autonomous prompt self-modification in live,
- bypass of risk/portfolio/execution policy checks.

## Committee Topology

### Roles

- `researcher`: explains thesis and expected edge.
- `risk_critic`: stress-tests downside and constraint violations.
- `execution_critic`: checks feasibility under microstructure and policy limits.
- `policy_judge`: validates schema, thresholds, and mandatory contracts.

### Required Output Schema

Each agent returns:

- `verdict`: `approve|adjust|veto|abstain|escalate`
- `confidence`: `[0,1]`
- `uncertainty`: `low|medium|high`
- `rationale_short`: <= 280 chars
- `required_checks`: list of deterministic check IDs

### Decision Aggregation

- committee output is advisory-only.
- any mandatory critic `veto` forces final `veto`.
- missing/invalid schema defaults to `veto` or `abstain` (policy-configurable fail-closed).

## Torghut Integration Points

- `services/torghut/app/trading/llm/review_engine.py`
  - add committee orchestrator and aggregator.
- `services/torghut/app/trading/llm/schema.py`
  - extend response schema for multi-agent outputs.
- `services/torghut/app/trading/llm/guardrails.py`
  - enforce parser and safety contracts.
- `services/torghut/app/trading/llm/circuit.py`
  - per-role breaker and global breaker policies.
- `services/torghut/app/trading/autonomy/policy_checks.py`
  - hard deterministic veto bridge.

## Deterministic Safety Contract

- LLM committee is advisory, never authoritative.
- final execution requires pass from deterministic gate chain.
- if committee runtime fails or times out, path falls back to deterministic-only mode.
- all committee inputs/outputs must be persisted with immutable request/response hashes.

## Metrics, SLOs, and Alerts

### Metrics

- `llm_committee_requests_total{role}`
- `llm_committee_latency_ms{role}`
- `llm_committee_verdict_total{role,verdict}`
- `llm_committee_schema_error_total`
- `llm_committee_veto_alignment_rate`

### SLOs

- schema validation success >= 99.5%.
- p95 end-to-end committee latency <= configured budget.
- deterministic veto precedence = 100%.

### Alerts

- schema/parsing failures above threshold.
- critic disagreement spikes with low confidence.
- circuit breaker open events for any mandatory role.

## Evaluation Framework

### Offline

- replay historical decisions with shadow committee.
- compare outcome quality, refusal quality, and false-veto rate.

### Paper

- bounded advisory rollout by symbol bucket.
- evaluate net impact on rejected bad trades and approved good trades.

### Promotion Criteria

- improvement in paper decision quality metrics.
- no deterministic safety regressions.
- stable latency and parser error budget.

## Failure Modes and Mitigations

- role collusion and correlated hallucinations:
  - mitigation: prompt diversity + independent templates + randomization of context slices.
- critic over-veto suppresses strategy throughput:
  - mitigation: calibrated veto thresholds and periodic review dataset.
- committee latency jeopardizes timely decisions:
  - mitigation: strict timeout budgets and degrade-to-single-review fallback.

## Rollback Plan

- `LLM_COMMITTEE_ENABLED=false` restores single-agent advisory.
- preserve committee traces for diagnostics and tuning.
- keep deterministic gates unchanged through rollback.

## AgentRun Handoff Bundle

- `ImplementationSpec`: `torghut-v5-llm-committee-deterministic-veto-v1`
- Required keys:
  - `repository`
  - `base`
  - `head`
  - `designDoc`
  - `policyConfigPath`
  - `artifactPath`
  - `torghutNamespace`
- Expected artifacts:
  - committee runtime + schema updates,
  - deterministic veto integration,
  - latency/reliability benchmark report,
  - replay evaluation pack.
- Exit criteria:
  - schema and veto SLOs pass,
  - advisory-only boundary verified,
  - rollback rehearsal documented.

## References

- [1] TradingAgents: Multi-Agents LLM Financial Trading Framework. arXiv:2412.20138. https://arxiv.org/abs/2412.20138
- [2] QuantAgent: Price-Driven Multi-Agent LLMs for High-Frequency Trading. arXiv:2509.09995. https://arxiv.org/abs/2509.09995
- [3] QuantAgents: Towards Multi-agent Financial System via Simulated Trading. arXiv:2510.04643. https://arxiv.org/abs/2510.04643
- [4] TradingGroup: A Multi-Agent Trading System with Self-Reflection and Data-Synthesis. arXiv:2508.17565. https://arxiv.org/abs/2508.17565
- [5] ATLAS: Adaptive Trading with LLM AgentS Through Dynamic Prompt Optimization and Multi-Agent Coordination. arXiv:2510.15949. https://arxiv.org/abs/2510.15949
- [6] Enhancing Financial RAG with Agentic AI and Multi-HyDE: A Novel Approach to Knowledge Retrieval and Hallucination Reduction. arXiv:2509.16369. https://arxiv.org/abs/2509.16369
