# AI Layer: Circuit Breakers and Fallbacks

## Status

- Version: `v1`
- Last updated: **2026-02-20**
- Source of truth (config): `argocd/applications/torghut/**`
- Implementation status: `Implemented` (verified with code + tests + runtime/config on 2026-02-21)

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: **Partially implemented and currently inactive in deployment.** The circuit-breaker class, guardrail evaluator, and deterministic DSPy fallback exist, but the current Knative manifest sets `LLM_ENABLED=false` and `LLM_DSPY_RUNTIME_MODE=disabled`.
- Current source evidence:
  - `services/torghut/app/trading/llm/circuit.py::LLMCircuitBreaker` tracks recent error timestamps, opens the circuit for a cooldown window, clears open state after cooldown, and exposes `snapshot()` with open/cooldown/error-count fields.
  - `services/torghut/app/trading/llm/review_engine.py::_deterministic_fallback_response` returns a schema-valid veto response with deterministic required checks when DSPy runtime execution fails.
  - `services/torghut/app/trading/llm/guardrails.py::evaluate_llm_guardrails` blocks or shadows requests for token-budget, prompt allowlist, rollout-stage, missing prompt template, missing governance evidence, missing adjustment approval, and invalid committee-role conditions.
  - `services/torghut/app/config/llm_fields.py` owns `LLM_CIRCUIT_*`, rollout-stage, DSPy runtime, model-inventory, and governance-evidence settings.
  - `argocd/applications/torghut/llm-guardrails-exporter-configmap.yaml` exports circuit, policy, governance, token-budget, and error-ratio metrics.
- What is implemented from the design:
  - error-window circuit state;
  - cooldown/open snapshot reporting;
  - deterministic fallback response on DSPy runtime failure;
  - rollout-stage and governance-evidence guardrails;
  - guardrail metrics exporter.
- What changed from the design:
  - runtime is DSPy-artifact gated rather than a direct generic provider call;
  - active deployment currently disables LLM/DSPy execution;
  - current authority is `evaluate_llm_guardrails` plus DSPy runtime readiness, not this document's older fail-mode prose.
- Remaining gaps / operator caveats:
  - circuit state is in-process and not durable across pod restarts;
  - metrics are readback, not proof that model execution is active;
  - activation requires explicit model inventory, artifact hash, rollout stage, and governance evidence.


## Purpose

Define resilience mechanisms that prevent AI provider issues from destabilizing trading, including:

- timeouts,
- circuit breakers,
- deterministic fallback behaviors,
  with safe-by-default semantics for both paper and live modes.

## Non-goals

- Complex multi-provider load balancing in v1.

## Terminology

- **Circuit open:** AI calls are skipped for a cooldown period after repeated errors.
- **Fallback:** Behavior used when AI is unavailable or errors (deterministic-only or veto).

## Current implementation (pointers)

- Circuit breaker: `services/torghut/app/trading/llm/circuit.py`
- Runtime fallback: `services/torghut/app/trading/llm/review_engine.py`
- Guardrail evaluator: `services/torghut/app/trading/llm/guardrails.py`
- Settings: `services/torghut/app/config/llm_fields.py`, `services/torghut/app/config/settings.py`
- Deployment state: `argocd/applications/torghut/knative-service.yaml`
- Metrics exporter: `argocd/applications/torghut/llm-guardrails-exporter-configmap.yaml`

## Circuit breaker model

```mermaid
stateDiagram-v2
  [*] --> Closed
  Closed --> Open: errors >= max_errors\nwithin window
  Open --> HalfOpen: cooldown elapsed
  HalfOpen --> Closed: success
  HalfOpen --> Open: error
```

## Configuration (selected env vars)

| Env var                        | Purpose                                                              | Safe default  |
| ------------------------------ | -------------------------------------------------------------------- | ------------- |
| `LLM_TIMEOUT_SECONDS`          | request timeout                                                      | `20`          |
| `LLM_CIRCUIT_MAX_ERRORS`       | error threshold                                                      | `3`           |
| `LLM_CIRCUIT_WINDOW_SECONDS`   | sliding window                                                       | `300`         |
| `LLM_CIRCUIT_COOLDOWN_SECONDS` | cooldown                                                             | `600`         |
| `LLM_FAIL_MODE`                | on-error behavior                                                    | `veto`        |
| `LLM_FAIL_MODE_ENFORCEMENT`    | strict vs configured fail-mode posture                               | `strict_veto` |
| `LLM_FAIL_OPEN_LIVE_APPROVED`  | explicit approval gate for any live pass-through effective fail mode | `false`       |

## Fallback policy (v1)

- **Live mode (`TRADING_MODE=live`):** Fail-closed by default. Any configuration that would produce
  `effective_fail_mode=pass_through` in live now requires `LLM_FAIL_OPEN_LIVE_APPROVED=true` at boot.
  Stage-specific rollout semantics are enforced for this check (for example `stage2` always evaluates effective
  fail mode as `pass_through`, so live `stage2` requires explicit approval even when `LLM_FAIL_MODE=veto`).
- **Paper mode (`TRADING_MODE=paper`):** Fallback behavior is controlled by `LLM_FAIL_MODE`:
  - `LLM_FAIL_MODE=veto` was the historical fail-closed default; current LLM settings live in `services/torghut/app/config/llm_fields.py` and runtime is disabled in the manifest.
  - `LLM_FAIL_MODE=pass_through` allows deterministic pass-through on AI errors.

Note: Live mode is itself gated by `TRADING_MODE=live`; this document assumes that is rare and carefully reviewed.
The deployment contract test in `services/torghut/tests/test_live_config_manifest_contract.py` validates Argo live env wiring
against `Settings` validation to fail CI for boot-invalid combinations.
Current deployed paper configuration (2026-02-09) sets `LLM_FAIL_MODE=pass_through` (see `argocd/applications/torghut/knative-service.yaml`).

### Rollout/verification (paper-first + live fail-open posture)

- Keep GitOps defaults aligned with live guardrails:
  - `TRADING_MODE=paper`
  - `TRADING_MODE=paper`
  - `TRADING_KILL_SWITCH_ENABLED=true`
  - `TRADING_EMERGENCY_STOP_ENABLED=true`
  - `TRADING_AUTONOMY_ALLOW_LIVE_PROMOTION=false`
  - `TRADING_EXECUTION_ADVISOR_LIVE_APPLY_ENABLED=false`
  - `LLM_FAIL_OPEN_LIVE_APPROVED=false`
  - `LLM_FAIL_MODE_ENFORCEMENT=configured` (or `strict_veto` when enforcing hard fail-closed)
- Verify after any config change:
  - `/trading/status` reports `trading_mode=paper`.
  - startup logs show `Settings` validation success.
  - live mode can only become pass-through after explicit approval; audit `llm.policy_resolution.classification` remains `compliant` under paper.
  - run `services/torghut/tests/test_live_config_manifest_contract.py` contract checks.

## Provider fallback chain (v1)

- Primary provider is set by `LLM_PROVIDER`.
- When `LLM_PROVIDER=jangar`, failures trigger the self-hosted fallback (`LLM_SELF_HOSTED_*`) before surfacing an error.
- If all providers fail or time out, the review is treated as an error: the circuit breaker records it and the scheduler applies
  `LLM_FAIL_MODE` (paper) or veto (live).

## Failure modes and recovery

| Failure         | Symptoms      | Detection                            | Recovery                                        |
| --------------- | ------------- | ------------------------------------ | ----------------------------------------------- |
| Provider outage | circuit opens | `/trading/status` shows circuit open | wait cooldown; disable AI; investigate provider |
| Excessive costs | token spikes  | cost counters/estimates              | disable AI; cap tokens; tighten prompts         |

## Policy-resolution observability

- Runtime status exposes `llm.policy_resolution.classification` and `llm.policy_resolution_counters`.
- Runtime metrics export `torghut_trading_llm_policy_resolution_total{classification=...}` with:
  - `classification="compliant"`
  - `classification="intentional_exception"`
  - `classification="violation"`
- Approved fail-open operation should increment only `intentional_exception`; any `violation` increments are page-worthy.

## Security considerations

- Circuit breakers protect against provider-induced DoS and runaway retries.
- In new environments, keep AI disabled by default; in production, prefer shadow-first enablement with bounded policies.

## Decisions (ADRs)

### ADR-38-1: Circuit breaker is mandatory when AI enabled

- **Decision:** AI calls must be guarded by circuit breaker + timeouts.
- **Rationale:** Prevent cascading failures and preserve system stability.
- **Consequences:** AI may be skipped during transient issues; audit must record skips.
