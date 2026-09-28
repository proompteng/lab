"""Broker-boundary revalidation for sealed risk-reduction actions."""

from __future__ import annotations

from collections.abc import Mapping
from decimal import Decimal
from typing import cast

from .risk_reduction import (
    RISK_REDUCTION_EVIDENCE_SCHEMA_VERSION,
    BrokerReductionSnapshot,
    OrderSide,
    PositionCloseLeg,
    RiskReductionPermitError,
    SubmitCloseOrderPlan,
    authorize_risk_reduction,
)


def validate_submit_close_order_boundary(
    evidence: Mapping[str, object],
    snapshot: BrokerReductionSnapshot,
    *,
    target_key: str,
) -> None:
    """Re-evaluate one sealed close order against broker state at I/O time."""

    normalized_target = target_key.strip().upper()
    if evidence.get("schema_version") != RISK_REDUCTION_EVIDENCE_SCHEMA_VERSION:
        raise RiskReductionPermitError("risk_reduction_evidence_schema_invalid")
    if evidence.get("target_key") != normalized_target:
        raise RiskReductionPermitError("risk_reduction_target_mismatch")
    raw_action = evidence.get("action")
    if not isinstance(raw_action, Mapping):
        raise RiskReductionPermitError("risk_reduction_action_invalid")
    action = cast(Mapping[str, object], raw_action)
    if action.get("type") != "submit_close_order":
        raise RiskReductionPermitError("risk_reduction_action_invalid")
    raw_leg = action.get("leg")
    if not isinstance(raw_leg, Mapping):
        raise RiskReductionPermitError("risk_reduction_action_invalid")
    leg_payload = cast(Mapping[str, object], raw_leg)
    side = str(leg_payload.get("side") or "").strip().lower()
    if side not in {"buy", "sell"}:
        raise RiskReductionPermitError("risk_reduction_action_invalid")
    try:
        quantity = Decimal(str(leg_payload.get("quantity")))
        limit_price = Decimal(str(action.get("limit_price")))
    except (ArithmeticError, ValueError) as exc:
        raise RiskReductionPermitError("risk_reduction_action_invalid") from exc
    if str(action.get("time_in_force") or "").strip().lower() != "gtc":
        raise RiskReductionPermitError("risk_reduction_action_invalid")
    authorization = authorize_risk_reduction(
        snapshot,
        SubmitCloseOrderPlan(
            leg=PositionCloseLeg(
                symbol=str(leg_payload.get("symbol") or ""),
                side=cast(OrderSide, side),
                quantity=quantity,
            ),
            limit_price=limit_price,
            time_in_force="gtc",
        ),
        now=snapshot.observed_at,
    )
    if (
        authorization.permit.operation != "submit_order"
        or authorization.permit.target_key != normalized_target
    ):
        raise RiskReductionPermitError("risk_reduction_boundary_mismatch")


__all__ = ["validate_submit_close_order_boundary"]
