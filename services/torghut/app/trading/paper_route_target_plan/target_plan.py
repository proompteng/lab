"""Helpers for external paper-route runtime-window target plans."""

from __future__ import annotations

import json
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from http.client import HTTPConnection, HTTPSConnection
from typing import Any, cast
from urllib.parse import SplitResult, urlsplit

from ...config import settings
from ..promotion_authority import capital_blocked_authority


PAPER_ROUTE_MATERIALIZATION_SCHEMA_VERSION = (
    "torghut.paper-route-target-materialization.v1"
)

PAPER_ROUTE_MATERIALIZATION_ACCOUNT_LABEL = "TORGHUT_SIM"

PAPER_ROUTE_MATERIALIZATION_STAGE = "bounded_paper_collection"

PAPER_ROUTE_MATERIALIZATION_SOURCE = "paper_route_target_plan_materializer"

PAPER_ROUTE_MATERIALIZATION_FINAL_PROMOTION_BLOCKERS = (
    "paper_route_bounded_collection_only",
    "runtime_ledger_live_or_live_paper_required",
    "paper_route_runtime_ledger_import_pending",
)

PAPER_ROUTE_MATERIALIZATION_HPAIRS_HYPOTHESIS_ID = "H-PAIRS-01"

PAPER_ROUTE_TARGET_NOTIONAL_SOURCE_DECISION_SEED_QTY = Decimal("1")

CONFIGURED_SIMPLE_LANE_PAPER_COLLECTION_SOURCE_KIND = (
    "configured_simple_lane_paper_data_collection"
)


@dataclass(frozen=True)
class PaperRouteTargetPlanFetchClient:
    http_connection: type[HTTPConnection] = HTTPConnection
    https_connection: type[HTTPSConnection] = HTTPSConnection


def _to_str_map(value: object) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {}
    return {str(key): item for key, item in cast(Mapping[object, Any], value).items()}


def mapping_items(value: object) -> list[dict[str, Any]]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        return []
    return [
        _to_str_map(cast(object, item))
        for item in cast(Sequence[object], value)
        if isinstance(item, Mapping)
    ]


def paper_route_target_plan_targets(plan: Mapping[str, Any]) -> list[dict[str, Any]]:
    return mapping_items(plan.get("targets"))


def _target_plan_from_proofs_payload(payload: Mapping[str, Any]) -> dict[str, Any]:
    if str(payload.get("schema_version") or "").strip() != "torghut.proofs.v1":
        return {}
    targets: list[dict[str, Any]] = []
    for proof in mapping_items(payload.get("proofs")):
        target = _target_from_proof_identity(proof)
        if not target:
            continue
        for key, value in (
            capital_blocked_authority(
                blockers=PAPER_ROUTE_MATERIALIZATION_FINAL_PROMOTION_BLOCKERS,
            )
            .as_target_fields()
            .items()
        ):
            target.setdefault(key, value)
        targets.append(target)
    if not targets:
        return {}
    return {
        "schema_version": "torghut.paper-route-target-plan.v1",
        "source": "trading_proofs_endpoint",
        "purpose": "runtime_window_proof_target_materialization",
        **capital_blocked_authority(
            blockers=PAPER_ROUTE_MATERIALIZATION_FINAL_PROMOTION_BLOCKERS,
        ).as_target_fields(),
        "target_count": len(targets),
        "targets": targets,
    }


def _target_from_proof_identity(proof: Mapping[str, Any]) -> dict[str, Any]:
    identity = _to_str_map(proof.get("identity"))
    window = _to_str_map(proof.get("window"))
    if not identity:
        return {}
    account_state = _to_str_map(proof.get("account_state"))
    account_blockers = _text_items(account_state.get("blockers"))
    clean_baseline = account_state.get("clean_baseline")
    baseline_clean = clean_baseline is not False and not account_blockers
    raw_symbols = proof.get("symbols")
    if isinstance(raw_symbols, str):
        symbol_values: Sequence[object] = raw_symbols.split(",")
    elif isinstance(raw_symbols, Sequence) and not isinstance(
        raw_symbols, (bytes, bytearray)
    ):
        symbol_values = cast(Sequence[object], raw_symbols)
    else:
        symbol_values = ()
    symbols = [str(item).strip().upper() for item in symbol_values if str(item).strip()]
    actions = _to_str_map(identity.get("target_symbol_actions"))
    if (
        not actions
        and _safe_text(identity.get("source_kind"))
        == CONFIGURED_SIMPLE_LANE_PAPER_COLLECTION_SOURCE_KIND
    ):
        actions = {symbol: "buy" for symbol in symbols}
    quantities = _to_str_map(identity.get("target_symbol_quantities"))
    return {
        "hypothesis_id": identity.get("hypothesis_id"),
        "candidate_id": identity.get("candidate_id"),
        "strategy_family": identity.get("strategy_family"),
        "strategy_name": identity.get("strategy_name")
        or identity.get("runtime_strategy_name"),
        "runtime_strategy_name": identity.get("runtime_strategy_name")
        or identity.get("strategy_name"),
        "account_label": identity.get("account_label"),
        "source_account_label": identity.get("source_account_label"),
        "observed_stage": identity.get("observed_stage") or "paper",
        "source_kind": identity.get("source_kind"),
        "source_plan_ref": identity.get("source_plan_ref"),
        "target_notional": identity.get("target_notional"),
        "source_decision_mode": identity.get("source_decision_mode"),
        "target_symbol_actions": actions,
        "target_symbol_quantities": quantities,
        "proof_target_authority": "trading_proofs",
        "bounded_collection_stage": "paper",
        "evidence_collection_stage": "paper",
        "bounded_evidence_collection_authorized": True,
        "evidence_collection_ok": True,
        "source_decision_readiness": {
            "schema_version": "torghut.proofs-source-decision-readiness.v1",
            "ready": True,
            "blockers": [],
            "strategy_lookup_names": [
                item
                for item in (
                    identity.get("runtime_strategy_name"),
                    identity.get("strategy_name"),
                )
                if _safe_text(item)
            ],
        },
        "paper_route_clean_window_state": "clean_window_collection_ready"
        if baseline_clean
        else "blocked",
        "paper_route_clean_window_baseline_state": {
            "state": "clean" if baseline_clean else "blocked",
            "blockers": account_blockers,
        },
        "paper_route_clean_window_baseline_blockers": account_blockers,
        "window_start": window.get("start"),
        "window_end": window.get("end"),
        "paper_route_probe_symbols": symbols,
        "symbols": symbols,
        "paper_route_probe_symbol_actions": actions,
        "paper_route_probe_symbol_quantities": quantities,
    }


def _probe_symbol_values_from_mapping(payload: Mapping[str, Any]) -> set[str]:
    symbols: set[str] = set()
    for field in (
        "paper_route_probe_symbols",
        "paper_route_probe_raw_target_symbols",
        "symbols",
        "target_symbols",
    ):
        raw_symbols = payload.get(field)
        if isinstance(raw_symbols, str):
            values: Sequence[object] = raw_symbols.split(",")
        elif isinstance(raw_symbols, Sequence) and not isinstance(
            raw_symbols, (bytes, bytearray)
        ):
            values = cast(Sequence[object], raw_symbols)
        else:
            values = ()
        for raw_symbol in values:
            symbol = str(raw_symbol).strip().upper()
            if symbol:
                symbols.add(symbol)

    for field in (
        "paper_route_probe_symbol_actions",
        "symbol_actions",
        "target_symbol_actions",
    ):
        raw_actions = payload.get(field)
        if not isinstance(raw_actions, Mapping):
            continue
        for raw_symbol in cast(Mapping[object, object], raw_actions):
            symbol = str(raw_symbol).strip().upper()
            if symbol:
                symbols.add(symbol)
    return symbols


def _target_probe_symbol_values(target: Mapping[str, Any]) -> set[str]:
    symbols = _probe_symbol_values_from_mapping(target)
    for field in (
        "paper_route_clean_window_baseline_state",
        "clean_window_baseline_state",
    ):
        state = _to_str_map(target.get(field))
        if not state:
            continue
        symbols.update(_probe_symbol_values_from_mapping(state))
        source_audit = _to_str_map(state.get("source_audit"))
        if source_audit:
            symbols.update(_probe_symbol_values_from_mapping(source_audit))
    return symbols


def _target_source_decision_ready(target: Mapping[str, Any]) -> bool:
    readiness = target.get("source_decision_readiness")
    if not isinstance(readiness, Mapping):
        return False
    value = cast(Mapping[object, object], readiness).get("ready")
    if isinstance(value, bool):
        return value
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def _target_identity_value(target: Mapping[str, Any], field: str) -> str:
    return str(target.get(field) or "").strip()


def _target_identity_keys(target: Mapping[str, Any]) -> set[tuple[str, str]]:
    candidate_id = _target_identity_value(target, "candidate_id")
    if candidate_id:
        return {("candidate_id", candidate_id)}

    source_plan_ref = _target_identity_value(target, "source_plan_ref")
    if source_plan_ref:
        return {("source_plan_ref", source_plan_ref)}

    hypothesis_id = _target_identity_value(target, "hypothesis_id")
    strategy_name = _target_identity_value(
        target,
        "runtime_strategy_name",
    ) or _target_identity_value(target, "strategy_name")
    if hypothesis_id and strategy_name:
        return {("hypothesis_strategy", f"{hypothesis_id}:{strategy_name}")}
    if hypothesis_id:
        return {("hypothesis_id", hypothesis_id)}
    if strategy_name:
        return {("strategy_name", strategy_name)}
    return set()


def _target_plan_selected_identity_match(
    plan: Mapping[str, Any],
    *,
    selected_identity_keys: set[tuple[str, str]],
) -> bool:
    if not selected_identity_keys:
        return True
    return any(
        bool(_target_identity_keys(target) & selected_identity_keys)
        for target in paper_route_target_plan_targets(plan)
    )


def _source_collection_marker(value: object) -> bool:
    text = str(value or "").strip().lower()
    return "source_collection" in text or "source-window" in text


def _target_plan_is_source_collection_only(plan: Mapping[str, Any]) -> bool:
    if _source_collection_marker(plan.get("purpose")) or _source_collection_marker(
        plan.get("source")
    ):
        return True
    targets = paper_route_target_plan_targets(plan)
    if not targets:
        return False
    return all(
        _source_collection_marker(target.get("source_kind"))
        or _source_collection_marker(target.get("handoff"))
        or _source_collection_marker(target.get("selected_by"))
        or _source_collection_marker(
            target.get("source_collection_authorization_scope")
        )
        for target in targets
    )


def _target_plan_selection_score(
    plan: Mapping[str, Any],
    *,
    source_rank: int,
    selected_identity_keys: set[tuple[str, str]],
) -> tuple[int, int, int, int, int, int, int]:
    targets = paper_route_target_plan_targets(plan)
    if not targets:
        return (-1, 0, 0, 0, 0, 0, -source_rank)
    probe_symbol_count = sum(
        len(_target_probe_symbol_values(target)) for target in targets
    )
    ready_count = sum(1 for target in targets if _target_source_decision_ready(target))
    return (
        0 if _target_plan_is_source_collection_only(plan) else 1,
        1
        if _target_plan_selected_identity_match(
            plan,
            selected_identity_keys=selected_identity_keys,
        )
        else 0,
        1 if probe_symbol_count else 0,
        ready_count,
        probe_symbol_count,
        len(targets),
        -source_rank,
    )


def paper_route_target_plan_from_payload(payload: Mapping[str, Any]) -> dict[str, Any]:
    proofs_target_plan = _target_plan_from_proofs_payload(payload)
    if proofs_target_plan:
        return proofs_target_plan

    live_gate = _to_str_map(payload.get("live_submission_gate"))
    top_level_target_plan = (
        dict(payload)
        if str(payload.get("schema_version") or "").strip()
        == "torghut.paper-route-target-plan.v1"
        and paper_route_target_plan_targets(payload)
        else {}
    )
    next_clean_after_discard_plan = _to_str_map(
        payload.get("next_clean_paper_route_runtime_window_targets_after_discard")
    )
    observed_strategy_source_plan = _to_str_map(
        payload.get("observed_strategy_source_runtime_window_import_plan")
    )
    runtime_window_plan = _to_str_map(payload.get("runtime_window_import_plan"))
    source_runtime_window_plan = _to_str_map(
        payload.get("source_runtime_window_import_plan")
    )
    next_paper_route_plan = _to_str_map(
        payload.get("next_paper_route_runtime_window_targets")
    )
    selected_identity_keys = {
        key
        for target in paper_route_target_plan_targets(top_level_target_plan)
        for key in _target_identity_keys(target)
    }
    candidate_plans = [
        top_level_target_plan,
        next_clean_after_discard_plan,
        observed_strategy_source_plan,
        next_paper_route_plan,
        source_runtime_window_plan,
        runtime_window_plan,
        _to_str_map(live_gate.get("runtime_ledger_paper_probation_import_plan")),
        _to_str_map(payload.get("runtime_ledger_paper_probation_import_plan")),
        dict(payload) if paper_route_target_plan_targets(payload) else {},
    ]
    scored_plans = [
        (
            _target_plan_selection_score(
                plan,
                source_rank=source_rank,
                selected_identity_keys=selected_identity_keys,
            ),
            plan,
        )
        for source_rank, plan in enumerate(candidate_plans)
        if paper_route_target_plan_targets(plan)
    ]
    if not scored_plans:
        return {}
    return dict(max(scored_plans, key=lambda item: item[0])[1])


def fetch_paper_route_target_plan_url(
    url: str,
    *,
    timeout_seconds: float,
    attempts: int = 1,
    retry_backoff_seconds: float = 0.25,
    fetch_client: PaperRouteTargetPlanFetchClient | None = None,
) -> dict[str, Any]:
    max_attempts = max(int(attempts), 1)
    client = fetch_client or PaperRouteTargetPlanFetchClient()
    result: dict[str, Any] = {}
    for attempt in range(1, max_attempts + 1):
        result = _fetch_paper_route_target_plan_url_once(
            url,
            timeout_seconds=timeout_seconds,
            fetch_client=client,
        )
        if not str(result.get("load_error") or "").strip():
            if attempt > 1:
                result = dict(result)
                result["fetch_attempts"] = attempt
            return result
        if attempt < max_attempts:
            time.sleep(max(float(retry_backoff_seconds), 0.0))

    if max_attempts > 1:
        result = dict(result)
        result["fetch_attempts"] = max_attempts
    return result


def _fetch_paper_route_target_plan_url_once(
    url: str,
    *,
    timeout_seconds: float,
    fetch_client: PaperRouteTargetPlanFetchClient,
) -> dict[str, Any]:
    parsed, load_error = _parse_paper_route_target_plan_url(url)
    if load_error is not None:
        return {"load_error": load_error}

    raw, load_error = _read_paper_route_target_plan_url(
        parsed,
        timeout_seconds=timeout_seconds,
        fetch_client=fetch_client,
    )
    if load_error is not None:
        return {"load_error": load_error}

    payload, load_error = _decode_paper_route_target_plan_payload(raw)
    if load_error is not None:
        return {"load_error": load_error}

    plan = paper_route_target_plan_from_payload(payload)
    if not plan:
        return {"load_error": "paper_route_target_plan_missing"}

    plan = dict(plan)
    plan.setdefault("source", "external_paper_route_target_plan")
    return plan


def _parse_paper_route_target_plan_url(url: str) -> tuple[SplitResult, str | None]:
    parsed = urlsplit(url)
    scheme = parsed.scheme.lower()
    if scheme not in {"http", "https"}:
        return parsed, f"paper_route_target_plan_invalid_scheme:{scheme or 'missing'}"
    if not parsed.hostname:
        return parsed, "paper_route_target_plan_invalid_host"
    return parsed, None


def _read_paper_route_target_plan_url(
    parsed: SplitResult,
    *,
    timeout_seconds: float,
    fetch_client: PaperRouteTargetPlanFetchClient,
) -> tuple[bytes, str | None]:
    hostname = parsed.hostname
    if hostname is None:
        return b"", "paper_route_target_plan_invalid_host"

    path = parsed.path or "/"
    if parsed.query:
        path = f"{path}?{parsed.query}"
    connection_class = (
        fetch_client.https_connection
        if parsed.scheme.lower() == "https"
        else fetch_client.http_connection
    )
    connection = connection_class(
        hostname,
        parsed.port,
        timeout=max(float(timeout_seconds), 0.1),
    )
    try:
        host_header = parsed.netloc or hostname
        connection.request(
            "GET",
            path,
            headers={
                "Accept": "application/json",
                "Connection": "close",
                "Host": host_header,
            },
        )
        response = connection.getresponse()
        if response.status < 200 or response.status >= 300:
            return b"", f"paper_route_target_plan_http_status:{response.status}"
        raw = response.read(5_000_001)
    except Exception as exc:  # pragma: no cover - depends on network
        return b"", f"paper_route_target_plan_fetch_failed:{exc}"
    finally:
        connection.close()

    if len(raw) > 5_000_000:
        return b"", "paper_route_target_plan_response_too_large"
    return raw, None


def _decode_paper_route_target_plan_payload(
    raw: bytes,
) -> tuple[Mapping[str, Any], str | None]:
    try:
        payload = json.loads(raw.decode("utf-8"))
    except Exception as exc:
        return {}, f"paper_route_target_plan_invalid_json:{exc}"
    if not isinstance(payload, Mapping):
        return {}, "paper_route_target_plan_invalid_payload"
    return cast(Mapping[str, Any], payload), None


def paper_route_target_plan_probe_symbols(plan: Mapping[str, Any]) -> set[str]:
    symbols: set[str] = set()
    for target in paper_route_target_plan_targets(plan):
        symbols.update(_target_probe_symbol_values(target))
    return symbols


def _safe_text(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _safe_decimal(value: object) -> Decimal:
    if value is None:
        return Decimal("0")
    try:
        return Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return Decimal("0")


def _decimal_text(value: Decimal) -> str:
    return format(value, "f")


def _positive_decimal_from_fields(
    payload: Mapping[str, Any],
    fields: Sequence[str],
) -> Decimal:
    for field in fields:
        value = _safe_decimal(payload.get(field))
        if value > 0:
            return value
    return Decimal("0")


def _text_items(value: object) -> list[str]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        return []
    return [
        str(item).strip() for item in cast(Sequence[object], value) if str(item).strip()
    ]


def _truthy(value: object) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, int | float | Decimal):
        return bool(value)
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def _target_symbol_actions(target: Mapping[str, Any]) -> dict[str, str]:
    raw_actions = _to_str_map(target.get("paper_route_probe_symbol_actions"))
    actions: dict[str, str] = {}
    for raw_symbol, raw_action in raw_actions.items():
        symbol = str(raw_symbol).strip().upper()
        action = str(raw_action).strip().lower()
        if symbol and action in {"buy", "sell"}:
            actions[symbol] = action
    return actions


def _target_symbol_quantities(target: Mapping[str, Any]) -> dict[str, Decimal]:
    quantities: dict[str, Decimal] = {}
    for field in (
        "paper_route_probe_symbol_quantities",
        "target_symbol_quantities",
        "symbol_quantities",
    ):
        raw_quantities = _to_str_map(target.get(field))
        for raw_symbol, raw_quantity in raw_quantities.items():
            symbol = str(raw_symbol).strip().upper()
            quantity = _safe_decimal(raw_quantity)
            if symbol and quantity > 0:
                quantities[symbol] = quantity
    fallback_quantity = _positive_decimal_from_fields(
        target,
        (
            "target_quantity",
            "paper_route_probe_target_quantity",
            "qty",
            "quantity",
        ),
    )
    if fallback_quantity > 0:
        for symbol in _target_symbol_actions(target):
            quantities.setdefault(symbol, fallback_quantity)
    return quantities


def _target_source_decision_quantities(
    target: Mapping[str, Any],
) -> dict[str, Decimal]:
    quantities = _target_symbol_quantities(target)
    if quantities:
        return quantities
    if _target_notional(target) <= 0:
        return {}
    return {
        symbol: PAPER_ROUTE_TARGET_NOTIONAL_SOURCE_DECISION_SEED_QTY
        for symbol in _target_symbol_actions(target)
    }


def _target_notional(target: Mapping[str, Any]) -> Decimal:
    return _positive_decimal_from_fields(
        target,
        (
            "target_notional",
            "paper_route_probe_target_notional",
            "paper_route_probe_effective_max_notional",
            "bounded_evidence_collection_max_notional",
            "paper_route_probe_next_session_max_notional",
            "max_notional",
        ),
    )


def _target_quantity(target: Mapping[str, Any]) -> Decimal:
    explicit_quantity = _positive_decimal_from_fields(
        target,
        (
            "target_quantity",
            "paper_route_probe_target_quantity",
            "qty",
            "quantity",
        ),
    )
    if explicit_quantity > 0:
        return explicit_quantity
    return sum(_target_symbol_quantities(target).values(), Decimal("0"))


def _configured_bounded_collection_limit(
    *,
    bounded_notional_limit: Decimal | int | float | str | None,
) -> Decimal:
    if bounded_notional_limit is not None:
        return _safe_decimal(bounded_notional_limit)
    return _safe_decimal(settings.trading_simple_paper_route_probe_max_notional)


def _clean_window_baseline_blockers(target: Mapping[str, Any]) -> list[str]:
    state = _to_str_map(target.get("paper_route_clean_window_baseline_state"))
    blockers = _text_items(target.get("paper_route_clean_window_baseline_blockers"))
    if not blockers:
        blockers = _text_items(state.get("blockers"))
    baseline_state = _safe_text(state.get("state"))
    if baseline_state != "clean":
        blockers.append("paper_route_clean_window_baseline_missing_or_dirty")
    if _safe_text(target.get("paper_route_clean_window_state")) not in {
        "clean_window_collection_ready",
        "clean",
    }:
        blockers.append("paper_route_clean_window_gate_not_passed")
    return sorted(dict.fromkeys(blockers))


def _target_identity(
    target: Mapping[str, Any],
    *,
    target_index: int,
) -> dict[str, Any]:
    source_plan_ref = (
        _safe_text(target.get("source_plan_ref"))
        or _safe_text(target.get("source_plan_id"))
        or _safe_text(target.get("source_manifest_ref"))
        or _safe_text(target.get("paper_route_target_plan_source"))
    )
    bounded_collection_stage = (
        _safe_text(target.get("bounded_collection_stage"))
        or _safe_text(target.get("evidence_collection_stage"))
        or _safe_text(target.get("observed_stage"))
    )
    return {
        "schema_version": "torghut.paper-route-target-identity.v1",
        "target_index": target_index,
        "hypothesis_id": _safe_text(target.get("hypothesis_id")),
        "candidate_id": _safe_text(target.get("candidate_id")),
        "runtime_strategy_name": _safe_text(target.get("runtime_strategy_name"))
        or _safe_text(target.get("strategy_name")),
        "strategy_name": _safe_text(target.get("strategy_name")),
        "strategy_id": _safe_text(target.get("strategy_id")),
        "account_label": _safe_text(target.get("account_label")),
        "source_account_label": _safe_text(target.get("source_account_label")),
        "source_plan_ref": source_plan_ref,
        "source_manifest_ref": _safe_text(target.get("source_manifest_ref")),
        "target_notional": _decimal_text(_target_notional(target)),
        "target_quantity": _decimal_text(_target_quantity(target)),
        "target_symbol_quantities": {
            symbol: _decimal_text(quantity)
            for symbol, quantity in sorted(_target_symbol_quantities(target).items())
        },
        "bounded_collection_stage": bounded_collection_stage,
        "window_start": _safe_text(target.get("window_start"))
        or _safe_text(target.get("paper_route_probe_window_start")),
        "window_end": _safe_text(target.get("window_end"))
        or _safe_text(target.get("paper_route_probe_window_end")),
        "source_kind": _safe_text(target.get("source_kind")),
        "paper_route_probe_symbols": sorted(_target_symbol_actions(target)),
    }


clean_window_baseline_blockers = _clean_window_baseline_blockers
configured_bounded_collection_limit = _configured_bounded_collection_limit
decimal_text = _decimal_text
safe_decimal = _safe_decimal
safe_text = _safe_text
target_identity = _target_identity
target_identity_keys = _target_identity_keys
target_notional = _target_notional
target_plan_selection_score = _target_plan_selection_score
target_source_decision_quantities = _target_source_decision_quantities
target_source_decision_ready = _target_source_decision_ready
target_symbol_actions = _target_symbol_actions
target_symbol_quantities = _target_symbol_quantities
text_items = _text_items
to_str_map = _to_str_map
truthy = _truthy


__all__ = [
    "PAPER_ROUTE_MATERIALIZATION_ACCOUNT_LABEL",
    "PAPER_ROUTE_MATERIALIZATION_FINAL_PROMOTION_BLOCKERS",
    "PAPER_ROUTE_MATERIALIZATION_HPAIRS_HYPOTHESIS_ID",
    "PAPER_ROUTE_MATERIALIZATION_SCHEMA_VERSION",
    "PAPER_ROUTE_MATERIALIZATION_SOURCE",
    "PAPER_ROUTE_MATERIALIZATION_STAGE",
    "PAPER_ROUTE_TARGET_NOTIONAL_SOURCE_DECISION_SEED_QTY",
    "PaperRouteTargetPlanFetchClient",
    "clean_window_baseline_blockers",
    "configured_bounded_collection_limit",
    "decimal_text",
    "fetch_paper_route_target_plan_url",
    "mapping_items",
    "paper_route_target_plan_from_payload",
    "paper_route_target_plan_probe_symbols",
    "paper_route_target_plan_targets",
    "safe_decimal",
    "safe_text",
    "target_identity",
    "target_identity_keys",
    "target_notional",
    "target_plan_selection_score",
    "target_source_decision_quantities",
    "target_source_decision_ready",
    "target_symbol_actions",
    "target_symbol_quantities",
    "text_items",
    "to_str_map",
    "truthy",
]
