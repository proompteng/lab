# LLM Intelligence Layer Architecture (v2)

## Status

- Version: `v2`
- Last updated: **2026-02-10**

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

Define a safe intelligence layer that improves decisions without becoming a new failure mode.

## Principle

LLMs are non-deterministic and vulnerable to prompt injection. Therefore:

- LLM outputs must be strictly schema-validated.
- Deterministic policy must clamp or veto.
- The LLM must not have broker credentials.

## Recommended Architecture

- Deterministic decision engine emits a decision intent.
- LLM review engine emits `approve|veto|adjust` with bounded fields.
- Policy guard clamps adjustments.
- Risk engine remains the final gate.

## If You Build Tool-Using Agents

Separate paths:

- Trading path (high stakes): review-only; no tools that mutate state.
- Ops path (medium stakes): GitOps PR generation, with explicit gates and RBAC.

## Security Controls

- Treat tool outputs as untrusted data, not instructions.
- Disable free-form external retrieval for trading decisions.
- Add prompt injection detection and red teaming.

## References

- OWASP Top 10 for LLM Applications: https://owasp.org/www-project-top-10-for-large-language-model-applications/
- NIST AI RMF GenAI Profile: https://www.nist.gov/publications/artificial-intelligence-risk-management-framework-generative-artificial-intelligence
- Microsoft on indirect prompt injection defenses (2025): https://www.microsoft.com/en-us/msrc/blog/2025/07/how-microsoft-defends-against-indirect-prompt-injection-attacks/
- Agent runtime constraints (AgentSpec, 2025): https://arxiv.org/abs/2503.18666
