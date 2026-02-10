# LLM Intelligence Layer Architecture (v2)

## Status
- Version: `v2`
- Last updated: **2026-02-10**

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
