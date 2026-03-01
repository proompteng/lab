# Iteration 1 - Governed actuation metadata and rollback readiness hardening

Date: 2026-03-01

Scope:
- Close the autonomy loop between lane recommendation artifacts and scheduler governance by propagating `actuation-intent.json` as the canonical actuation intent output.
- Enforce rollback readiness and explicit confirmation posture in lane-produced actuation payloads.
- Improve fault semantics by clearing stale autonomy result state on lane failures.
- Add end-to-end tests for pass/fail behavior, no-signal behavior, and runtime rollback attribution.

Changes made:
1. `services/torghut/app/trading/autonomy/lane.py`
   - Added `actuation_intent_path` to `AutonomousLaneResult`.
   - Added `actuation-intent.json` emission under `gates/`.
   - Added `_build_actuation_intent_payload(...)` including:
     - candidate/candidate hash context,
     - trace IDs and promotion target,
     - `confirmation_phrase_required`/`confirmation_phrase`,
     - rollback readiness readout and `rollback_evidence_missing_checks`,
     - evidence links for rollback readiness (`rollback_evidence_links` + promotion check artifact refs).
   - Added rollback readiness hardening with deterministic readiness inputs in candidate state and candidate snapshot.

2. `services/torghut/app/trading/scheduler.py`
   - Added `TradingState.last_autonomy_actuation_intent`.
   - Applied `_clear_autonomy_result_state()` on exception paths (iteration/loop and lane exceptions).
   - Captured actuation intent path after successful lane runs and added it to `/trading/status` and `/trading/autonomy` visibility via state surface.
   - Extended `_load_last_gate_provenance()` to ingest actuation payload traces and path.

3. `services/torghut/app/main.py`
   - Exposed `last_actuation_intent` under both `/trading/status` and `/trading/autonomy`.
   - Extended `/trading/profitability/runtime` attribution to include actuation intent roll-forward fields:
     - artifact path,
     - actuation allowed effective boolean,
     - rollback readiness flags/missing checks,
     - rollback evidence links.

4. `services/torghut/scripts/run_autonomous_lane.py`
   - Added CLI payload key `actuation_intent_path` so automation and operators can hand off the governed intent artifact directly.

5. Tests
   - `services/torghut/tests/test_autonomous_lane.py`
     - added assertions for `actuation-intent.json` existence and schema fields,
     - added rollback-readiness-precondition failure test path.
   - `services/torghut/tests/test_trading_scheduler_autonomy.py`
     - added actuation intent state wiring checks,
     - added stale-state clearing checks on lane exception.
   - `services/torghut/tests/test_trading_api.py`
     - added status/autonomy visibility tests for `last_actuation_intent`,
     - added profitability runtime attribution assertions for actuation-intent evidence + missing rollback checks.

6. Docs
   - `services/torghut/README.md`: added the `actuation-intent.json` artifact in v3 lane artifact list.
   - `docs/torghut/design-system/v3/full-loop/13-research-ledger-promotion-evidence-spec.md`: updated artifact spec.
   - `docs/torghut/design-system/v3/full-loop/20-autonomous-quant-llm-completion-roadmap-2026-02-13.md`: updated autonomous evidence continuity gap with actuation intent bullet.

Pass/fail + rollback tests added:
- Pass path: lane emits `actuation-intent.json` with `actuation_allowed=true` and profitability evidence evidence refs.
- Fail path: rollback readiness fail test demonstrates `actuation_allowed=false` when `rollback_evidence_missing_checks` is present.
- Rollback enforcement path: API runtime attribution validates effective `actuation_allowed=false` when readiness checks are incomplete.

Validation performed:
- Targeted Python type-checks and Torghut API/autonomy test suites are running as part of this iteration before PR creation.
