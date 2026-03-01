# Iteration 3 — Regime-router hardening + scheduler migration control

## Scope

- Strengthen regime/HMM contract resolution for runtime decisions and execution gates.
- Move strategy runtime defaults toward scheduler integration with migration gating.
- Add fail-closed handling for stale, invalid, or unknown regime state before trade execution.
- Expand unit coverage for transition-aware fallback and non-authoritative HMM behavior.

## Changes

- `services/torghut/app/trading/regime_hmm.py`
  - Treat explicit legacy/context-like HMM fields as authoritative context payloads (not unknown) in `resolve_hmm_context`.
  - Ensure authoritative HMM route labels normalize to lowercase regime IDs for consistent downstream resolution.

- `services/torghut/app/config.py`
  - Change `trading_strategy_runtime_mode` default from `plugin_v3` to `scheduler_v3`.
  - Update field description to explicitly mention scheduler migration controls.

- `services/torghut/tests/test_config.py`
  - Update default-mode assertion to `scheduler_v3`.

- `services/torghut/tests/test_decisions.py`
  - Add a targeted regression for runtime route-label resolution: transition-shock HMM payloads should not suppress explicit signal regime labels.

- `services/torghut/tests/test_scheduler_regime_resolution.py`
  - Add transition-shock fallback test to require legacy regime label when HMM declares transition shock.

- `services/torghut/tests/test_trading_pipeline.py`
  - Add fail-closed gate validation for stale HMM context in execution gating path.

## Verification

- `cd services/torghut && . .venv/bin/activate && pyright --project pyrightconfig.json`
- `cd services/torghut && . .venv/bin/activate && pyright --project pyrightconfig.alpha.json`
- `cd services/torghut && . .venv/bin/activate && pyright --project pyrightconfig.scripts.json`
- `cd /workspace/lab/services/torghut && python -m unittest tests.test_decisions tests.test_scheduler_regime_resolution tests.test_trading_pipeline tests.test_config`

## Outcome

- Regime context routing and runtime gate behavior is now fail-closed for stale/invalid/transition-shock HMM states.
- Scheduler migration default now points to `scheduler_v3` while preserving fallback controls.
