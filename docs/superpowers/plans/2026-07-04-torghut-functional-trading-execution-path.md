# Torghut Functional Trading Execution Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring Torghut to a functional trading state where one clean execution path generates, risk-checks, routes, submits, journals, and reports orders.

**Architecture:** Replace the current simple-lane/proof-floor/paper-route authority maze with one execution pipeline: `signal -> candidate -> risk -> session route -> broker submit -> journal -> status`. Keep runtime ledger, proof, route reacquisition, alpha readiness, and profit quorum payloads as diagnostics only. The only hard blockers in the submit path are operational disables, kill switch, unavailable selected broker/testnet route, invalid order, and concrete risk breach.

**Tech Stack:** Python 3.11/3.12, FastAPI, SQLAlchemy/Postgres, Alpaca adapter, simulation/testnet adapter, Hyperliquid execution runtime, pytest, pyright, Argo CD GitOps.

---

## Current Failure Evidence

Live readback showed:

- Argo and Knative were healthy, but that was not trading proof.
- `/trading/status.execution_route` selected `testnet` after hours.
- `/trading/status.operational_submission_gate.allowed` was `true`.
- `/trading/status.simple_lane_orders_submitted_total` was `0`.
- Runtime ledger showed `filled_notional: 0`, `closed_trade_count: 0`, and `open_position_count: 0`.
- Scheduler logs repeated `alpaca_regular_session_closed` with `target_count=0`.
- Profit and route surfaces were still `observe_only`, `repair_only`, and `zero_notional`.
- Hyperliquid runtime had repeated `TimeoutError` cycles and temporary `/readyz` 503s.

Functional trading means current order proof, not rollout proof.

## 20 Whys

1. Why is Torghut not working?
   Answer: The service is alive but not trading. Live status showed zero submitted orders, zero filled notional, zero closed trades, and zero open positions.
   Action: Define success as accepted order/fill/open-order proof, not pod readiness.

2. Why is it not submitting orders?
   Answer: No valid order reaches the broker/testnet adapter. `simple_lane_orders_submitted_total` stayed `0`, so the failure is before or at submit, not only reconciliation.
   Action: Instrument one route-neutral execution counter and require it to increment only after adapter acceptance.

3. Why does no valid order reach submit?
   Answer: The scheduler reaches target discovery and decision plumbing, then fails to produce a nonzero routeable target for the current session.
   Action: Replace target discovery with one route-aware target selector that always returns bounded testnet targets after hours when operational risk allows.

4. Why does target discovery produce no routeable targets?
   Answer: `_bounded_paper_route_signal_scope` returns `None` when `self._is_market_session_open(now)` is false.
   Action: Remove the market-session early return for the testnet route; use session only for route choice.

5. Why does `alpaca_regular_session_closed` keep appearing?
   Answer: The old paper-route evidence collection assumes a regular-session target window, so after-hours testnet is treated as a collection window failure.
   Action: Delete paper-route session window authority from live/testnet execution and keep it only as diagnostic evidence collection.

6. Why is that wrong for the required behavior?
   Answer: The product requirement is explicit: Alpaca during market hours, testnet outside market hours. Testnet must not inherit Alpaca session closure as a blocker.
   Action: Make the route decision `alpaca_regular_session_open ? alpaca : testnet`.

7. Why did the previous routing change not fix trading?
   Answer: It changed the destination selection but did not change the upstream candidate/notional path that decides whether an order exists.
   Action: Move route selection before candidate sizing and make target selection consume the selected route.

8. Why is notional still zero?
   Answer: Profit quorum, route reacquisition, and quality frontier diagnostics still set `max_notional`, `paper_notional_limit`, and `live_notional_limit` to `0`.
   Action: Remove these diagnostics from notional authority. Only risk caps set notional limits.

9. Why are diagnostics still controlling authority?
   Answer: The system still treats proof/promotion/readiness objects as implicit capital gates even after named submission blockers were removed.
   Action: Move proof floor, profit quorum, route reacquisition board, runtime ledger, alpha readiness, and TCA surfaces under `diagnostics` only.

10. Why were the named blockers not enough to remove?
    Answer: Removing `alpha_readiness_not_promotion_eligible` and runtime-ledger blocker strings from one gate left equivalent state machines in route/capital construction.
    Action: Delete the authority role, not only the string names.

11. Why is `simple_lane_orders_submitted_total` garbage?
    Answer: It leaks an implementation lane into the operator contract and lets the API look like a lane status page instead of execution truth.
    Action: Remove it and expose `execution.orders_submitted_total`.

12. Why is the `simple_lane` concept harmful now?
    Answer: It creates parallel semantics: simple submit, live submit, live gate, operational gate, proof gate, paper-route gate, and adapter route can disagree.
    Action: Collapse to one execution path: `candidate -> risk -> route -> submit -> journal -> status`.

13. Why is `/trading/status` misleading?
    Answer: It mixes proof floors, repair boards, runtime ledger readbacks, route diagnostics, and lane counters at the same level as actual execution state.
    Action: Make top-level status show `execution`; move the rest to `diagnostics`.

14. Why do false fixes keep happening?
    Answer: A fix can make one layer green while another layer still zeroes notional or suppresses submit.
    Action: Add tests that fail unless a full after-hours testnet order is generated and submitted through the selected route.

15. Why did tests not catch this?
    Answer: Tests assert payloads and individual gate states, not the actual invariant that outside market hours testnet submits a bounded order.
    Action: Add end-to-end unit tests for after-hours testnet route, bounded target creation, submit acceptance, journal event, and status readback.

16. Why is market-hours behavior fragile?
    Answer: Market session is doing two jobs: route choice and candidate collection eligibility.
    Action: Split them. Session decides only route. Target selection decides whether there is a tradable candidate for that route.

17. Why is Hyperliquid runtime still unreliable?
    Answer: The runtime loop can hit `TimeoutError`, and readiness temporarily returns 503 even though the pod stays alive.
    Action: Bound cycle runtime with timeout handling, continue the loop after failures, and report degraded state without killing execution continuity.

18. Why can gross exposure still stall testnet?
    Answer: Over-cap state can block normal orders without guaranteeing reduce-only remediation happens first in the normal cycle.
    Action: Wire reduce-only into the normal runtime loop: over cap closes largest exposure first, skips new exposure, then resumes normal orders under cap.

19. Why was the previous goal acceptance wrong?
    Answer: It accepted Argo sync, pod readiness, and gate readiness as success. Those prove deployment, not trading.
    Action: Acceptance must require accepted order id or fill/open-order, journal row, incremented execution counter, and selected route proof.

20. Why is the correct root answer one execution path?
    Answer: The current system is overengineered because multiple advisory/proof systems accidentally became authority systems. That creates hidden vetoes.
    Action: Build one clean authority path and make every non-operational proof surface diagnostic-only unless it is an explicit risk breach.

## Functional Trading Contract

The final status contract must have one execution section:

```json
{
  "execution": {
    "route": "alpaca",
    "route_reason": "alpaca_regular_session_open",
    "gate": {
      "allowed": true,
      "blocked_reasons": []
    },
    "orders_submitted_total": 1,
    "orders_rejected_total": 0,
    "last_submitted_order": {
      "route": "alpaca",
      "symbol": "NVDA",
      "side": "buy",
      "notional": "10",
      "broker_order_id": "broker-id",
      "submitted_at": "2026-07-04T00:00:00Z"
    }
  },
  "diagnostics": {
    "runtime_ledger": {},
    "proof_floor": {},
    "profit_signal_quorum": {},
    "route_reacquisition_board": {}
  }
}
```

The final status contract must not contain:

```text
simple_lane_orders_submitted_total
simple_lane_reject_reason_totals
simple_lane_status
bounded_live_paper_collection_gate
```

Acceptance command:

```bash
rg -n "simple_lane_orders_submitted_total|simple_lane_reject_reason_totals|simple_lane_status|bounded_live_paper_collection_gate" services/torghut/app services/torghut/tests
```

Expected result: no matches in active app code or active tests.

## File Map

- Modify: `services/torghut/app/api/trading_status_response_projection.py`
  - Replace top-level simple lane fields with one `execution` object.
  - Move proof and repair payloads under `diagnostics`.
- Modify: `services/torghut/app/api/trading_status_response_payloads.py`
  - Stop building simple lane status payloads for submission authority.
  - Build one execution summary payload.
- Modify: `services/torghut/app/trading/submission_council/__init__.py`
  - Remove simple-lane and retired bounded paper collection output from authority.
  - Keep operational blockers only.
- Modify: `services/torghut/app/trading/scheduler/simple_pipeline.py`
  - Remove market-session blocking from after-hours testnet target selection.
  - Stop injecting `simple_lane` authority into live submission gate.
  - Keep the class name only until callers are migrated, then rename in a separate mechanical pass.
- Modify: `services/torghut/app/trading/scheduler/pipeline/submission_policy.py`
  - Make this the single place that increments submit/reject metrics after adapter response.
  - Emit execution event details for status and journal.
- Modify: `services/torghut/app/trading/execution_adapters/adapter_types.py`
  - Keep session route behavior, but expose selected route in one typed route decision.
- Create: `services/torghut/app/trading/execution_runtime.py`
  - Own `ExecutionRouteDecision`, `ExecutionGate`, `ExecutionOrderResult`, and status payload conversion.
- Create: `services/torghut/app/trading/target_selection.py`
  - Own a minimal target selector that returns bounded orders for the selected route.
- Modify: `services/torghut/app/hyperliquid_execution/api.py`
  - Bound cycle execution time and decouple readiness from one slow cycle.
- Modify: `services/torghut/app/hyperliquid_execution/service.py`
  - Ensure over-cap reduce-only runs before normal orders in the normal runtime loop.
- Modify: `argocd/applications/torghut-hyperliquid-runtime/deployment.yaml`
  - Keep gross cap at `250`, per-symbol cap at `50`, and reduce-only enabled.
- Modify tests under `services/torghut/tests/api/`, `services/torghut/tests/simple_pipeline/`, and `services/torghut/tests/hyperliquid_execution/`.

## Task 1: Lock the Failure With End-to-End Tests

**Files:**
- Create: `services/torghut/tests/execution/test_execution_path_contract.py`
- Modify: `services/torghut/tests/api/test_trading_api_status_contract.py`
- Modify: `services/torghut/tests/api/test_trading_api_live_gate_llm.py`

- [ ] **Step 1: Add test for after-hours testnet order generation**

```python
def test_after_hours_testnet_generates_bounded_order_when_operational_gate_allows() -> None:
    route = {"route": "testnet", "alpaca_regular_session_open": False}
    candidate = {"symbol": "NVDA", "side": "buy", "notional": "10"}

    result = build_execution_order(candidate=candidate, route=route, gross_cap_usd="250", per_symbol_cap_usd="50")

    assert result.blocked_reasons == []
    assert result.order.symbol == "NVDA"
    assert result.order.route == "testnet"
    assert result.order.notional == "10"
```

- [ ] **Step 2: Add test that proof diagnostics do not block submit**

```python
def test_diagnostic_profit_and_runtime_ledger_blockers_do_not_block_execution() -> None:
    diagnostics = {
        "profit_signal_quorum": {"aggregate_decision": "observe_only"},
        "runtime_ledger_profit_distance_readback": {
            "blockers": ["runtime_ledger_rows_missing"]
        },
    }
    gate = build_execution_gate(
        trading_enabled=True,
        submit_enabled=True,
        live_submit_enabled=True,
        kill_switch_enabled=False,
        route_available=True,
        diagnostics=diagnostics,
    )

    assert gate.allowed is True
    assert gate.blocked_reasons == []
```

- [ ] **Step 3: Add status contract test that the old simple lane fields are gone**

```python
def test_trading_status_exposes_execution_not_simple_lane(client) -> None:
    payload = client.get("/trading/status").json()

    assert "execution" in payload
    assert "simple_lane_orders_submitted_total" not in payload
    assert "simple_lane_reject_reason_totals" not in payload
    assert "simple_lane_status" not in payload
```

- [ ] **Step 4: Run the focused tests and confirm they fail before implementation**

```bash
cd <repo-root>/services/torghut
uv run --frozen pytest tests/execution/test_execution_path_contract.py tests/api/test_trading_api_status_contract.py tests/api/test_trading_api_live_gate_llm.py -q
```

Expected result: failures showing missing `execution` contract and old simple lane fields still present.

## Task 2: Create the Clean Execution Runtime Model

**Files:**
- Create: `services/torghut/app/trading/execution_runtime.py`
- Test: `services/torghut/tests/execution/test_execution_path_contract.py`

- [ ] **Step 1: Add typed execution objects**

```python
from dataclasses import dataclass
from decimal import Decimal
from collections.abc import Mapping, Sequence


@dataclass(frozen=True)
class ExecutionRouteDecision:
    route: str
    reason: str
    alpaca_regular_session_open: bool
    testnet_after_hours_enabled: bool


@dataclass(frozen=True)
class ExecutionGate:
    allowed: bool
    reason: str
    blocked_reasons: Sequence[str]
    route: ExecutionRouteDecision


@dataclass(frozen=True)
class ExecutionOrderResult:
    route: str
    symbol: str
    side: str
    notional: Decimal
    broker_order_id: str | None
    status: str
    submitted_at: str | None
```

- [ ] **Step 2: Add operational gate builder**

```python
def build_execution_gate(
    *,
    trading_enabled: bool,
    submit_enabled: bool,
    live_submit_enabled: bool,
    kill_switch_enabled: bool,
    route_available: bool,
    route: ExecutionRouteDecision,
    diagnostics: Mapping[str, object] | None = None,
) -> ExecutionGate:
    blocked: list[str] = []
    if not trading_enabled:
        blocked.append("trading_disabled")
    if not submit_enabled:
        blocked.append("submit_disabled")
    if not live_submit_enabled:
        blocked.append("live_submit_disabled")
    if kill_switch_enabled:
        blocked.append("kill_switch_enabled")
    if not route_available:
        blocked.append(f"{route.route}_unavailable")
    reason = blocked[0] if blocked else "operational_submission_ready"
    return ExecutionGate(
        allowed=not blocked,
        reason=reason,
        blocked_reasons=tuple(blocked),
        route=route,
    )
```

- [ ] **Step 3: Run unit tests**

```bash
cd <repo-root>/services/torghut
uv run --frozen pytest tests/execution/test_execution_path_contract.py -q
```

Expected result: execution model tests pass.

## Task 3: Make Route Choice the Only Session Decision

**Files:**
- Modify: `services/torghut/app/trading/submission_council/__init__.py`
- Modify: `services/torghut/app/trading/execution_adapters/adapter_types.py`
- Test: `services/torghut/tests/api/test_trading_api_live_gate_llm.py`

- [ ] **Step 1: Route to Alpaca only when regular session is open**

Expected behavior:

```python
if alpaca_regular_session_open:
    route = "alpaca"
else:
    route = "testnet"
```

- [ ] **Step 2: Block testnet only during Alpaca regular session**

Expected behavior:

```python
assert route == "alpaca" when alpaca_regular_session_open is True
assert route == "testnet" when alpaca_regular_session_open is False
assert testnet orders are not submitted when route == "alpaca"
assert alpaca market closed is not a blocker when route == "testnet"
```

- [ ] **Step 3: Run route tests**

```bash
cd <repo-root>/services/torghut
uv run --frozen pytest tests/api/test_trading_api_live_gate_llm.py -q
```

Expected result: route contract passes for market-hours Alpaca and after-hours testnet.

## Task 4: Delete Simple Lane Status and Authority Surfaces

**Files:**
- Modify: `services/torghut/app/api/trading_status_response_projection.py`
- Modify: `services/torghut/app/api/trading_status_response_payloads.py`
- Modify: `services/torghut/app/trading/submission_council/__init__.py`
- Modify: `services/torghut/tests/api/test_trading_api_simple_lane_profit_floor.py`

- [ ] **Step 1: Replace top-level simple lane fields**

Replace:

```python
"simple_lane_status": payload(payloads, "simple_lane_status"),
"simple_lane_reject_reason_totals": payload(payloads, "simple_lane_reject_reason_totals"),
"simple_lane_orders_submitted_total": state.metrics.orders_submitted_total,
```

With:

```python
"execution": build_execution_status_payload(build),
```

- [ ] **Step 2: Remove simple lane authority payload construction**

Remove payload construction for `simple_lane_status` and `simple_lane_reject_reason_totals` from active status projection. Rejections remain available through `execution.orders_rejected_total` and `execution.reject_reason_totals`.

- [ ] **Step 3: Remove retired bounded collection gate from authority payload**

Delete `bounded_live_paper_collection_gate` from operational authority output. If an old client needs it, expose it only under `diagnostics.legacy` for one release, not in submit authority.

- [ ] **Step 4: Run old-field grep**

```bash
cd <repo-root>
rg -n "simple_lane_orders_submitted_total|simple_lane_reject_reason_totals|simple_lane_status|bounded_live_paper_collection_gate" services/torghut/app services/torghut/tests
```

Expected result: no matches in active app code or active tests.

## Task 5: Build One Target Selection Path

**Files:**
- Create: `services/torghut/app/trading/target_selection.py`
- Modify: `services/torghut/app/trading/scheduler/simple_pipeline.py`
- Test: `services/torghut/tests/execution/test_execution_path_contract.py`

- [ ] **Step 1: Implement route-aware target selection**

Rules:

```text
Alpaca regular session open -> use Alpaca route, regular-session symbols, normal broker constraints.
Alpaca regular session closed -> use testnet route, testnet symbols, bounded notional.
No proof, promotion, runtime-ledger, route-board, or TCA diagnostic can zero the target.
```

- [ ] **Step 2: Remove market-session block from testnet target selection**

The code at `services/torghut/app/trading/scheduler/simple_pipeline.py:481-483` currently returns before target fetch when market session is closed. Replace that behavior with:

```python
route = current_execution_route()
if route.route == "alpaca" and not route.alpaca_regular_session_open:
    return None
if route.route == "testnet":
    return select_testnet_targets(
        strategies=strategies,
        account=account,
        positions=positions,
        gross_cap_usd=Decimal("250"),
        per_symbol_cap_usd=Decimal("50"),
    )
```

- [ ] **Step 3: Bound after-hours testnet notional**

Hard limits:

```text
gross exposure cap: 250 USD
per-symbol cap: 50 USD
default order notional: min(10 USD, remaining per-symbol capacity, remaining gross capacity)
```

- [ ] **Step 4: Run target selection tests**

```bash
cd <repo-root>/services/torghut
uv run --frozen pytest tests/execution/test_execution_path_contract.py tests/simple_pipeline -q
```

Expected result: after-hours testnet target selection produces at least one bounded order in the fake route-available case.

## Task 6: Make Submission Policy the Single Submit Counter

**Files:**
- Modify: `services/torghut/app/trading/scheduler/pipeline/submission_policy.py`
- Modify: `services/torghut/app/trading/scheduler/state/metric_types.py`
- Test: `services/torghut/tests/execution/test_execution_path_contract.py`

- [ ] **Step 1: Keep raw metrics route-neutral**

Keep internal names:

```python
orders_submitted_total
orders_rejected_total
reject_reason_total
```

Do not expose them as simple-lane metrics.

- [ ] **Step 2: Increment submitted total only after selected adapter accepts the order**

Acceptance logic:

```python
response = adapter.submit_order(order)
if response_has_accepted_order_id(response):
    metrics.orders_submitted_total += 1
    state.last_execution_order = execution_order_result_from_response(response)
else:
    metrics.orders_rejected_total += 1
```

- [ ] **Step 3: Journal the same execution result**

One submit result must feed:

```text
status.execution.last_submitted_order
TigerBeetle/order journal event
runtime execution table
```

- [ ] **Step 4: Run submission tests**

```bash
cd <repo-root>/services/torghut
uv run --frozen pytest tests/execution/test_execution_path_contract.py tests/journal_tigerbeetle_order_events -q
```

Expected result: one accepted fake adapter order increments `execution.orders_submitted_total` and writes one journal event.

## Task 7: Demote Proof and Runtime Ledger to Diagnostics

**Files:**
- Modify: `services/torghut/app/api/trading_status_response_projection.py`
- Modify: `services/torghut/app/api/trading_status_response_payloads.py`
- Modify: `services/torghut/app/trading/quality_adjusted_profit_frontier.py`
- Modify: `services/torghut/app/trading/route_reacquisition_board.py`
- Test: `services/torghut/tests/api/test_trading_api_status_contract.py`

- [ ] **Step 1: Move proof surfaces under diagnostics**

Required shape:

```json
{
  "diagnostics": {
    "proof_floor": {},
    "profit_signal_quorum": {},
    "route_reacquisition_board": {},
    "quality_adjusted_profit_frontier": {},
    "runtime_ledger": {}
  }
}
```

- [ ] **Step 2: Remove all diagnostic blockers from submit decisions**

The following strings can remain only under `diagnostics`, never under `execution.gate.blocked_reasons`:

```text
hypothesis_not_promotion_eligible
route_tca_passed_but_dependency_receipts_block_capital
execution_tca_route_universe_exclusions_applied
execution_tca_symbol_missing
promotion_decision_missing
stage_clearance_packet_missing
runtime_ledger_rows_missing
portfolio_runtime_ledger_summary_missing
```

- [ ] **Step 3: Run diagnostic contract tests**

```bash
cd <repo-root>/services/torghut
uv run --frozen pytest tests/api/test_trading_api_status_contract.py -q
```

Expected result: diagnostics still render, but execution gate contains only operational blockers.

## Task 8: Fix Hyperliquid Runtime Loop and Reduce-Only Flow

**Files:**
- Modify: `services/torghut/app/hyperliquid_execution/api.py`
- Modify: `services/torghut/app/hyperliquid_execution/service.py`
- Modify: `services/torghut/app/hyperliquid_execution/risk.py`
- Test: `services/torghut/tests/hyperliquid_execution/test_runtime_surfaces.py`

- [ ] **Step 1: Bound runtime cycle wall time**

Expected behavior:

```python
try:
    result = await asyncio.wait_for(asyncio.to_thread(_run_one_cycle), timeout=config.cycle_timeout_seconds)
except TimeoutError:
    record_cycle_failure("timeout")
    keep_process_alive()
```

- [ ] **Step 2: Do not make one timeout equal permanent runtime death**

Readiness can report degraded for recent timeouts, but the background loop must continue.

- [ ] **Step 3: Run reduce-only first when over cap**

Expected behavior:

```text
if gross_exposure_usd >= 250:
    submit reduce-only close for largest exposure
    skip normal new exposure orders for that cycle
else:
    allow normal bounded testnet orders
```

- [ ] **Step 4: Run Hyperliquid tests**

```bash
cd <repo-root>/services/torghut
uv run --frozen pytest tests/hyperliquid_execution/test_runtime_surfaces.py tests/hyperliquid_execution/test_maintenance.py -q
```

Expected result: timeout cycles are recorded without killing the runtime loop, and over-cap state executes reduce-only before normal orders.

## Task 9: Update GitOps Runtime Configuration

**Files:**
- Modify: `argocd/applications/torghut/deployment.yaml`
- Modify: `argocd/applications/torghut-sim/deployment.yaml`
- Modify: `argocd/applications/torghut-hyperliquid-runtime/deployment.yaml`
- Modify: `services/torghut/tests/live_config_manifest_contract/`

- [ ] **Step 1: Wire clean execution flags**

Expected environment contract:

```text
TRADING_ENABLED=true
TRADING_SUBMIT_ENABLED=true
TRADING_LIVE_SUBMIT_ENABLED=true
TRADING_TESTNET_AFTER_HOURS_ENABLED=true
TRADING_TESTNET_GROSS_EXPOSURE_CAP_USD=250
TRADING_TESTNET_PER_SYMBOL_CAP_USD=50
```

- [ ] **Step 2: Remove simple-lane config names from manifests when equivalent clean names exist**

Keep backward-compatible env parsing in Python only if needed for one release, but manifests must use clean names.

- [ ] **Step 3: Run Argo lint**

```bash
cd <repo-root>
bun run lint:argocd
```

Expected result: Argo manifests render and lint.

## Task 10: Full Local Validation

**Files:**
- All touched Torghut files.

- [ ] **Step 1: Sync dev environment**

```bash
cd <repo-root>/services/torghut
uv sync --frozen --extra dev
```

Expected result: dependency sync succeeds without lockfile edits.

- [ ] **Step 2: Run pyright profiles**

```bash
cd <repo-root>/services/torghut
uv run --frozen pyright --project pyrightconfig.json
uv run --frozen pyright --project pyrightconfig.alpha.json
uv run --frozen pyright --project pyrightconfig.scripts.json
```

Expected result: all three pyright profiles pass.

- [ ] **Step 3: Run focused pytest suite**

```bash
cd <repo-root>/services/torghut
uv run --frozen pytest \
  tests/execution/test_execution_path_contract.py \
  tests/api/test_trading_api_status_contract.py \
  tests/api/test_trading_api_live_gate_llm.py \
  tests/simple_pipeline \
  tests/hyperliquid_execution \
  -q
```

Expected result: targeted Torghut execution, status, routing, and Hyperliquid tests pass.

- [ ] **Step 4: Run app manifest lint**

```bash
cd <repo-root>
bun run lint:argocd
```

Expected result: Argo lint passes.

## Task 11: Merge and Live Proof

**Files:**
- PR body from `.github/PULL_REQUEST_TEMPLATE.md`.

- [ ] **Step 1: Open PR with exact scope**

PR title:

```text
fix(torghut): replace simple lane with clean execution path
```

- [ ] **Step 2: Wait for mandatory checks**

```bash
PR_NUMBER="$(gh pr view --json number -q .number -R proompteng/lab)"
gh pr checks "$PR_NUMBER" --watch -R proompteng/lab
```

Expected result: all required checks pass.

- [ ] **Step 3: Squash merge**

```bash
PR_NUMBER="$(gh pr view --json number -q .number -R proompteng/lab)"
gh pr merge "$PR_NUMBER" --squash -R proompteng/lab
```

Expected result: PR merged to main.

- [ ] **Step 4: Verify Argo rollout**

```bash
kubectl get applications -n argocd torghut torghut-hyperliquid-runtime -o wide
kubectl rollout status deploy/torghut-hyperliquid-runtime -n torghut --timeout=10m
kubectl get ksvc -n torghut torghut torghut-sim
```

Expected result: apps synced, runtime rolled out, serving revisions ready.

- [ ] **Step 5: Prove trading, not just readiness**

After market close:

```bash
kubectl exec -n torghut deploy/torghut-hyperliquid-runtime -- python - <<'PY'
import json, urllib.request
print(json.dumps(json.load(urllib.request.urlopen("http://127.0.0.1:8181/readyz", timeout=10)), indent=2))
PY
kubectl exec -n torghut deploy/torghut-hyperliquid-runtime -- python - <<'PY'
import json, urllib.request
print(json.dumps(json.load(urllib.request.urlopen("http://127.0.0.1:8181/report", timeout=10)), indent=2))
PY
kubectl exec -n torghut deploy/torghut-hyperliquid-runtime -- python - <<'PY'
import json, urllib.request
print(json.dumps(json.load(urllib.request.urlopen("http://torghut.torghut.svc.cluster.local/trading/status", timeout=20))["execution"], indent=2))
PY
```

Expected result:

```text
execution.route == testnet
execution.gate.allowed == true
execution.orders_submitted_total > previous_orders_submitted_total
execution.last_submitted_order.route == testnet
Hyperliquid report shows submitted order, open order, fill, or reduce-only action
```

During Alpaca regular session:

```text
execution.route == alpaca
testnet normal new exposure orders do not submit
Alpaca accepted order or explicit broker operational blocker is visible
```

## Non-Negotiable Acceptance Criteria

- `/trading/status` contains one `execution` object and no top-level simple-lane fields.
- `rg` finds no active `simple_lane_orders_submitted_total`.
- Proof, runtime ledger, alpha readiness, route boards, and profit quorums never appear in `execution.gate.blocked_reasons`.
- Alpaca regular session routes to Alpaca.
- Outside Alpaca regular session routes to testnet.
- After-hours testnet creates and submits a bounded order when operational gate and risk allow it.
- Over-cap Hyperliquid state runs reduce-only first, not a normal new exposure loop.
- CI is green.
- Live proof includes an accepted order id, fill/open-order/reduce-only action, journal row, and an incremented execution counter.
