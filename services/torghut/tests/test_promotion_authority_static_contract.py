from __future__ import annotations

from pathlib import Path


SERVICE_ROOT = Path(__file__).resolve().parents[1]

AUTHORITY_PROJECTION_WRITERS = (
    "app/trading/runtime_authority_verifier_modules/shared_context.py",
    "app/trading/submission_council_modules/import_plan.py",
    "app/trading/submission_council_modules/paper_probation.py",
    "app/trading/paper_route_target_plan_modules/materialization.py",
    "app/trading/paper_route_target_plan_modules/target_plan.py",
    "app/trading/proofs/targets.py",
    "app/trading/scheduler/source_collection_modules/decision_helpers.py",
    "app/trading/scheduler/source_collection_modules/decision_lineage.py",
    "app/trading/scheduler/source_collection_modules/target_plan_fetch.py",
    "app/trading/scheduler/submission_preparation_modules/quote_routeability.py",
    "app/trading/scheduler/paper_route_materialization.py",
    "app/trading/runtime_window_import_modules/persistence_materialization.py",
    "app/trading/completion_modules/effective_row_status.py",
)


def _read(relative_path: str) -> str:
    return (SERVICE_ROOT / relative_path).read_text()


def test_live_target_authority_writers_use_canonical_projection() -> None:
    legacy_markers = (
        '"promotion_allowed":',
        '"final_promotion_allowed":',
        '"final_promotion_authorized":',
    )
    offenders = [
        f"{relative_path}: {marker}"
        for relative_path in AUTHORITY_PROJECTION_WRITERS
        for marker in legacy_markers
        if marker in _read(relative_path)
    ]

    assert offenders == []


def test_bounded_scheduler_uses_canonical_capital_authority() -> None:
    text = _read(
        "app/trading/scheduler/target_plan_helpers_modules/bounded_collection.py"
    )

    assert "target_capital_promotion_allowed(target)" in text
    assert 'target.get("promotion_allowed")' not in text
    assert 'target.get("final_promotion_allowed")' not in text
    assert 'target.get("final_promotion_authorized")' not in text


def test_runtime_import_uses_single_capital_blocker_name() -> None:
    text = _read("app/trading/runtime_window_import_modules/common.py")

    assert '"capital_promotion_not_allowed"' in text
    assert "candidate_board_promotion_not_allowed" not in text
    assert "final_promotion_not_authorized" not in text
    assert "final_promotion_not_allowed" not in text


def test_repair_summary_labels_legacy_booleans_as_compatibility_readback() -> None:
    text = _read("app/trading/revenue_repair_modules/evidence_summaries.py")

    assert (
        '"capital_promotion_allowed": target_capital_promotion_allowed(target)' in text
    )
    assert '"legacy_promotion_allowed": _bool(target.get("promotion_allowed"))' in text
    assert '"legacy_final_promotion_allowed": _bool(' in text
    assert '"legacy_final_promotion_authorized": _bool(' in text
