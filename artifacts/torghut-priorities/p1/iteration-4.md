# Iteration 4 — Torghut Live-Safety Invariants

- Repository: `proompteng/lab`
- Base branch: `main`
- Head branch: `codex/torghut-p1-safety-loop5`
- Priority: `P1`
- Artifact path: `artifacts/torghut-priorities/p1`

## Scope completed

- Audited GitOps runtime defaults against Torghut design docs for paper/live mode, LLM live fail behavior, and kill-switch readiness.
- Hardened deployed defaults in GitOps manifests:
  - `argocd/applications/torghut/knative-service.yaml` now explicitly includes:
    - `TRADING_AUTONOMY_ALLOW_LIVE_PROMOTION=false`
    - `TRADING_EXECUTION_ADVISOR_LIVE_APPLY_ENABLED=false`
    - `LLM_ADJUSTMENT_ALLOWED=false`
  - `argocd/applications/torghut/lean-runner-deployment.yaml` now explicitly pins paper/live and safety toggles:
    - `TRADING_LIVE_ENABLED=false`
    - `TRADING_AUTONOMY_ALLOW_LIVE_PROMOTION=false`
    - `TRADING_EXECUTION_ADVISOR_LIVE_APPLY_ENABLED=false`
    - `TRADING_KILL_SWITCH_ENABLED=true`
    - `TRADING_EMERGENCY_STOP_ENABLED=true`
- Added concise rollout/verification notes in design docs to explicitly tie GitOps changes back to kill-switch and live LLM guardrail checks.

## Changed files

- `argocd/applications/torghut/knative-service.yaml`
- `argocd/applications/torghut/lean-runner-deployment.yaml`
- `docs/torghut/design-system/v1/ai-layer-circuit-breakers-and-fallbacks.md`
- `docs/torghut/design-system/v1/trading-safety-kill-switches.md`
- `docs/torghut/design-system/v1/torghut-autonomous-trading-system.md`
- `artifacts/torghut-priorities/p1/iteration-4.md`

## Residual risks

- `LLM_FAIL_MODE=pass_through` remains in paper deployment for deterministic drift-capture and evaluation workflows; live pass-through still requires explicit approval flow and startup validation.
- `TRADING_EXECUTION_ADVISOR_LIVE_APPLY_ENABLED` and `TRADING_AUTONOMY_ALLOW_LIVE_PROMOTION` are now explicit in GitOps env, but alternate execution paths outside these manifests should still be reviewed before emergency actions.
- This change does not alter runtime code semantics; any direct pod-spec edits can still temporarily bypass repository defaults until reconciled by ArgoCD.
