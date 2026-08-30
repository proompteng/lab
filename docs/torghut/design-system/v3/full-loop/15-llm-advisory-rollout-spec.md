# LLM Advisory Rollout and Governance Spec

## Status

- Version: `v3-llm-rollout`
- Last updated: `2026-02-12`
- Maturity: `draft`

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented/prototyped: LLM review, DSPy scripts, discovery stress modules, and Jangar OpenAI-compatible routes exist; many ML/LOB designs remain research/prototype.
- Matched implementation area: LLM, DSPy, AI review, and model governance.
- Current source evidence:
  - `services/torghut/app/trading/llm`
  - `services/torghut/scripts/run_dspy_workflow.py`
  - `services/torghut/scripts/compile_dspy_program.py`
  - `services/jangar/src/routes/openai/v1/chat/completions.ts`
  - `services/torghut/app/trading/discovery/order_flow_features.py`
- Design drift note: Distinguish production review gates from research/prototype model ideas.


## Objective

Define a staged LLM rollout for torghut where LLM remains bounded and non-authoritative while still producing quantifiable value.

## Deployment Stages

### Stage 0 — Baseline

- `LLM_ENABLED=false`
- Deterministic path unchanged
- Metrics baseline collected for approvals/vetoes from no-LLM mode.

### Stage 1 — Shadow Pilot

- `LLM_ENABLED=true`, `LLM_SHADOW_MODE=true`
- `LLM_FAIL_MODE=pass_through` for paper, `veto` for live
- No strategy changes based on LLM output
- Goal: measure verdict distribution and latency.

### Stage 2 — Paper Advisory Influence (Optional)

- `LLM_FAIL_MODE=pass_through` retained
- optional bounded adjustments if `LLM_ADJUSTMENT_APPROVED=true`
- enforce `LLM_ADJUSTMENT_ALLOWED=true` only after independent evaluation.

### Stage 3 — Controlled Live Advisory

- Only after shadow+paper confidence gates.
- Keep deterministic risk as final authority.
- `LLM_SHADOW_MODE` false only after independent review.

## Governance Requirements

- Mandatory evidence for each stage transition:
  - `LLM_EVALUATION_REPORT`
  - `LLM_EFFECTIVE_CHALLENGE_ID`
  - `LLM_SHADOW_COMPLETED_AT`
  - model hash/version lock.
- Top-level guardrails:
  - prompt allowlist in config,
  - response schema strictness,
  - token budgets,
  - circuit breaker (`LLM_CIRCUIT_*`).

## Required Metrics to Track

- total reviews, pass-through rate, veto rate, adjust rate, parse/error rates,
- confidence distribution,
- top risk flags,
- circuit-open duration and cooling windows.

## Integration with Autonomy

- LLM outputs do not replace decision/feature/risk gates.
- Autonomy recommendation remains based on deterministic signal gates and independent statistical checks.
- If LLM confidence or error spikes above thresholds, force shadow mode and raise gate-level alert.

## Acceptance Criteria

- Stage 1 runs for >N hours with stable telemetry and no production risk regressions.
- Any advisory adjustment is within bounded action limits and separately audited.
- Stage progression only after documented evidence package and explicit approval.
