# DSPy Jangar Decisioning Iteration 7

- Date: 2026-03-01
- Repository: proompteng/lab
- Base branch: main
- Head branch: codex/torghut-p2-dspy-jangar-loop10-20260301b
- Priority ID: 0
- Artifact path: services/torghut/artifacts/dspy-production/notes

## Scope

- Remove live fallback-to-self-hosted transport in the Jangar-backed LLM client path when trading is live.
- Preserve DSPy-first live policy/gate behavior while keeping deterministic fail-closed semantics for unsupported states.
- Add regression coverage for the no-fallback-live boundary.

## Changes made

- `services/torghut/app/trading/llm/client.py`
  - In `LLMClient.request_review`, if provider is `jangar` and the process is in live mode,
    a Jangar call failure now fails fast without attempting self-hosted fallback.
  - This keeps live decisioning bounded to the configured Jangar-compatible DSPy path.
- `services/torghut/tests/test_llm_jangar_client.py`
  - Updated live fallback test to assert the self-hosted fallback is not invoked when Jangar fails in live mode.
  - Preserved existing paper-mode fallback behavior and existing endpoint-normalization coverage.

## Validation status

- `bunx oxfmt --check services/torghut/app/trading/llm/client.py services/torghut/tests/test_llm_jangar_client.py`
- `bun run --filter torghut test services/torghut/tests/test_llm_jangar_client.py`
