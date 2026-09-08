# AI Layer Overview (Advisory + Gated)

## Status

- Version: `v1`
- Last updated: **2026-02-08**
- Source of truth (config): `argocd/applications/torghut/**`

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


## Purpose

Describe Torghut’s AI layer as a strictly advisory component that:

- reviews deterministic trade decisions,
- can recommend veto/approve/adjust within bounded policies,
- and is always gated by deterministic risk controls.

## Non-goals

- AI as primary decision maker.
- Any design where AI can bypass trading-mode, live-submit activation, or deterministic risk checks.
- Unbounded retrieval-augmented generation (RAG) from untrusted sources as a dependency for trading.

## Terminology

- **AI advisory:** AI may recommend changes; it does not execute.
- **Policy guard:** Deterministic validator/clamp of AI outputs.
- **Shadow mode:** AI runs and records outcomes, but does not affect execution.

## Current implementation (pointers)

- Settings: `services/torghut/app/config.py` (`LLM_*` fields)
- AI client/review: `services/torghut/app/trading/llm/review_engine.py`
- Circuit breaker: `services/torghut/app/trading/llm/circuit.py`
- Policy/clamping: `services/torghut/app/trading/llm/policy.py`
- Prompt template: `services/torghut/app/trading/llm/prompt_templates/system_v1.txt`
- Stored audit: `services/torghut/app/models/entities.py` (`LLMDecisionReview`)

## Where AI sits in the pipeline

```mermaid
flowchart LR
  CH[(ClickHouse signals)] --> Decide["Deterministic decision"]
  Decide --> AI["AI review (optional)"]
  AI --> Guard["Policy guard (deterministic)"]
  Guard --> Risk["Risk engine (deterministic)"]
  Risk --> Exec["Order executor"]
  Exec --> Broker["Broker API"]
  Decide --> PG[(Postgres audit)]
  AI --> PG
```

## Safety invariants (v1)

- Code default: `LLM_ENABLED=false` (`services/torghut/app/config.py`).
- As deployed (see `argocd/applications/torghut/knative-service.yaml`): `LLM_ENABLED=true` in **shadow mode**
  (`LLM_SHADOW_MODE=true`) with `LLM_FAIL_MODE=pass_through` while `TRADING_MODE=paper`.
  - AI never calls broker APIs.
  - AI outputs must parse as strict schema and pass policy guard.
  - Deterministic risk engine remains the final gate.
  - Live trading still requires `TRADING_MODE=live`, live-submit activation, and deterministic risk approval.

### Rollout/verification (paper-first + live-gate posture)

- After any env/config change, confirm GitOps manifest values:
  - `TRADING_MODE=paper`
  - `TRADING_KILL_SWITCH_ENABLED=true`
  - `TRADING_EMERGENCY_STOP_ENABLED=true`
  - `LLM_FAIL_OPEN_LIVE_APPROVED=false`
- Verify `trading/status` shows `trading_mode=paper` and no live execution path is active.

## Configuration (selected env vars)

From `services/torghut/app/config.py`:
| Env var | Purpose | Safe default |
| --- | --- | --- |
| `LLM_ENABLED` | enable AI advisory | `false` |
| `LLM_SHADOW_MODE` | observe only | `false` |
| `LLM_FAIL_MODE` | behavior on AI error | `veto` |
| `LLM_ADJUSTMENT_ALLOWED` | allow adjustments | `false` |
| `LLM_MIN_CONFIDENCE` | confidence gate | `0.5` |
| `LLM_TIMEOUT_SECONDS` | request timeout | `20` |

Operational note:

- In production paper mode, prefer `LLM_SHADOW_MODE=true` and `LLM_FAIL_MODE=pass_through` until the AI layer is validated.
- In live mode, keep `LLM_FAIL_MODE=veto` (fail-closed).

## Failure modes and recovery

| Failure                  | Symptoms            | Detection                         | Recovery                                                   |
| ------------------------ | ------------------- | --------------------------------- | ---------------------------------------------------------- |
| AI provider outage       | increased AI errors | llm_error counters; circuit opens | auto-fallback to deterministic-only; keep trading safe     |
| Bad prompt/schema change | parse failures      | llm_parse_error counters          | roll back prompt_version; keep AI disabled until validated |

## Security considerations

- AI prompts must not include secrets; treat prompts as data that may be logged/stored.
- Avoid untrusted free-text inputs in prompts (prompt injection risk).
- Store only short rationales; do not store chain-of-thought.

## Decisions (ADRs)

### ADR-36-1: AI advisory is optional and non-authoritative

- **Decision:** AI is optional, advisory-only, and always bounded by deterministic policy.
- **Rationale:** Reduces risk from non-determinism and adversarial input.
- **Consequences:** AI’s “value add” must be measurable without increasing system risk.
