# Iteration 1 — Torghut Live-Safety Invariants

- Repository: `proompteng/lab`
- Base branch: `main`
- Head branch: `codex/torghut-p1-safety-loop5`
- Priority: `P1`
- Artifact path: `artifacts/torghut-priorities/p1`

## Scope completed

- Restored paper-first runtime defaults in GitOps manifests:
  - `TRADING_MODE=paper` in both Knative service and Lean runner.
  - Trading accounts in `TRADING_ACCOUNTS_JSON` default to paper mode.
- Enforced live guardrails and kill-switch posture:
  - `TRADING_LIVE_ENABLED=false`.
  - `TRADING_EMERGENCY_STOP_ENABLED=true`.
  - `LLM_FAIL_OPEN_LIVE_APPROVED=false` while keeping paper pass-through default path.
- Added rollout/verification notes to design docs under `docs/torghut/design-system/v1/**`.
- Updated manifest contract test to assert paper-safe defaults and live fail-open approval logic when live mode is explicitly enabled.

## Changed files

- `argocd/applications/torghut/knative-service.yaml`
- `argocd/applications/torghut/lean-runner-deployment.yaml`
- `docs/torghut/design-system/v1/ai-layer-circuit-breakers-and-fallbacks.md`
- `docs/torghut/design-system/v1/component-trading-loop.md`
- `docs/torghut/design-system/v1/trading-safety-kill-switches.md`
- `docs/torghut/design-system/v1/torghut-autonomous-trading-system.md`
- `services/torghut/tests/test_live_config_manifest_contract.py`

## Residual risks

- No change to live emergency routing in runtime beyond defaults; operator must still explicitly set live approval if an explicit pass-through live exception is required.
- `TRADING_KILL_SWITCH_ENABLED` remains `false` by default; this is intentional but reduces immediate hard stop unless the emergency-stop path is used.
- Any alternate Helm/overlay path that also deploys `argocd/applications/torghut` values could reintroduce live defaults if drift is not monitored.
