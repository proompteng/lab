# LLM Multi-Agent Trade Committee and Critic

## Objective
Implement a bounded multi-agent LLM committee for trade proposals, with deterministic critic vetoes and hard policy
contracts before any output can influence execution.

## Why This Matters
Recent financial multi-agent LLM papers indicate improved reasoning diversity, but they also increase coordination and
hallucination risk unless strict verification and role separation are applied.

## Proposed Torghut Design
- Add committee roles:
  - `researcher` (hypothesis generation),
  - `risk_critic` (adversarial stress),
  - `execution_reviewer` (microstructure feasibility),
  - `policy_judge` (contract compliance).
- Require machine-readable rationale schema and confidence fields.
- Enforce deterministic veto when any mandatory critic gate fails.

## Owned Code and Config Areas
- `services/torghut/app/trading/llm/**`
- `services/jangar/src/server/**`
- `docs/torghut/design-system/v3/full-loop/15-llm-advisory-rollout-spec.md`
- `argocd/applications/torghut/knative-service.yaml`

## Deliverables
- Multi-agent orchestration contract and bounded runtime.
- Critic/veto policy engine with structured refusal reasons.
- Storage of rationale traces and policy decisions.
- Evaluation suite for consistency, refusal quality, and drift.

## Verification
- Committee outputs improve paper-mode decision quality metrics.
- Critic vetoes trigger deterministically under malformed proposals.
- No path allows direct execution without deterministic policy approval.

## Rollback
- Disable committee influence and keep single-agent advisory baseline.
- Preserve traces for postmortem tuning.

## AgentRun Handoff Bundle
- `ImplementationSpec`: `torghut-v4-llm-committee-critic-v1`
- Required keys:
  - `repository`
  - `base`
  - `head`
  - `designDoc`
  - `torghutNamespace`
  - `policyConfigPath`
- Expected artifacts:
  - committee runtime,
  - critic/veto policies,
  - paper evaluation report.
- Exit criteria:
  - contract compliance > target threshold,
  - deterministic veto coverage validated,
  - advisory-only boundary preserved.

## Research References
- TradingAgents: https://arxiv.org/abs/2412.20138
- QuantAgent: https://arxiv.org/abs/2509.09995
- TradingGroup: https://arxiv.org/abs/2508.17565
