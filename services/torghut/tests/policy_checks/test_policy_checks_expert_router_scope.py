from __future__ import annotations

from pathlib import Path

from app.trading.autonomy.policy_check.common import (
    PROFITABILITY_STAGE_REQUIRED_CHECKS,
)
from app.trading.autonomy.policy_check.profitability_manifest import (
    _ValidationContext,
    _validate_stage_checks,
)


def _execution_stage_without_expert_router() -> dict[str, object]:
    checks = [
        {"check": check, "status": "pass"}
        for check in PROFITABILITY_STAGE_REQUIRED_CHECKS["execution"]
        if check != "expert_router_registry_present"
    ]
    return {"execution": {"checks": checks}}


def test_profitability_manifest_expert_router_check_respects_target_scope() -> None:
    policy = {
        "promotion_require_expert_router_registry": True,
        "promotion_expert_router_required_targets": ["live"],
    }
    stages = _execution_stage_without_expert_router()
    manifest_path = Path("profitability-stage-manifest-v1.json")

    paper_context = _ValidationContext(reasons=[], reason_details=[])
    _validate_stage_checks(
        paper_context,
        stages,
        manifest_path,
        policy,
        promotion_target="paper",
    )
    assert (
        "profitability_stage_manifest_required_check_missing"
        not in paper_context.reasons
    )

    live_context = _ValidationContext(reasons=[], reason_details=[])
    _validate_stage_checks(
        live_context,
        stages,
        manifest_path,
        policy,
        promotion_target="live",
    )
    assert "profitability_stage_manifest_required_check_missing" in live_context.reasons
    assert any(
        detail.get("check") == "expert_router_registry_present"
        for detail in live_context.reason_details
    )
