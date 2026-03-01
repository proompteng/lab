# Iteration 3 — Torghut Live-Safety Invariants

- Repository: `proompteng/lab`
- Base branch: `main`
- Head branch: `codex/torghut-p1-safety-loop5`
- Priority: `P1`
- Artifact path: `artifacts/torghut-priorities/p1`

## Scope completed

- Audited deployment manifests against the Torghut design-system papers for paper/live and kill-switch semantics.
- Confirmed and retained paper-first runtime defaults in GitOps manifests:
  - `TRADING_MODE=paper` and `TRADING_LIVE_ENABLED=false` in `argocd/applications/torghut/knative-service.yaml`.
  - `TRADING_MODE=paper` in `argocd/applications/torghut/lean-runner-deployment.yaml`.
- Kept explicit live-path guardrails:
  - `LLM_FAIL_OPEN_LIVE_APPROVED=false` (with existing configured fail-mode behavior in place)
  - `TRADING_KILL_SWITCH_ENABLED=true`
  - `TRADING_EMERGENCY_STOP_ENABLED=true`
- Added/updated rollout + verification notes in Torghut design-system docs to reflect the drift-corrected defaults.
- Corrected a live-canary docs variable reference to match the actual LEAN canary runtime flag.

## Changed files

- `argocd/applications/torghut/knative-service.yaml`
- `argocd/applications/torghut/lean-runner-deployment.yaml`
- `docs/torghut/design-system/v1/ai-layer-circuit-breakers-and-fallbacks.md`
- `docs/torghut/design-system/v1/ai-layer-overview.md`
- `docs/torghut/design-system/v1/component-trading-loop.md`
- `docs/torghut/design-system/v1/torghut-autonomous-trading-system.md`
- `docs/torghut/design-system/v1/trading-safety-kill-switches.md`
- `services/torghut/tests/test_live_config_manifest_contract.py`

## Residual risks

- `LLM_FAIL_MODE` remains `pass_through` in deployed config with configured enforcement; safe for paper-by-default operation but this allows AI fail-open in explicit live promotion scenarios if operators intentionally enable `LLM_FAIL_OPEN_LIVE_APPROVED=true`.
- No guardrails outside Kubernetes manifests (for example unreviewed overlays or direct pod edits) are automatically prevented from reintroducing live-enabled defaults.
- Any alternate deployment path that bypasses GitOps should be treated as an emergency-only workflow with post-change manifest reconciliation.
