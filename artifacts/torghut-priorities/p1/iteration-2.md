# Iteration 2 — Torghut Live-Safety Invariants

- Repository: `proompteng/lab`
- Base branch: `main`
- Head branch: `codex/torghut-p1-safety-loop5`
- Priority: `P1`
- Artifact path: `artifacts/torghut-priorities/p1`
- Priority ID: `p1`

## Scope completed

- Enforced kill-switch posture in live-safe GitOps defaults by enabling `TRADING_KILL_SWITCH_ENABLED` in production manifest while preserving paper-first gating and emergency-stop readiness.
- Confirmed live-only LLM fail posture remains blocked by default by keeping:
  - `TRADING_MODE=paper`
  - `TRADING_LIVE_ENABLED=false`
  - `LLM_FAIL_OPEN_LIVE_APPROVED=false`
  - `LLM_FAIL_MODE_ENFORCEMENT=configured`
- Added concise rollout/verification updates in v1 design docs to match the manifest kill-switch posture and emergency-stop checks.

## Changed files

- `argocd/applications/torghut/knative-service.yaml`
- `docs/torghut/design-system/v1/ai-layer-circuit-breakers-and-fallbacks.md`
- `docs/torghut/design-system/v1/trading-safety-kill-switches.md`
- `docs/torghut/design-system/v1/ai-layer-overview.md`
- `docs/torghut/design-system/v1/torghut-autonomous-trading-system.md`
- `docs/torghut/design-system/v1/component-trading-loop.md`

## Residual risks

- With `TRADING_KILL_SWITCH_ENABLED=true`, order submission is hard-blocked unless disabled explicitly via GitOps; this is intentional by design for default safety, but it removes accidental execution in all modes.
- Any alternate delivery path that rewrites the Knative env block can reintroduce kill-switch drift.
- If live promotion is required, operators must follow an explicit approval sequence to disable kill-switch, then gate live through `TRADING_MODE=live`, `TRADING_LIVE_ENABLED=true`, and `LLM_FAIL_OPEN_LIVE_APPROVED=true` with staged verification.
