"""Route reacquisition book for proof-floor repair work."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from hashlib import sha256
import json
from typing import Any, cast

from .route_metadata import route_repair_recommendation
from .route_reacquisition_probe import (
    PaperRouteProbeConfig,
    PaperRouteProbePlan,
    apply_paper_route_probe,
    paper_route_probe_payload,
    paper_route_probe_plan,
)


SCHEMA_VERSION = "torghut.route-reacquisition-book.v1"
ROUTE_REPAIR_AUDIT_RECEIPT_SCHEMA_VERSION = "torghut.route-repair-audit-receipt.v1"


@dataclass(frozen=True)
class RouteReacquisitionSources:
    proof_floor_receipt: Mapping[str, Any]
    tca_dimension: Mapping[str, Any]
    market_context_dimension: Mapping[str, Any]
    quant_dimension: Mapping[str, Any]
    alpha_dimension: Mapping[str, Any]
    tca_source_ref: Mapping[str, Any]
    market_context_source_ref: Mapping[str, Any]
    quant_source_ref: Mapping[str, Any]
    alpha_source_ref: Mapping[str, Any]
    symbol_routes: Mapping[str, Any]
    account_label: str | None
    generated_at: object
    dependency_pass: bool


def _text(value: object, default: str = "") -> str:
    if value is None:
        return default
    normalized = str(value).strip()
    return normalized or default


def _int(value: object, default: int = 0) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str) and value.strip():
        try:
            return int(float(value.strip()))
        except ValueError:
            return default
    return default


def _float(value: object) -> float | None:
    if isinstance(value, bool):
        return float(value)
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str) and value.strip():
        try:
            return float(value.strip())
        except ValueError:
            return None
    return None


def _mapping(value: object) -> Mapping[str, Any]:
    if isinstance(value, Mapping):
        return cast(Mapping[str, Any], value)
    return {}


def _sequence(value: object) -> Sequence[object]:
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return cast(Sequence[object], value)
    return []


def _stable_ref(prefix: str, payload: Mapping[str, object]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return f"{prefix}:{sha256(encoded.encode()).hexdigest()[:20]}"


def _dimension(
    proof_floor_receipt: Mapping[str, Any], dimension_name: str
) -> Mapping[str, Any]:
    for raw_dimension in _sequence(proof_floor_receipt.get("proof_dimensions")):
        dimension = _mapping(raw_dimension)
        if _text(dimension.get("dimension")) == dimension_name:
            return dimension
    return {}


def _source_ref(dimension: Mapping[str, Any]) -> Mapping[str, Any]:
    return _mapping(dimension.get("source_ref"))


def _state_is_pass(dimension: Mapping[str, Any]) -> bool:
    return _text(dimension.get("state")) in {"pass", "informational"}


def _receipt_id(source_ref: Mapping[str, Any], *keys: str) -> str | None:
    for key in keys:
        value = _text(source_ref.get(key))
        if value:
            return value
    return None


def _hypothesis_ids(source_ref: Mapping[str, Any]) -> list[str]:
    ids: list[str] = []
    for key in ("hypothesis_ids", "candidate_ids"):
        for value in _sequence(source_ref.get(key)):
            normalized = _text(value)
            if normalized:
                ids.append(normalized)
    return sorted(set(ids))


def _strings(value: object) -> list[str]:
    values: list[str] = []
    seen: set[str] = set()
    for item in _sequence(value):
        normalized = _text(item)
        if normalized and normalized not in seen:
            values.append(normalized)
            seen.add(normalized)
    return values


def _first_text(*values: object) -> str | None:
    for value in values:
        normalized = _text(value)
        if normalized:
            return normalized
    return None


def _first_sequence_text(source: Mapping[str, Any], *keys: str) -> str | None:
    for key in keys:
        for item in _sequence(source.get(key)):
            normalized = _text(item)
            if normalized:
                return normalized
    return None


def _symbol_reason(symbol_payload: Mapping[str, Any], fallback_reason: str) -> str:
    for key in (
        "reason",
        "reason_code",
        "blocker",
        "blocking_reason",
        "current_blocker",
    ):
        reason = _text(symbol_payload.get(key))
        if reason:
            return reason
    reason_codes = _strings(symbol_payload.get("reason_codes")) or _strings(
        symbol_payload.get("blocking_reasons")
    )
    return reason_codes[0] if reason_codes else fallback_reason


def _source_metadata(
    *,
    proof_floor_receipt: Mapping[str, Any],
    symbol_payload: Mapping[str, Any],
    account_label: str | None,
    symbol: str,
    tca_source_ref: Mapping[str, Any],
    alpha_source_ref: Mapping[str, Any],
) -> dict[str, object]:
    hypothesis_id = _first_text(
        symbol_payload.get("hypothesis_id"),
        symbol_payload.get("hypothesisId"),
        _first_sequence_text(alpha_source_ref, "hypothesis_ids"),
    )
    candidate_id = _first_text(
        symbol_payload.get("candidate_id"),
        symbol_payload.get("candidateId"),
        _first_sequence_text(alpha_source_ref, "candidate_ids"),
    )
    runtime_strategy_id = _first_text(
        symbol_payload.get("runtime_strategy_id"),
        symbol_payload.get("runtimeStrategyId"),
        symbol_payload.get("strategy_id"),
        alpha_source_ref.get("runtime_strategy_id"),
        alpha_source_ref.get("strategy_id"),
        proof_floor_receipt.get("runtime_strategy_id"),
    )
    runtime_strategy_name = _first_text(
        symbol_payload.get("runtime_strategy_name"),
        symbol_payload.get("runtimeStrategyName"),
        symbol_payload.get("strategy_name"),
        alpha_source_ref.get("runtime_strategy_name"),
        alpha_source_ref.get("strategy_name"),
        proof_floor_receipt.get("runtime_strategy_name"),
    )
    source_manifest_ref = _first_text(
        symbol_payload.get("source_manifest_ref"),
        symbol_payload.get("sourceManifestRef"),
        tca_source_ref.get("source_manifest_ref"),
        alpha_source_ref.get("source_manifest_ref"),
        proof_floor_receipt.get("source_manifest_ref"),
    )
    metadata: dict[str, object] = {
        "account_label": account_label,
        "symbol": symbol,
    }
    for key, value in (
        ("hypothesis_id", hypothesis_id),
        ("candidate_id", candidate_id),
        ("runtime_strategy_id", runtime_strategy_id),
        ("runtime_strategy_name", runtime_strategy_name),
        ("source_manifest_ref", source_manifest_ref),
    ):
        if value is not None:
            metadata[key] = value
    for key in ("pair_id", "pair_side", "target_side", "leg_role"):
        value = _text(symbol_payload.get(key))
        if value:
            metadata[key] = value
    return metadata


def _audit_receipt(
    *,
    account_label: str | None,
    symbol: str,
    state: str,
    reason: str,
    repair_recommendation: str,
    source_metadata: Mapping[str, object],
    tca_source_ref: Mapping[str, Any],
    market_context_source_ref: Mapping[str, Any],
    quant_source_ref: Mapping[str, Any],
    alpha_source_ref: Mapping[str, Any],
) -> dict[str, object]:
    payload = {
        "account_label": account_label,
        "symbol": symbol,
        "state": state,
        "reason": reason,
        "source_metadata": dict(source_metadata),
    }
    return {
        "schema_version": ROUTE_REPAIR_AUDIT_RECEIPT_SCHEMA_VERSION,
        "receipt_id": _stable_ref("route-repair-audit-receipt", payload),
        "state": "audit_only",
        "source_metadata": dict(source_metadata),
        "symbol": symbol,
        "account_label": account_label,
        "route_state": state,
        "reason_codes": [reason],
        "repair_recommendation": repair_recommendation,
        "promotion_authority": False,
        "capital_authority": "none",
        "max_notional": "0",
        "requires_runtime_ledger_source_proof": True,
        "source_refs": {
            "execution_tca_ref": _receipt_id(
                tca_source_ref, "receipt_id", "last_receipt_id", "source_ref"
            ),
            "market_context_receipt_id": _receipt_id(
                market_context_source_ref,
                "receipt_id",
                "last_receipt_id",
                "repair_cell_receipt_id",
            ),
            "quant_pipeline_receipt_id": _receipt_id(
                quant_source_ref,
                "receipt_id",
                "last_receipt_id",
                "quant_pipeline_receipt_id",
            ),
            "alpha_hypothesis_ids": _hypothesis_ids(alpha_source_ref),
        },
    }


def _next_action(*, state: str, reason: str) -> str:
    if state == "missing":
        return "create_simulation_probe_before_capital"
    if state == "blocked" and "slippage" in reason:
        return "reduce_execution_slippage_before_route_reentry"
    if state == "blocked":
        return "repair_route_evidence_before_paper_probe"
    if state == "probing":
        if reason == "route_tca_passed_but_dependency_receipts_block_capital":
            return "collect_paper_runtime_ledger_receipts_before_capital"
        return "settle_market_context_quant_and_alpha_receipts_before_paper_probe"
    if state == "routeable":
        return "maintain_route_tca_and_wait_for_capital_gate"
    return "retire_symbol_until_evidence_returns"


def _record_from_symbol(
    *,
    proof_floor_receipt: Mapping[str, Any],
    symbol_payload: Mapping[str, Any],
    account_label: str | None,
    state: str,
    reason: str,
    tca_source_ref: Mapping[str, Any],
    market_context_source_ref: Mapping[str, Any],
    quant_source_ref: Mapping[str, Any],
    alpha_source_ref: Mapping[str, Any],
) -> dict[str, object]:
    symbol = _text(symbol_payload.get("symbol"))
    normalized_reason = _symbol_reason(symbol_payload, reason)
    recommendation = route_repair_recommendation(normalized_reason)
    source_metadata = _source_metadata(
        proof_floor_receipt=proof_floor_receipt,
        symbol_payload=symbol_payload,
        account_label=account_label,
        symbol=symbol,
        tca_source_ref=tca_source_ref,
        alpha_source_ref=alpha_source_ref,
    )
    audit_receipt = _audit_receipt(
        account_label=account_label,
        symbol=symbol,
        state=state,
        reason=normalized_reason,
        repair_recommendation=recommendation,
        source_metadata=source_metadata,
        tca_source_ref=tca_source_ref,
        market_context_source_ref=market_context_source_ref,
        quant_source_ref=quant_source_ref,
        alpha_source_ref=alpha_source_ref,
    )
    filled_execution_count = _int(
        symbol_payload.get("filled_execution_count"),
        _int(symbol_payload.get("order_count")),
    )
    payload: dict[str, object] = {
        "symbol": symbol,
        "account_label": account_label,
        "state": state,
        "reason": normalized_reason,
        "avg_abs_slippage_bps": symbol_payload.get("avg_abs_slippage_bps"),
        "max_abs_slippage_bps": symbol_payload.get("max_abs_slippage_bps"),
        "slippage_guardrail_bps": tca_source_ref.get("slippage_guardrail_bps"),
        "filled_execution_count": filled_execution_count,
        "unsettled_execution_count": _int(
            tca_source_ref.get("unsettled_execution_count")
        ),
        "last_computed_at": symbol_payload.get("last_computed_at"),
        "market_context_receipt_id": _receipt_id(
            market_context_source_ref,
            "receipt_id",
            "last_receipt_id",
            "repair_cell_receipt_id",
        ),
        "quant_pipeline_receipt_id": _receipt_id(
            quant_source_ref,
            "receipt_id",
            "last_receipt_id",
            "quant_pipeline_receipt_id",
        ),
        "hypothesis_ids": _hypothesis_ids(alpha_source_ref),
        "paper_probe_notional_limit": "0",
        "rollback_trigger": normalized_reason,
        "next_repair_action": _next_action(state=state, reason=normalized_reason),
        "repair_recommendation": recommendation,
        "source_metadata": source_metadata,
        "audit_receipt": audit_receipt,
        "audit_receipt_ref": audit_receipt["receipt_id"],
        "promotion_authority": False,
        "capital_authority": "none",
    }
    for key in (
        "avg_realized_shortfall_bps",
        "route_adverse_slippage_bps",
        "route_slippage_basis",
    ):
        value = symbol_payload.get(key)
        if value is not None:
            payload[key] = value
    return payload


def _missing_record(
    *,
    proof_floor_receipt: Mapping[str, Any],
    symbol_payload: Mapping[str, Any],
    account_label: str | None,
    tca_source_ref: Mapping[str, Any],
    market_context_source_ref: Mapping[str, Any],
    quant_source_ref: Mapping[str, Any],
    alpha_source_ref: Mapping[str, Any],
) -> dict[str, object]:
    symbol = _text(symbol_payload.get("symbol"))
    return _record_from_symbol(
        proof_floor_receipt=proof_floor_receipt,
        symbol_payload={
            **dict(symbol_payload),
            "symbol": symbol,
            "order_count": 0,
            "avg_abs_slippage_bps": None,
            "max_abs_slippage_bps": None,
            "last_computed_at": None,
        },
        account_label=account_label,
        state="missing",
        reason="execution_tca_symbol_missing",
        tca_source_ref=tca_source_ref,
        market_context_source_ref=market_context_source_ref,
        quant_source_ref=quant_source_ref,
        alpha_source_ref=alpha_source_ref,
    )


def _repair_candidate_rank(record: Mapping[str, object]) -> tuple[int, float, int, str]:
    state = _text(record.get("state"))
    state_rank = {"blocked": 0, "missing": 1, "retired": 2}.get(state, 3)
    slippage = _float(record.get("avg_abs_slippage_bps"))
    filled = _int(record.get("filled_execution_count"))
    return (
        state_rank,
        slippage if slippage is not None else float("inf"),
        -filled,
        _text(record.get("symbol")),
    )


def _repair_candidate(record: Mapping[str, object], *, rank: int) -> dict[str, object]:
    payload: dict[str, object] = {
        "rank": rank,
        "symbol": _text(record.get("symbol")),
        "state": _text(record.get("state")),
        "reason": _text(record.get("reason")),
        "avg_abs_slippage_bps": record.get("avg_abs_slippage_bps"),
        "slippage_guardrail_bps": record.get("slippage_guardrail_bps"),
        "filled_execution_count": _int(record.get("filled_execution_count")),
        "paper_probe_notional_limit": "0",
        "next_repair_action": _text(record.get("next_repair_action")),
        "repair_recommendation": _text(record.get("repair_recommendation")),
        "audit_receipt_ref": _text(record.get("audit_receipt_ref")),
        "promotion_authority": False,
    }
    for key in (
        "avg_realized_shortfall_bps",
        "route_adverse_slippage_bps",
        "route_slippage_basis",
    ):
        value = record.get(key)
        if value is not None:
            payload[key] = value
    paper_route_probe = _mapping(record.get("paper_route_probe"))
    if paper_route_probe and bool(paper_route_probe.get("eligible")):
        payload["paper_route_probe"] = dict(paper_route_probe)
    return payload


def _route_reacquisition_sources(
    proof_floor_receipt: Mapping[str, Any],
) -> RouteReacquisitionSources:
    tca_dimension = _dimension(proof_floor_receipt, "execution_tca")
    market_context_dimension = _dimension(proof_floor_receipt, "market_context")
    quant_dimension = _dimension(proof_floor_receipt, "quant_ingestion")
    alpha_dimension = _dimension(proof_floor_receipt, "alpha_readiness")
    tca_source_ref = _source_ref(tca_dimension)
    unsettled_count = _int(tca_source_ref.get("unsettled_execution_count"))
    return RouteReacquisitionSources(
        proof_floor_receipt=proof_floor_receipt,
        tca_dimension=tca_dimension,
        market_context_dimension=market_context_dimension,
        quant_dimension=quant_dimension,
        alpha_dimension=alpha_dimension,
        tca_source_ref=tca_source_ref,
        market_context_source_ref=_source_ref(market_context_dimension),
        quant_source_ref=_source_ref(quant_dimension),
        alpha_source_ref=_source_ref(alpha_dimension),
        symbol_routes=_mapping(tca_source_ref.get("symbol_routes")),
        account_label=cast(str | None, proof_floor_receipt.get("account_label")),
        generated_at=proof_floor_receipt.get("generated_at"),
        dependency_pass=(
            _state_is_pass(market_context_dimension)
            and _state_is_pass(quant_dimension)
            and _state_is_pass(alpha_dimension)
            and unsettled_count <= 0
        ),
    )


def _route_record_from_payload(
    *,
    sources: RouteReacquisitionSources,
    symbol_payload: Mapping[str, Any],
    state: str,
    reason: str,
) -> dict[str, object]:
    return _record_from_symbol(
        proof_floor_receipt=sources.proof_floor_receipt,
        symbol_payload=symbol_payload,
        account_label=sources.account_label,
        state=state,
        reason=reason,
        tca_source_ref=sources.tca_source_ref,
        market_context_source_ref=sources.market_context_source_ref,
        quant_source_ref=sources.quant_source_ref,
        alpha_source_ref=sources.alpha_source_ref,
    )


def _routeable_records(sources: RouteReacquisitionSources) -> list[dict[str, object]]:
    records: list[dict[str, object]] = []
    state = "routeable" if sources.dependency_pass else "probing"
    reason = (
        "route_tca_passed"
        if sources.dependency_pass
        else "route_tca_passed_but_dependency_receipts_block_capital"
    )
    for raw_symbol in _sequence(sources.symbol_routes.get("routeable_symbols")):
        symbol_payload = _mapping(raw_symbol)
        if _text(symbol_payload.get("symbol")):
            records.append(
                _route_record_from_payload(
                    sources=sources,
                    symbol_payload=symbol_payload,
                    state=state,
                    reason=reason,
                )
            )
    return records


def _blocked_records(sources: RouteReacquisitionSources) -> list[dict[str, object]]:
    records: list[dict[str, object]] = []
    reason = _text(sources.tca_dimension.get("reason"), "execution_tca_blocked")
    for raw_symbol in _sequence(sources.symbol_routes.get("blocked_symbols")):
        symbol_payload = _mapping(raw_symbol)
        if _text(symbol_payload.get("symbol")):
            records.append(
                _route_record_from_payload(
                    sources=sources,
                    symbol_payload=symbol_payload,
                    state="blocked",
                    reason=reason,
                )
            )
    return records


def _missing_records(sources: RouteReacquisitionSources) -> list[dict[str, object]]:
    records: list[dict[str, object]] = []
    for raw_symbol in _sequence(sources.symbol_routes.get("missing_symbols")):
        symbol_payload = (
            cast(Mapping[str, Any], raw_symbol)
            if isinstance(raw_symbol, Mapping)
            else {"symbol": raw_symbol}
        )
        if _text(symbol_payload.get("symbol")):
            records.append(
                _missing_record(
                    proof_floor_receipt=sources.proof_floor_receipt,
                    symbol_payload=symbol_payload,
                    account_label=sources.account_label,
                    tca_source_ref=sources.tca_source_ref,
                    market_context_source_ref=sources.market_context_source_ref,
                    quant_source_ref=sources.quant_source_ref,
                    alpha_source_ref=sources.alpha_source_ref,
                )
            )
    return records


def _route_reacquisition_records(
    sources: RouteReacquisitionSources,
) -> list[dict[str, object]]:
    return [
        *_routeable_records(sources),
        *_blocked_records(sources),
        *_missing_records(sources),
    ]


def _record_counts(records: Sequence[Mapping[str, object]]) -> dict[str, int]:
    return {
        "routeable": sum(1 for item in records if item["state"] == "routeable"),
        "probing": sum(1 for item in records if item["state"] == "probing"),
        "blocked": sum(1 for item in records if item["state"] == "blocked"),
        "missing": sum(1 for item in records if item["state"] == "missing"),
        "retired": sum(1 for item in records if item["state"] == "retired"),
    }


def _repair_candidates(
    records: Sequence[Mapping[str, object]],
) -> list[dict[str, object]]:
    repair_source_records = sorted(
        (
            record
            for record in records
            if _text(record.get("state")) in {"blocked", "missing"}
        ),
        key=_repair_candidate_rank,
    )
    return [
        _repair_candidate(record, rank=index + 1)
        for index, record in enumerate(repair_source_records)
    ]


def _route_reacquisition_summary(
    *,
    sources: RouteReacquisitionSources,
    records: Sequence[Mapping[str, object]],
    probe_plan: PaperRouteProbePlan,
) -> dict[str, object]:
    counts = _record_counts(records)
    repair_candidates = _repair_candidates(records)
    return {
        "scope_symbols": list(_sequence(sources.symbol_routes.get("scope_symbols"))),
        "scope_symbol_count": _int(sources.symbol_routes.get("scope_symbol_count")),
        "routeable_symbol_count": counts["routeable"],
        "probing_symbol_count": counts["probing"],
        "blocked_symbol_count": counts["blocked"],
        "missing_symbol_count": counts["missing"],
        "retired_symbol_count": counts["retired"],
        "candidate_symbols": [
            _text(item.get("symbol"))
            for item in records
            if _text(item.get("state")) in {"routeable", "probing"}
        ],
        "repair_candidate_count": len(repair_candidates),
        "repair_candidate_symbols": [
            _text(item.get("symbol")) for item in repair_candidates
        ],
        "repair_candidates": repair_candidates,
        "paper_route_probe_eligible_symbols": probe_plan.eligible_symbols,
        "paper_route_probe_active_symbols": probe_plan.active_symbols,
        "expected_unblock_value": (
            counts["blocked"] * 2
            + counts["missing"]
            + counts["probing"] * 3
            + counts["routeable"] * 4
        ),
    }


def _source_refs_payload(
    *,
    sources: RouteReacquisitionSources,
    probe_plan: PaperRouteProbePlan,
) -> dict[str, object]:
    return {
        "proof_floor_generated_at": sources.generated_at,
        "proof_floor_route_state": sources.proof_floor_receipt.get("route_state"),
        "proof_floor_capital_state": sources.proof_floor_receipt.get("capital_state"),
        "execution_tca_reason": sources.tca_dimension.get("reason"),
        "market_context_state": sources.market_context_dimension.get("state"),
        "quant_ingestion_state": sources.quant_dimension.get("state"),
        "alpha_readiness_state": sources.alpha_dimension.get("state"),
        "paper_route_probe_target_symbols": probe_plan.target_symbols,
        "paper_route_probe_target_symbol_source": (
            "bounded_paper_route_collection_target_plan"
            if probe_plan.target_symbols
            else None
        ),
    }


def build_route_reacquisition_book(
    *,
    proof_floor_receipt: Mapping[str, Any],
    trading_mode: str,
    market_session_open: bool | None,
    paper_route_probe_enabled: bool = False,
    paper_route_probe_allow_live_mode: bool = False,
    paper_route_probe_max_notional: object | None = None,
    paper_route_probe_target_symbols: Sequence[object] | None = None,
) -> dict[str, object]:
    """Build a symbol-level route repair book from proof-floor source refs.

    The book is diagnostic and repair-oriented. It never authorizes live submit
    or notional by itself; it makes the next revenue repair explicit.
    """

    sources = _route_reacquisition_sources(proof_floor_receipt)
    records = _route_reacquisition_records(sources)
    probe_config = PaperRouteProbeConfig(
        trading_mode=trading_mode,
        market_session_open=market_session_open,
        enabled=paper_route_probe_enabled,
        allow_live_mode=paper_route_probe_allow_live_mode,
        max_notional=paper_route_probe_max_notional,
        target_symbols=paper_route_probe_target_symbols,
    )
    probe_plan = paper_route_probe_plan(records, probe_config)
    apply_paper_route_probe(
        records,
        config=probe_config,
        plan=probe_plan,
    )
    live_mode = trading_mode == "live"
    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": sources.generated_at,
        "account_label": sources.account_label,
        "trading_mode": trading_mode,
        "market_session_open": market_session_open,
        "state": "repair_only"
        if _text(proof_floor_receipt.get("route_state")) == "repair_only"
        else "candidate",
        "capital_rule": "live_zero_notional_unchanged"
        if live_mode
        else "paper_probe_requires_receipt_chain",
        "promotion_authority": False,
        "authority_semantics": "audit_only_until_source_backed_runtime_ledger_fill_proof",
        "records": records,
        "repair_audit_receipts": [record["audit_receipt"] for record in records],
        "summary": _route_reacquisition_summary(
            sources=sources,
            records=records,
            probe_plan=probe_plan,
        ),
        "paper_route_probe": paper_route_probe_payload(
            config=probe_config,
            plan=probe_plan,
        ),
        "source_refs": _source_refs_payload(sources=sources, probe_plan=probe_plan),
        "rollback_target": {
            "paper_probe_notional_limit": "0",
            "live_submit_enabled": False,
            "promotion_authority": False,
        },
    }


__all__ = ["build_route_reacquisition_book"]
