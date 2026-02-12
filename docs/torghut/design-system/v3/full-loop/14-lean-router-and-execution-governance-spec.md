# Lean Router and Execution Governance Spec

## Status
- Version: `v3-exec-governance`
- Last updated: `2026-02-12`
- Maturity: `draft`

## Objective
Define a deterministic, observable order-routing contract so LEAN and Alpaca execution behavior is safe, explainable, and recoverable.

## Problem Statement
Live config uses `TRADING_EXECUTION_ADAPTER=lean` with fallback to Alpaca and policy `all`. Current behavior does not yet guarantee:
- persistent adapter-route provenance on every execution,
- formal kill/rollback conditions when LEAN degrades,
- paper/live parity checks between routed and non-routed symbols.

## Target Architecture

### Components
1. **Adapter Builder**
   - Source-of-truth env: `TRADING_EXECUTION_ADAPTER`, `TRADING_EXECUTION_ADAPTER_POLICY`, `TRADING_EXECUTION_ADAPTER_SYMBOLS`, `TRADING_EXECUTION_FALLBACK_ADAPTER`, `TRADING_LEAN_RUNNER_URL`.
   - Builds a single execution object used by scheduler and reconciliation.

2. **Adapter Policy Resolver**
   - Policy modes:
     - `all`: every symbol attempts LEAN first.
     - `allowlist`: only `TRADING_EXECUTION_ADAPTER_SYMBOLS` use LEAN.
   - Default to non-LEAN when misconfigured.

3. **Adapter Telemetry Layer**
   - Persist both requested route and observed route.
   - Add `execution_adapter` + `execution_fallback_reason` fields in execution metadata.

4. **Fallback Controller**
   - On timeout/http error/invalid payload for LEAN, fallback to Alpaca if policy allows.
   - Mark attempt count and degradation event.

5. **Kill-Switch Layer**
   - Route disable override on hard circuit conditions:
     - LEAN error rate breach window,
     - policy-computed notional mismatch,
     - stale runner health.

## Implementation Requirements
- Add structured route fields in execution metadata JSON.
- Emit counters:
  - `execution_requests_total{adapter="lean|alpaca"}`
  - `execution_fallback_total`
  - `execution_fallback_reason_total`
- Include route attribution in reconciliation logs (`actual`, `expected`, `fallback_reason`).
- Add integration test that forces Lean failure and verifies:
  - fallback is used,
  - raw payload contains fallback marker,
  - `execution_route` is correct in DB row.

## Failure Modes and Containment
- LEAN runner down: disable LEAN by gate and continue with Alpaca.
- Repeated fallback on one symbol window: promote to explicit manual-review state for symbol.
- Divergent LEAN/Alpaca order ids: reject strategy enablement until route parity tests pass.

## Acceptance Criteria
- Every order has route evidence in persistent row.
- Fallback path is observable and bounded.
- Manual kill command can disable LEAN globally without redeploying service code.
