# Torghut Promotion Authority Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Torghut's ambiguous `promotion_allowed` / `final_promotion_allowed` boolean soup with one canonical promotion authority model that cleanly separates evidence collection, paper probation, and capital promotion.

**Architecture:** Add a small domain module that owns promotion authority state and legacy field projection. Refactor proof, target-plan, runtime-import, and scheduler consumers to read canonical `capital_promotion_allowed` / `promotion_stage` semantics while keeping legacy booleans as compatibility mirrors during rollout.

**Tech Stack:** Python 3.11/3.12, dataclasses, `StrEnum`, SQLAlchemy-backed Torghut runtime ledger tests, pytest, Pyright, Ruff, existing GitOps/CI promotion workflow.

---

## Current Problem

The existing fields are not clean:

- `promotion_allowed` sometimes means "candidate proof gate says eligible."
- `final_promotion_allowed` sometimes means "all final/live/capital blockers cleared."
- `capital_promotion_allowed` is the field name closest to the actual safety meaning.
- Bounded collection code treats `promotion_allowed`, `final_promotion_allowed`, `final_promotion_authorized`, and `capital_promotion_allowed` as equivalent stop signals.
- Source-collection and bounded-paper paths set all promotion booleans false, which is safe but unclear.

The system needs a single source of truth:

- `promotion_stage`: one of `source_collection`, `paper_probation`, `capital_blocked`, `capital_allowed`.
- `capital_promotion_allowed`: the only boolean allowed to mean "may route promoted capital."
- `promotion_blockers`: the canonical blocker list for why capital promotion is not allowed.
- Compatibility fields `promotion_allowed`, `final_promotion_allowed`, and `final_promotion_authorized` are generated in one place only and mirror `capital_promotion_allowed` until downstream API compatibility is retired.

## Target File Structure

- Create `services/torghut/app/trading/promotion_authority.py`
  - Owns `PromotionStage`, `PromotionAuthority`, constructors, legacy projection, and consumer helpers.
- Create `services/torghut/tests/trading/test_promotion_authority.py`
  - Unit tests for canonical semantics and legacy compatibility projection.
- Modify `services/torghut/app/trading/runtime_authority_verifier_modules/shared_context.py`
  - Emit canonical capital authority fields through `PromotionAuthority`.
- Modify `services/torghut/app/trading/submission_council_modules/import_plan.py`
  - Use constructors for source-collection and paper-probation collection targets.
- Modify `services/torghut/app/trading/submission_council_modules/paper_probation.py`
  - Replace direct promotion boolean literals with authority projection.
- Modify `services/torghut/app/trading/paper_route_target_plan_modules/materialization.py`
  - Replace direct promotion boolean literals with authority projection.
- Modify `services/torghut/app/trading/paper_route_target_plan_modules/target_plan.py`
  - Keep compatibility fields only by using authority projection.
- Modify `services/torghut/app/trading/proofs/targets.py`
  - Emit compatibility fields from the authority helper.
- Modify `services/torghut/app/trading/scheduler/target_plan_helpers_modules/bounded_collection.py`
  - Replace OR checks across legacy booleans with canonical helper `target_capital_promotion_allowed`.
- Modify `services/torghut/app/trading/runtime_window_import_modules/common.py`
  - Compute evidence blocking reasons from canonical helpers; legacy false fields must not add duplicate blockers.
- Modify `services/torghut/app/trading/runtime_window_import_modules/persistence_materialization.py`
  - Persist canonical authority fields.
- Modify `services/torghut/app/trading/scheduler/source_collection_modules/decision_helpers.py`
  - Use source-collection constructor for bounded data collection metadata.
- Modify `services/torghut/app/trading/scheduler/source_collection_modules/decision_lineage.py`
  - Use canonical compatibility projection when building decision lineage.
- Modify `services/torghut/app/trading/scheduler/source_collection_modules/target_plan_fetch.py`
  - Normalize incoming target plans through canonical authority helper.
- Modify `services/torghut/app/trading/scheduler/submission_preparation_modules/quote_routeability.py`
  - Use canonical blocked authority projection for non-routeable targets.
- Update tests under:
  - `services/torghut/tests/submission_council/`
  - `services/torghut/tests/pipeline/`
  - `services/torghut/tests/verify_trading_readiness/`
  - `services/torghut/tests/run_empirical_promotion_jobs/`
  - `services/torghut/tests/materialize_bounded_paper_route_targets/`

## Invariants

- Source collection can submit bounded paper evidence only when `bounded_live_paper_collection_authorized=true`.
- Source collection must always have `capital_promotion_allowed=false`.
- Paper probation can collect evidence without capital promotion.
- Capital promotion is allowed only when `capital_promotion_allowed=true`.
- Legacy `promotion_allowed`, `final_promotion_allowed`, and `final_promotion_authorized` must match `capital_promotion_allowed` until removed.
- No production scheduler code may OR together `promotion_allowed` and `final_promotion_allowed` after this refactor.

---

### Task 1: Add Canonical Promotion Authority Model

**Files:**

- Create: `services/torghut/app/trading/promotion_authority.py`
- Create: `services/torghut/tests/trading/test_promotion_authority.py`

- [ ] **Step 1: Write failing unit tests**

Create `services/torghut/tests/trading/test_promotion_authority.py`:

```python
from app.trading.promotion_authority import (
    PromotionStage,
    capital_allowed_authority,
    capital_blocked_authority,
    paper_probation_authority,
    source_collection_authority,
    target_capital_promotion_allowed,
)


def test_source_collection_authority_is_collection_only() -> None:
    authority = source_collection_authority(
        blockers=["runtime_ledger_source_window_missing"],
    )

    fields = authority.as_target_fields()

    assert fields["promotion_stage"] == "source_collection"
    assert fields["source_collection_authorized"] is True
    assert fields["bounded_live_paper_collection_authorized"] is True
    assert fields["capital_promotion_allowed"] is False
    assert fields["promotion_allowed"] is False
    assert fields["final_promotion_allowed"] is False
    assert fields["final_promotion_authorized"] is False
    assert fields["final_authority_ok"] is False
    assert fields["promotion_blockers"] == ["runtime_ledger_source_window_missing"]
    assert target_capital_promotion_allowed(fields) is False


def test_paper_probation_authority_is_not_capital_authority() -> None:
    authority = paper_probation_authority(
        blockers=["live_runtime_ledger_required"],
    )

    fields = authority.as_target_fields()

    assert fields["promotion_stage"] == "paper_probation"
    assert fields["paper_probation_authorized"] is True
    assert fields["source_collection_authorized"] is False
    assert fields["capital_promotion_allowed"] is False
    assert fields["promotion_allowed"] is False
    assert fields["final_promotion_allowed"] is False
    assert fields["final_promotion_authorized"] is False
    assert target_capital_promotion_allowed(fields) is False


def test_capital_blocked_authority_preserves_blockers() -> None:
    authority = capital_blocked_authority(
        blockers=["mean_daily_net_pnl_after_costs_below_500"],
    )

    fields = authority.as_target_fields()

    assert fields["promotion_stage"] == "capital_blocked"
    assert fields["capital_promotion_allowed"] is False
    assert fields["promotion_allowed"] is False
    assert fields["final_promotion_allowed"] is False
    assert fields["promotion_blockers"] == ["mean_daily_net_pnl_after_costs_below_500"]
    assert target_capital_promotion_allowed(fields) is False


def test_capital_allowed_authority_is_the_only_true_promotion_state() -> None:
    authority = capital_allowed_authority()

    fields = authority.as_target_fields()

    assert authority.stage is PromotionStage.CAPITAL_ALLOWED
    assert fields["promotion_stage"] == "capital_allowed"
    assert fields["capital_promotion_allowed"] is True
    assert fields["promotion_allowed"] is True
    assert fields["final_promotion_allowed"] is True
    assert fields["final_promotion_authorized"] is True
    assert fields["final_authority_ok"] is True
    assert fields["promotion_blockers"] == []
    assert target_capital_promotion_allowed(fields) is True
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd services/torghut
uv run --frozen pytest tests/trading/test_promotion_authority.py -q
```

Expected: FAIL with `ModuleNotFoundError: No module named 'app.trading.promotion_authority'`.

- [ ] **Step 3: Implement the authority model**

Create `services/torghut/app/trading/promotion_authority.py`:

```python
"""Canonical promotion authority state for Torghut trading targets."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from enum import StrEnum
from typing import Any


PROMOTION_AUTHORITY_SCHEMA_VERSION = "torghut.promotion-authority.v1"


class PromotionStage(StrEnum):
    SOURCE_COLLECTION = "source_collection"
    PAPER_PROBATION = "paper_probation"
    CAPITAL_BLOCKED = "capital_blocked"
    CAPITAL_ALLOWED = "capital_allowed"


@dataclass(frozen=True)
class PromotionAuthority:
    stage: PromotionStage
    capital_promotion_allowed: bool
    blockers: tuple[str, ...] = ()
    source_collection_authorized: bool = False
    paper_probation_authorized: bool = False
    bounded_live_paper_collection_authorized: bool = False
    evidence_collection_ok: bool = False

    @property
    def final_authority_ok(self) -> bool:
        return self.capital_promotion_allowed and not self.blockers

    def as_target_fields(self) -> dict[str, object]:
        capital_allowed = self.final_authority_ok
        blockers = list(dict.fromkeys(self.blockers))
        return {
            "promotion_authority_schema_version": PROMOTION_AUTHORITY_SCHEMA_VERSION,
            "promotion_stage": self.stage.value,
            "source_collection_authorized": self.source_collection_authorized,
            "paper_probation_authorized": self.paper_probation_authorized,
            "bounded_live_paper_collection_authorized": (
                self.bounded_live_paper_collection_authorized
            ),
            "evidence_collection_ok": self.evidence_collection_ok,
            "capital_promotion_allowed": capital_allowed,
            "final_authority_ok": capital_allowed,
            "promotion_blockers": blockers,
            "final_promotion_blockers": blockers,
            "runtime_ledger_target_metadata_blockers": blockers,
            "promotion_allowed": capital_allowed,
            "final_promotion_allowed": capital_allowed,
            "final_promotion_authorized": capital_allowed,
        }


def _blockers(values: Sequence[str] | None) -> tuple[str, ...]:
    if values is None:
        return ()
    return tuple(str(value).strip() for value in values if str(value).strip())


def source_collection_authority(
    *,
    blockers: Sequence[str] | None,
    bounded_live_paper_collection_authorized: bool = True,
) -> PromotionAuthority:
    return PromotionAuthority(
        stage=PromotionStage.SOURCE_COLLECTION,
        capital_promotion_allowed=False,
        blockers=_blockers(blockers),
        source_collection_authorized=True,
        bounded_live_paper_collection_authorized=bounded_live_paper_collection_authorized,
        evidence_collection_ok=True,
    )


def paper_probation_authority(
    *,
    blockers: Sequence[str] | None,
    bounded_live_paper_collection_authorized: bool = True,
) -> PromotionAuthority:
    return PromotionAuthority(
        stage=PromotionStage.PAPER_PROBATION,
        capital_promotion_allowed=False,
        blockers=_blockers(blockers),
        paper_probation_authorized=True,
        bounded_live_paper_collection_authorized=bounded_live_paper_collection_authorized,
        evidence_collection_ok=True,
    )


def capital_blocked_authority(
    *,
    blockers: Sequence[str] | None,
) -> PromotionAuthority:
    return PromotionAuthority(
        stage=PromotionStage.CAPITAL_BLOCKED,
        capital_promotion_allowed=False,
        blockers=_blockers(blockers),
    )


def capital_allowed_authority() -> PromotionAuthority:
    return PromotionAuthority(
        stage=PromotionStage.CAPITAL_ALLOWED,
        capital_promotion_allowed=True,
        blockers=(),
    )


def target_capital_promotion_allowed(target: Mapping[str, Any]) -> bool:
    return bool(target.get("capital_promotion_allowed") is True)


def target_promotion_stage(target: Mapping[str, Any]) -> PromotionStage:
    raw = str(target.get("promotion_stage") or "").strip()
    try:
        return PromotionStage(raw)
    except ValueError:
        if target_capital_promotion_allowed(target):
            return PromotionStage.CAPITAL_ALLOWED
        if bool(target.get("source_collection_authorized")):
            return PromotionStage.SOURCE_COLLECTION
        if bool(target.get("paper_probation_authorized")):
            return PromotionStage.PAPER_PROBATION
        return PromotionStage.CAPITAL_BLOCKED
```

- [ ] **Step 4: Run the new tests**

Run:

```bash
cd services/torghut
uv run --frozen pytest tests/trading/test_promotion_authority.py -q
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/torghut/app/trading/promotion_authority.py services/torghut/tests/trading/test_promotion_authority.py
git commit -m "refactor(torghut): add canonical promotion authority"
```

---

### Task 2: Refactor Runtime Authority Verifier To Emit Canonical Fields

**Files:**

- Modify: `services/torghut/app/trading/runtime_authority_verifier_modules/shared_context.py`
- Test: `services/torghut/tests/verify_trading_readiness/test_ready_paper_status_passes_strict_gate.py`

- [ ] **Step 1: Add regression assertions**

In `services/torghut/tests/verify_trading_readiness/test_ready_paper_status_passes_strict_gate.py`, extend the existing passing proof packet assertions so they check:

```python
assert packet_summary["promotion_stage"] == "capital_allowed"
assert packet_summary["capital_promotion_allowed"] is True
assert packet_summary["promotion_allowed"] is True
assert packet_summary["final_promotion_allowed"] is True
assert packet_summary["promotion_blockers"] == []
```

Extend the blocked packet assertions so they check:

```python
assert packet_summary["promotion_stage"] == "capital_blocked"
assert packet_summary["capital_promotion_allowed"] is False
assert packet_summary["promotion_allowed"] is False
assert packet_summary["final_promotion_allowed"] is False
assert packet_summary["promotion_blockers"]
```

- [ ] **Step 2: Run targeted readiness tests**

Run:

```bash
cd services/torghut
uv run --frozen pytest tests/verify_trading_readiness/test_ready_paper_status_passes_strict_gate.py -q
```

Expected: FAIL because `promotion_stage` and `promotion_blockers` are missing.

- [ ] **Step 3: Refactor verifier return payload**

In `services/torghut/app/trading/runtime_authority_verifier_modules/shared_context.py`, import:

```python
from app.trading.promotion_authority import (
    capital_allowed_authority,
    capital_blocked_authority,
)
```

Replace the current direct fields:

```python
"authority_allowed": final_authority_ok,
"promotion_allowed": final_authority_ok,
"capital_promotion_allowed": final_authority_ok,
"final_authority_ok": final_authority_ok,
```

with:

```python
authority = (
    capital_allowed_authority()
    if final_authority_ok
    else capital_blocked_authority(blockers=blockers)
)
...
"authority_allowed": final_authority_ok,
**authority.as_target_fields(),
```

- [ ] **Step 4: Run targeted readiness tests**

Run:

```bash
cd services/torghut
uv run --frozen pytest tests/verify_trading_readiness/test_ready_paper_status_passes_strict_gate.py -q
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/torghut/app/trading/runtime_authority_verifier_modules/shared_context.py services/torghut/tests/verify_trading_readiness/test_ready_paper_status_passes_strict_gate.py
git commit -m "refactor(torghut): canonicalize runtime authority payload"
```

---

### Task 3: Refactor Import Plan Source Collection And Paper Probation Targets

**Files:**

- Modify: `services/torghut/app/trading/submission_council_modules/import_plan.py`
- Test: `services/torghut/tests/submission_council/test_source_collection_candidates.py`
- Test: `services/torghut/tests/submission_council/test_paper_probation_import_plan.py`

- [ ] **Step 1: Add source-collection authority assertions**

In `test_source_collection_candidates.py`, update source-collection target assertions:

```python
assert target["promotion_stage"] == "source_collection"
assert target["source_collection_authorized"] is True
assert target["bounded_live_paper_collection_authorized"] is True
assert target["capital_promotion_allowed"] is False
assert target["promotion_allowed"] is False
assert target["final_promotion_allowed"] is False
assert target["promotion_blockers"] == target["final_promotion_blockers"]
```

In `test_paper_probation_import_plan.py`, update paper-probation target assertions:

```python
assert target["promotion_stage"] == "paper_probation"
assert target["paper_probation_authorized"] is True
assert target["source_collection_authorized"] is False
assert target["capital_promotion_allowed"] is False
assert target["promotion_allowed"] is False
assert target["final_promotion_allowed"] is False
assert "live_runtime_ledger_required" in target["promotion_blockers"]
```

- [ ] **Step 2: Run focused tests**

Run:

```bash
cd services/torghut
uv run --frozen pytest tests/submission_council/test_source_collection_candidates.py tests/submission_council/test_paper_probation_import_plan.py -q
```

Expected: FAIL because targets do not consistently include `promotion_stage` / `promotion_blockers`.

- [ ] **Step 3: Refactor `_runtime_ledger_base_import_target`**

In `import_plan.py`, import:

```python
from app.trading.promotion_authority import (
    paper_probation_authority,
    source_collection_authority,
)
```

Inside `_runtime_ledger_base_import_target`, before the return:

```python
authority = (
    source_collection_authority(
        blockers=candidate.final_blockers,
        bounded_live_paper_collection_authorized=bounded_probe_authorized,
    )
    if candidate.source_collection
    else paper_probation_authority(
        blockers=candidate.final_blockers,
        bounded_live_paper_collection_authorized=bounded_probe_authorized,
    )
)
```

In the returned dict, remove these direct literals:

```python
"paper_probation_authorized": candidate.paper_probation_satisfied,
"source_collection_authorized": candidate.source_collection,
"evidence_collection_ok": True,
"bounded_live_paper_collection_authorized": bounded_probe_authorized,
"capital_promotion_allowed": False,
"final_authority_ok": False,
"promotion_allowed": False,
"final_promotion_authorized": False,
"final_promotion_allowed": False,
"final_promotion_blockers": candidate.final_blockers,
"runtime_ledger_target_metadata_blockers": candidate.final_blockers,
```

Replace them with:

```python
**authority.as_target_fields(),
```

Keep the existing scope fields:

```python
"paper_probation_authorization_scope": (
    "evidence_collection_only" if candidate.paper_probation_satisfied else ""
),
"source_collection_authorization_scope": (
    "source_window_evidence_collection_only" if candidate.source_collection else ""
),
```

- [ ] **Step 4: Refactor merged plan summary**

In `_merge_manifest_bounded_collection_targets`, replace direct plan-level promotion literals with:

```python
merged_plan["promotion_stage"] = "source_collection"
merged_plan["capital_promotion_allowed"] = False
merged_plan["final_authority_ok"] = False
merged_plan["promotion_allowed"] = False
merged_plan["final_promotion_authorized"] = False
merged_plan["final_promotion_allowed"] = False
merged_plan["promotion_blockers"] = list(_BOUNDED_PAPER_ROUTE_COLLECTION_PROMOTION_BLOCKERS)
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
cd services/torghut
uv run --frozen pytest tests/submission_council/test_source_collection_candidates.py tests/submission_council/test_paper_probation_import_plan.py -q
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add services/torghut/app/trading/submission_council_modules/import_plan.py services/torghut/tests/submission_council/test_source_collection_candidates.py services/torghut/tests/submission_council/test_paper_probation_import_plan.py
git commit -m "refactor(torghut): normalize import plan promotion authority"
```

---

### Task 4: Refactor Target Plan Materialization Producers

**Files:**

- Modify: `services/torghut/app/trading/paper_route_target_plan_modules/materialization.py`
- Modify: `services/torghut/app/trading/paper_route_target_plan_modules/target_plan.py`
- Modify: `services/torghut/app/trading/proofs/targets.py`
- Test: `services/torghut/tests/materialize_bounded_paper_route_targets/test_commit_dynamic_plan_filters_to_active_target_window_subset.py`
- Test: `services/torghut/tests/test_trading_proofs_api.py`

- [ ] **Step 1: Add materialization assertions**

In materialization tests, assert bounded targets are collection-only:

```python
assert report["promotion_stage"] == "source_collection"
assert report["capital_promotion_allowed"] is False
assert report["promotion_allowed"] is False
assert report["final_promotion_allowed"] is False
assert report["promotion_blockers"]
```

In proofs API tests, assert proof-derived target defaults are capital-blocked:

```python
assert target["promotion_stage"] == "capital_blocked"
assert target["capital_promotion_allowed"] is False
assert target["promotion_allowed"] is False
assert target["final_promotion_allowed"] is False
```

- [ ] **Step 2: Run focused tests**

Run:

```bash
cd services/torghut
uv run --frozen pytest tests/materialize_bounded_paper_route_targets/test_commit_dynamic_plan_filters_to_active_target_window_subset.py tests/test_trading_proofs_api.py -q
```

Expected: FAIL on missing canonical fields.

- [ ] **Step 3: Refactor materialization producers**

In `materialization.py`, import:

```python
from app.trading.promotion_authority import (
    capital_blocked_authority,
    source_collection_authority,
)
```

Replace direct false promotion literals in bounded source collection target payloads with:

```python
**source_collection_authority(
    blockers=PAPER_ROUTE_MATERIALIZATION_FINAL_PROMOTION_BLOCKERS,
).as_target_fields(),
```

Replace direct false promotion literals in proof-derived blocked target payloads with:

```python
**capital_blocked_authority(
    blockers=PAPER_ROUTE_MATERIALIZATION_FINAL_PROMOTION_BLOCKERS,
).as_target_fields(),
```

- [ ] **Step 4: Refactor target-plan defaults**

In `target_plan.py`, import:

```python
from app.trading.promotion_authority import capital_blocked_authority
```

Replace:

```python
target.setdefault("promotion_allowed", False)
target.setdefault("final_promotion_allowed", False)
target.setdefault("final_promotion_authorized", False)
```

with:

```python
for key, value in capital_blocked_authority(
    blockers=PAPER_ROUTE_MATERIALIZATION_FINAL_PROMOTION_BLOCKERS,
).as_target_fields().items():
    target.setdefault(key, value)
```

- [ ] **Step 5: Refactor proof targets**

In `proofs/targets.py`, import:

```python
from app.trading.promotion_authority import capital_blocked_authority
```

When building a proof target, add:

```python
target.update(
    capital_blocked_authority(
        blockers=["proof_target_not_runtime_capital_authority"],
    ).as_target_fields()
)
```

- [ ] **Step 6: Run focused tests**

Run:

```bash
cd services/torghut
uv run --frozen pytest tests/materialize_bounded_paper_route_targets/test_commit_dynamic_plan_filters_to_active_target_window_subset.py tests/test_trading_proofs_api.py -q
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add services/torghut/app/trading/paper_route_target_plan_modules/materialization.py services/torghut/app/trading/paper_route_target_plan_modules/target_plan.py services/torghut/app/trading/proofs/targets.py services/torghut/tests/materialize_bounded_paper_route_targets/test_commit_dynamic_plan_filters_to_active_target_window_subset.py services/torghut/tests/test_trading_proofs_api.py
git commit -m "refactor(torghut): canonicalize paper target authority"
```

---

### Task 5: Refactor Scheduler Consumers To Stop Reading Legacy Boolean Soup

**Files:**

- Modify: `services/torghut/app/trading/scheduler/target_plan_helpers_modules/bounded_collection.py`
- Modify: `services/torghut/app/trading/scheduler/source_collection_modules/decision_helpers.py`
- Modify: `services/torghut/app/trading/scheduler/source_collection_modules/decision_lineage.py`
- Modify: `services/torghut/app/trading/scheduler/source_collection_modules/target_plan_fetch.py`
- Modify: `services/torghut/app/trading/scheduler/submission_preparation_modules/quote_routeability.py`
- Test: `services/torghut/tests/simple_pipeline/test_live_bounded_paper_route_probe_contract.py`
- Test: `services/torghut/tests/pipeline/test_trading_pipeline_probe_exits_b.py`

- [ ] **Step 1: Add scheduler invariant tests**

In `test_live_bounded_paper_route_probe_contract.py`, add assertions on the live bounded target:

```python
assert target["promotion_stage"] == "source_collection"
assert target["capital_promotion_allowed"] is False
assert target["bounded_live_paper_collection_authorized"] is True
assert target["promotion_allowed"] is False
assert target["final_promotion_allowed"] is False
```

In `test_trading_pipeline_probe_exits_b.py`, assert exit probe metadata preserves collection-only authority:

```python
assert metadata["promotion_stage"] in {"source_collection", "paper_probation"}
assert metadata["capital_promotion_allowed"] is False
assert metadata["promotion_allowed"] is False
assert metadata["final_promotion_allowed"] is False
```

- [ ] **Step 2: Run focused scheduler tests**

Run:

```bash
cd services/torghut
uv run --frozen pytest tests/simple_pipeline/test_live_bounded_paper_route_probe_contract.py tests/pipeline/test_trading_pipeline_probe_exits_b.py -q
```

Expected: FAIL until scheduler metadata carries canonical fields everywhere.

- [ ] **Step 3: Replace OR-soup bounded collection check**

In `bounded_collection.py`, import:

```python
from app.trading.promotion_authority import target_capital_promotion_allowed
```

Replace:

```python
if (
    _target_truthy(target.get("promotion_allowed"))
    or _target_truthy(target.get("final_promotion_allowed"))
    or _target_truthy(target.get("final_promotion_authorized"))
    or _target_truthy(target.get("capital_promotion_allowed"))
):
    blockers.append("bounded_sim_collection_non_final_state_required")
```

with:

```python
if target_capital_promotion_allowed(target):
    blockers.append("bounded_sim_collection_non_final_state_required")
```

- [ ] **Step 4: Use authority helper in source collection decision metadata**

In `decision_helpers.py`, import:

```python
from app.trading.promotion_authority import source_collection_authority
```

Replace direct false promotion fields in `source_collection_bounded_execution_params` with:

```python
**source_collection_authority(
    blockers=["runtime_ledger_source_collection_pending"],
).as_target_fields(),
```

- [ ] **Step 5: Normalize fetched target plans**

In `target_plan_fetch.py`, import:

```python
from app.trading.promotion_authority import (
    capital_blocked_authority,
    target_capital_promotion_allowed,
)
```

Where target metadata is normalized, add:

```python
if "promotion_stage" not in target:
    target.update(
        capital_blocked_authority(
            blockers=["target_plan_missing_canonical_promotion_authority"],
        ).as_target_fields()
    )
if target_capital_promotion_allowed(target):
    target["promotion_stage"] = "capital_allowed"
```

- [ ] **Step 6: Run focused scheduler tests**

Run:

```bash
cd services/torghut
uv run --frozen pytest tests/simple_pipeline/test_live_bounded_paper_route_probe_contract.py tests/pipeline/test_trading_pipeline_probe_exits_b.py -q
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add services/torghut/app/trading/scheduler/target_plan_helpers_modules/bounded_collection.py services/torghut/app/trading/scheduler/source_collection_modules/decision_helpers.py services/torghut/app/trading/scheduler/source_collection_modules/decision_lineage.py services/torghut/app/trading/scheduler/source_collection_modules/target_plan_fetch.py services/torghut/app/trading/scheduler/submission_preparation_modules/quote_routeability.py services/torghut/tests/simple_pipeline/test_live_bounded_paper_route_probe_contract.py services/torghut/tests/pipeline/test_trading_pipeline_probe_exits_b.py
git commit -m "refactor(torghut): consume canonical promotion authority"
```

---

### Task 6: Refactor Runtime Window Import Blocking Reasons

**Files:**

- Modify: `services/torghut/app/trading/runtime_window_import_modules/common.py`
- Modify: `services/torghut/app/trading/runtime_window_import_modules/persistence_materialization.py`
- Test: `services/torghut/tests/run_empirical_promotion_jobs/test_runtime_window_import_a.py`
- Test: `services/torghut/tests/run_empirical_promotion_jobs/test_runtime_window_import_b.py`
- Test: `services/torghut/tests/run_empirical_promotion_jobs/test_runtime_window_blockers.py`

- [ ] **Step 1: Add blocking reason assertions**

In runtime window import tests, assert collection-only rows produce one clear capital blocker:

```python
assert "capital_promotion_not_allowed" in evidence_blocking_reasons
assert "candidate_board_promotion_not_allowed" not in evidence_blocking_reasons
assert "final_promotion_not_allowed" not in evidence_blocking_reasons
```

For paper probation rows, assert:

```python
assert "paper_probation_evidence_collection_only" in evidence_blocking_reasons
assert "capital_promotion_not_allowed" in evidence_blocking_reasons
```

- [ ] **Step 2: Run runtime import tests**

Run:

```bash
cd services/torghut
uv run --frozen pytest tests/run_empirical_promotion_jobs/test_runtime_window_import_a.py tests/run_empirical_promotion_jobs/test_runtime_window_import_b.py tests/run_empirical_promotion_jobs/test_runtime_window_blockers.py -q
```

Expected: FAIL because legacy false fields currently add multiple blocker names.

- [ ] **Step 3: Refactor evidence blocking reason builder**

In `common.py`, import:

```python
from app.trading.promotion_authority import target_capital_promotion_allowed
```

Replace:

```python
if observation_bool(target_metadata.get("promotion_allowed")) is False:
    reasons.append("candidate_board_promotion_not_allowed")
if observation_bool(target_metadata.get("final_promotion_authorized")) is False:
    reasons.append("final_promotion_not_authorized")
if observation_bool(target_metadata.get("final_promotion_allowed")) is False:
    reasons.append("final_promotion_not_allowed")
```

with:

```python
if not target_capital_promotion_allowed(target_metadata):
    reasons.append("capital_promotion_not_allowed")
```

Keep `paper_probation_evidence_collection_only` because it describes evidence collection mode, not capital authority.

- [ ] **Step 4: Refactor persisted materialization payload**

In `persistence_materialization.py`, import:

```python
from app.trading.promotion_authority import (
    capital_allowed_authority,
    capital_blocked_authority,
)
```

Where `capital_promotion_allowed` is emitted, replace direct field assignment with:

```python
authority = (
    capital_allowed_authority()
    if promotion_allowed
    else capital_blocked_authority(blockers=plan.promotion.promotion_blocking_reasons)
)
payload.update(authority.as_target_fields())
```

- [ ] **Step 5: Run runtime import tests**

Run:

```bash
cd services/torghut
uv run --frozen pytest tests/run_empirical_promotion_jobs/test_runtime_window_import_a.py tests/run_empirical_promotion_jobs/test_runtime_window_import_b.py tests/run_empirical_promotion_jobs/test_runtime_window_blockers.py -q
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add services/torghut/app/trading/runtime_window_import_modules/common.py services/torghut/app/trading/runtime_window_import_modules/persistence_materialization.py services/torghut/tests/run_empirical_promotion_jobs/test_runtime_window_import_a.py services/torghut/tests/run_empirical_promotion_jobs/test_runtime_window_import_b.py services/torghut/tests/run_empirical_promotion_jobs/test_runtime_window_blockers.py
git commit -m "refactor(torghut): simplify runtime import authority blockers"
```

---

### Task 7: Add Static Guard Against Reintroducing Ambiguous Promotion Checks

**Files:**

- Modify: `services/torghut/tests/test_promotion_authority_static_contract.py`

- [ ] **Step 1: Add static contract test**

Create `services/torghut/tests/test_promotion_authority_static_contract.py`:

```python
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]

ALLOWED_LEGACY_PROMOTION_FILES = {
    "app/trading/promotion_authority.py",
}


def test_scheduler_does_not_or_legacy_promotion_booleans() -> None:
    scheduler_root = ROOT / "app" / "trading" / "scheduler"
    offenders: list[str] = []
    for path in scheduler_root.rglob("*.py"):
        text = path.read_text()
        if "promotion_allowed" in text and "final_promotion_allowed" in text:
            if "target_capital_promotion_allowed" not in text:
                offenders.append(str(path.relative_to(ROOT)))

    assert offenders == []


def test_legacy_promotion_projection_is_centralized() -> None:
    offenders: list[str] = []
    for path in (ROOT / "app" / "trading").rglob("*.py"):
        rel = str(path.relative_to(ROOT))
        if rel in ALLOWED_LEGACY_PROMOTION_FILES:
            continue
        text = path.read_text()
        if '"promotion_allowed":' in text or '"final_promotion_allowed":' in text:
            offenders.append(rel)

    assert offenders == []
```

- [ ] **Step 2: Run static test**

Run:

```bash
cd services/torghut
uv run --frozen pytest tests/test_promotion_authority_static_contract.py -q
```

Expected: FAIL until direct literal legacy fields are removed from producers.

- [ ] **Step 3: Remove remaining direct literals**

Run:

```bash
cd services/torghut
rg -n '"promotion_allowed":|"final_promotion_allowed":' app/trading
```

For each production hit outside `app/trading/promotion_authority.py`, replace direct literals with one of:

```python
capital_blocked_authority(blockers=[...]).as_target_fields()
source_collection_authority(blockers=[...]).as_target_fields()
paper_probation_authority(blockers=[...]).as_target_fields()
capital_allowed_authority().as_target_fields()
```

- [ ] **Step 4: Run static test again**

Run:

```bash
cd services/torghut
uv run --frozen pytest tests/test_promotion_authority_static_contract.py -q
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/torghut/app/trading services/torghut/tests/test_promotion_authority_static_contract.py
git commit -m "test(torghut): guard promotion authority compatibility boundary"
```

---

### Task 8: Update API Evidence And Operator Vocabulary

**Files:**

- Modify: `services/torghut/app/trading/revenue_repair_modules/evidence_summaries.py`
- Modify: `services/torghut/app/trading/proofs/targets.py`
- Modify: `docs/torghut/trading/promotion-authority.md`
- Test: `services/torghut/tests/test_trading_proofs_api.py`
- Test: `services/torghut/tests/verify_trading_readiness/test_ready_paper_status_passes_strict_gate.py`

- [ ] **Step 1: Add API assertions**

In proofs/readiness tests, assert payloads expose these operator-facing fields:

```python
assert payload["promotion_stage"] in {
    "source_collection",
    "paper_probation",
    "capital_blocked",
    "capital_allowed",
}
assert isinstance(payload["capital_promotion_allowed"], bool)
assert isinstance(payload["promotion_blockers"], list)
```

- [ ] **Step 2: Update evidence summary payloads**

In `evidence_summaries.py`, replace scattered summary fields with:

```python
"promotion_stage": _text(target.get("promotion_stage")),
"capital_promotion_allowed": _bool(target.get("capital_promotion_allowed")),
"promotion_blockers": _string_items(target.get("promotion_blockers")),
"legacy_promotion_allowed": _bool(target.get("promotion_allowed")),
"legacy_final_promotion_allowed": _bool(target.get("final_promotion_allowed")),
```

- [ ] **Step 3: Add operator doc**

Create `docs/torghut/trading/promotion-authority.md`:

```markdown
# Torghut Promotion Authority

Torghut uses one canonical capital authority boolean: `capital_promotion_allowed`.

`promotion_stage` explains what the target is allowed to do:

- `source_collection`: bounded paper orders may collect missing runtime evidence.
- `paper_probation`: bounded paper orders may validate a candidate after source evidence exists.
- `capital_blocked`: evidence exists, but one or more capital blockers remain.
- `capital_allowed`: all authority checks passed; capital promotion is allowed.

Legacy fields `promotion_allowed`, `final_promotion_allowed`, and
`final_promotion_authorized` are compatibility mirrors of
`capital_promotion_allowed`. New code must not branch on them directly.
```

- [ ] **Step 4: Run API tests**

Run:

```bash
cd services/torghut
uv run --frozen pytest tests/test_trading_proofs_api.py tests/verify_trading_readiness/test_ready_paper_status_passes_strict_gate.py -q
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/torghut/app/trading/revenue_repair_modules/evidence_summaries.py services/torghut/app/trading/proofs/targets.py docs/torghut/trading/promotion-authority.md services/torghut/tests/test_trading_proofs_api.py services/torghut/tests/verify_trading_readiness/test_ready_paper_status_passes_strict_gate.py
git commit -m "docs(torghut): define promotion authority vocabulary"
```

---

### Task 9: Full Validation And PR Rollout

**Files:**

- No new code files; validation only.

- [ ] **Step 1: Run focused promotion authority tests**

Run:

```bash
cd services/torghut
uv run --frozen pytest \
  tests/trading/test_promotion_authority.py \
  tests/test_promotion_authority_static_contract.py \
  tests/submission_council/test_source_collection_candidates.py \
  tests/submission_council/test_paper_probation_import_plan.py \
  tests/simple_pipeline/test_live_bounded_paper_route_probe_contract.py \
  tests/pipeline/test_trading_pipeline_probe_exits_b.py \
  tests/run_empirical_promotion_jobs/test_runtime_window_import_a.py \
  tests/run_empirical_promotion_jobs/test_runtime_window_import_b.py \
  tests/run_empirical_promotion_jobs/test_runtime_window_blockers.py \
  tests/test_trading_proofs_api.py \
  tests/verify_trading_readiness/test_ready_paper_status_passes_strict_gate.py \
  -q
```

Expected: PASS.

- [ ] **Step 2: Run Python static checks**

Run:

```bash
cd services/torghut
uv sync --frozen --extra dev
uv run --frozen ruff format --check app tests
uv run --frozen ruff check app tests
uv run --frozen pyright --project pyrightconfig.json
uv run --frozen pyright --project pyrightconfig.alpha.json
uv run --frozen pyright --project pyrightconfig.scripts.json
```

Expected: all PASS.

- [ ] **Step 3: Run full Torghut CI locally where practical**

Run:

```bash
cd services/torghut
uv run --frozen pytest tests/submission_council tests/simple_pipeline tests/pipeline tests/run_empirical_promotion_jobs tests/verify_trading_readiness -q
```

Expected: PASS.

- [ ] **Step 4: Open PR**

Run:

```bash
git status --short
cp .github/PULL_REQUEST_TEMPLATE.md .codex-pr-torghut-promotion-authority.md
```

Fill `.codex-pr-torghut-promotion-authority.md` with:

```markdown
## Summary

- adds canonical Torghut promotion authority state with `promotion_stage` and `capital_promotion_allowed`
- centralizes legacy `promotion_allowed` / `final_promotion_allowed` compatibility projection
- updates source collection, paper probation, runtime authority, target-plan, and scheduler consumers to use canonical authority semantics

## Testing

- `uv run --frozen pytest ...focused promotion authority suite... -q`
- `uv run --frozen ruff format --check app tests`
- `uv run --frozen ruff check app tests`
- `uv run --frozen pyright --project pyrightconfig.json`
- `uv run --frozen pyright --project pyrightconfig.alpha.json`
- `uv run --frozen pyright --project pyrightconfig.scripts.json`

## Rollout / Risk

- Backward compatible: legacy booleans remain in payloads but are generated in one place.
- Safety invariant: `capital_promotion_allowed` is the only true capital routing authority.
- No direct Alpaca or cluster mutation in this PR.
```

Create PR:

```bash
gh pr create \
  -R proompteng/lab \
  --title "refactor(torghut): canonicalize promotion authority" \
  --body-file .codex-pr-torghut-promotion-authority.md
```

- [ ] **Step 5: Wait for CI and merge**

Run:

```bash
gh pr checks <PR_NUMBER> -R proompteng/lab --watch --interval 10
gh pr merge <PR_NUMBER> --squash -R proompteng/lab
```

Expected: all required checks green before merge.

- [ ] **Step 6: Let CI/CD build and promote**

Watch build:

```bash
gh run list -R proompteng/lab --workflow torghut-build-push.yaml --limit 5
```

After build success, verify registry:

```bash
docker buildx imagetools inspect registry.ide-newton.ts.net/lab/torghut:<TAG> | rg 'Digest:|Platform:'
```

Expected: `linux/amd64` and `linux/arm64`.

- [ ] **Step 7: Live acceptance after GitOps promotion**

After promotion PR merges and Argo rolls out:

```bash
kubectl get ksvc -n torghut torghut -o jsonpath='{.status.latestReadyRevisionName}{"\n"}'
kubectl get pods -n torghut --field-selector=status.phase!=Succeeded
```

Run endpoint readback against the latest ready revision:

```bash
POD=$(kubectl get pod -n torghut -l serving.knative.dev/revision=<LATEST_REVISION> -o jsonpath='{.items[0].metadata.name}')
kubectl exec -i -n torghut "$POD" -c user-container -- python - <<'PY'
import json
import urllib.request

with urllib.request.urlopen("http://127.0.0.1:8181/trading/status", timeout=120) as response:
    data = json.loads(response.read().decode())

gate = data.get("live_submission_gate") or {}
plan = gate.get("runtime_ledger_paper_probation_import_plan") or {}
targets = plan.get("targets") or []
first = targets[0] if targets else {}

print(json.dumps({
    "gate_allowed": gate.get("allowed"),
    "gate_reason": gate.get("reason"),
    "promotion_stage": first.get("promotion_stage"),
    "capital_promotion_allowed": first.get("capital_promotion_allowed"),
    "bounded_live_paper_collection_authorized": first.get("bounded_live_paper_collection_authorized"),
    "legacy_promotion_allowed": first.get("promotion_allowed"),
    "legacy_final_promotion_allowed": first.get("final_promotion_allowed"),
}, indent=2, sort_keys=True))
PY
```

Expected for source collection:

```json
{
  "bounded_live_paper_collection_authorized": true,
  "capital_promotion_allowed": false,
  "legacy_final_promotion_allowed": false,
  "legacy_promotion_allowed": false,
  "promotion_stage": "source_collection"
}
```

---

## Done Criteria

- `promotion_allowed` and `final_promotion_allowed` are compatibility mirrors only.
- New production decisions branch on `capital_promotion_allowed` or `promotion_stage`.
- Bounded source collection remains able to collect strategy evidence.
- Capital promotion remains blocked unless canonical authority says `capital_promotion_allowed=true`.
- Tests prove source collection, paper probation, capital blocked, and capital allowed states.
- Static test prevents future reintroduction of direct legacy boolean literals.
- CI green, image multi-arch, GitOps promotion merged, post-deploy verify passes.

## Self-Review

Spec coverage:

- Removes confusing duplicate authority concepts by introducing canonical `PromotionAuthority`.
- Preserves live safety and backward compatibility.
- Keeps source collection enabled for strategy performance data.
- Includes focused tests, static guard, full validation, and live acceptance.

Placeholder scan:

- No TBD/TODO placeholders.
- Every task has exact files, commands, and expected outcomes.

Type consistency:

- Canonical fields are consistent across tasks: `promotion_stage`, `capital_promotion_allowed`, `promotion_blockers`.
- Legacy fields are consistently projected by `PromotionAuthority.as_target_fields()`.
