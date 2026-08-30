# AI Layer: Evaluation and Benchmarks

## Status

- Version: `v1`
- Last updated: **2026-02-08**
- Source of truth (config): `argocd/applications/torghut/**`

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: **Partially implemented.** Runtime evaluation metrics exist from persisted `LLMDecisionReview` rows, and DSPy compile/evaluation tooling exists; promotion is still governed by guardrail evidence fields.
- Matched implementation area: LLM evaluation workflow.
- Current source evidence:
  - `services/torghut/app/trading/llm/evaluation.py::build_llm_evaluation_metrics`
  - `services/torghut/app/trading/llm/dspy_compile/evaluator.py`
  - `services/torghut/app/trading/llm/dspy_compile/dataset.py`
  - `services/torghut/scripts/compile_dspy_program.py`
  - `services/torghut/tests/test_llm_evaluation.py`
- What is implemented from the design:
  - same-day evaluation windowing in America/New_York;
  - verdict counts and error rate;
  - confidence, token, and risk-flag summaries;
  - calibration quality metrics from stored response JSON;
  - DSPy compile/evaluation test coverage.
- What changed from the design:
  - metrics are derived from `LLMDecisionReview` rows joined to `TradeDecision`, not a standalone golden-set runner;
  - promotion evidence is represented through guardrail fields, but this doc's benchmark table is not itself an automated deploy gate;
  - current deployment disables LLM runtime, so production evaluation samples may be absent.
- Remaining gaps / operator caveats:
  - require a concrete `LLM_EVALUATION_REPORT`, model/version lock, and shadow completion evidence before activation;
  - do not infer predictive performance from schema/guardrail test coverage alone.

## Purpose

Define how Torghut evaluates the AI advisory layer for:

- correctness (alignment with deterministic policy),
- safety (avoid unsafe approvals/adjustments),
- and operational stability (timeouts, parse errors, cost).

## Non-goals

- Claiming predictive performance guarantees.
- “Leaderboard chasing” without safety alignment.

## Terminology

- **Golden set:** Curated set of decisions with expected labels/verdicts.
- **Shadow evaluation:** Run AI in production but do not impact execution.
- **Drift:** Changes in model behavior over time or across versions.

## Evaluation pipeline (v1)

```mermaid
flowchart TD
  Data["Recorded decisions + context"] --> Label["Human / deterministic labels"]
  Label --> Run["Run AI review offline"]
  Run --> Metrics["Compute metrics + errors"]
  Metrics --> Shadow["Shadow mode in paper"]
  Shadow --> Promote["Optional enablement with bounds"]
```

## Metrics (recommended)

- Parse success rate
- Average latency and p95 latency
- Veto/approve distribution by strategy
- “Unsafe approve” rate (AI approves decisions that deterministic policy would reject)
- Adjustment clamp rate (how often policy guard clamps AI outputs)
- Cost per 1k decisions

## Benchmarks (operator-friendly)

| Benchmark           | Target (example) | Why                |
| ------------------- | ---------------- | ------------------ |
| parse success       | > 99%            | schema stability   |
| p95 latency         | < timeout/2      | avoid backpressure |
| circuit open events | rare             | provider stability |

## Promotion checklist (v1)

Before disabling shadow mode or enabling adjustments, set and verify:

- `LLM_EVALUATION_REPORT` (evaluation evidence reference)
- `LLM_EFFECTIVE_CHALLENGE_ID` (independent review reference)
- `LLM_SHADOW_COMPLETED_AT` (timestamp after shadow evaluation)
- `LLM_ALLOWED_MODELS` includes the active `LLM_MODEL`
- `LLM_ADJUSTMENT_APPROVED=true` (only if adjustments are allowed)

## Failure modes and recovery

| Failure                   | Symptoms          | Detection                         | Recovery                                |
| ------------------------- | ----------------- | --------------------------------- | --------------------------------------- |
| Increased unsafe approves | risk flags spike  | offline evaluation + audit review | disable AI; tighten policy; re-evaluate |
| High cost                 | token usage grows | billing telemetry                 | shorten prompts; cap tokens; disable AI |

## Security considerations

- Evaluation datasets must not include secrets or sensitive account identifiers beyond what is needed.
- Avoid storing chain-of-thought; store short rationale only.

## Decisions (ADRs)

### ADR-41-1: Shadow mode is mandatory before impact

- **Decision:** New AI versions run in `LLM_SHADOW_MODE=true` before influencing executions.
- **Rationale:** Real data reveals edge cases and drift.
- **Consequences:** Adds time before AI can affect outcomes.
