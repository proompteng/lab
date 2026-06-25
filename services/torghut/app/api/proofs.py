"""Extracted Torghut API route and support functions."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from app.trading.live_submit_activation import live_submit_activation_status

from . import proofs_configured_collection as _proofs_configured_collection
from . import proofs_external_target_fetch as _proofs_external_target_fetch
from .common import (
    BUILD_VERSION,
    DEFAULT_PAPER_ROUTE_EVIDENCE_TARGET_LIMIT,
    MAX_PAPER_ROUTE_EVIDENCE_TARGET_LIMIT,
    PAPER_ROUTE_BOUNDED_COLLECTION_ACCOUNT_LABEL,
    PAPER_ROUTE_RUNTIME_ACCOUNT_LABEL,
    PAPER_ROUTE_TARGET_PLAN_STALE_SUCCESS_SECONDS,
    PAPER_ROUTE_TARGET_PLAN_SUCCESS_CACHE_LOCK,
    Decimal,
    Depends,
    ExecutionTCAMetric,
    HTTPConnection,
    HTTPException,
    HTTPSConnection,
    JSONResponse,
    Mapping,
    ProofKind,
    ProofWindowSelector,
    Query,
    Sequence,
    Session,
    SessionLocal,
    Strategy,
    TradingScheduler,
    build_proofs_payload,
    cast,
    datetime,
    deepcopy,
    get_session,
    jsonable_encoder,
    load_quant_evidence_status,
    logger,
    select,
    settings,
    shared_mapping_items,
    shared_paper_route_target_plan_from_payload,
    time,
)
from .health_checks import (
    build_api_live_submission_gate_payload,
    build_hypothesis_runtime_payload,
    build_simple_lane_status_payload,
    empirical_jobs_status,
    load_tca_summary,
)
from .health_checks import (
    decimal_or_none as _decimal_or_none,
)
from .proof_floor_payloads import (
    build_profitability_proof_floor_payload as _build_profitability_proof_floor_payload,
)
from .runtime_profitability import aggregate_tca_rows as _aggregate_tca_rows
from .status_helpers import deferred_hypothesis_payload_for_live_submission_gate
from .trading_scheduler_state import get_trading_scheduler
from .vnext_helpers import decimal_to_string as _decimal_to_string
from .vnext_helpers import to_str_map as _to_str_map

_build_hypothesis_runtime_payload = build_hypothesis_runtime_payload
_build_live_submission_gate_payload = build_api_live_submission_gate_payload
_build_simple_lane_status_payload = build_simple_lane_status_payload
_deferred_hypothesis_payload_for_live_submission_gate = (
    deferred_hypothesis_payload_for_live_submission_gate
)
_empirical_jobs_status = empirical_jobs_status
_configured_paper_collection_target_plan = (
    _proofs_configured_collection.configured_paper_collection_target_plan
)
_configured_static_symbol_allowlist = (
    _proofs_configured_collection.configured_static_symbol_allowlist
)
_configured_strategy_paper_collection_symbols = (
    _proofs_configured_collection.configured_strategy_paper_collection_symbols
)
_configured_strategy_paper_collection_targets = (
    _proofs_configured_collection.configured_strategy_paper_collection_targets
)
_fetch_paper_route_target_plan_url_impl = (
    _proofs_external_target_fetch.fetch_paper_route_target_plan_url
)
_load_tca_summary = load_tca_summary
_live_submit_activation_status = live_submit_activation_status
_paper_route_target_plan_url_points_to_self = (
    _proofs_external_target_fetch.paper_route_target_plan_url_points_to_self
)
_strategy_universe_symbol_values = (
    _proofs_configured_collection.strategy_universe_symbol_values
)
router = APIRouter()
_paper_route_target_plan_success_cache: tuple[dict[str, Any], float] | None = None


def _fetch_paper_route_target_plan_url(
    url: str,
    *,
    timeout_seconds: float,
    attempts: int = 1,
    retry_backoff_seconds: float = 0.25,
) -> dict[str, Any]:
    return _fetch_paper_route_target_plan_url_impl(
        url,
        timeout_seconds=timeout_seconds,
        attempts=attempts,
        retry_backoff_seconds=retry_backoff_seconds,
        http_connection_class=HTTPConnection,
        https_connection_class=HTTPSConnection,
    )


def _set_paper_route_target_plan_success_cache(
    cache: tuple[dict[str, Any], float] | None,
) -> None:
    global _paper_route_target_plan_success_cache

    _paper_route_target_plan_success_cache = cache


def _proof_kind_value(kind: str) -> ProofKind:
    if kind.strip() != "runtime_window":
        raise HTTPException(status_code=400, detail="unsupported proof kind")
    return "runtime_window"


def _proof_window_value(window: str) -> ProofWindowSelector:
    normalized = window.strip().lower()
    if normalized == "next":
        return "next"
    if normalized == "latest_closed":
        return "latest_closed"
    return "auto"


def _trading_scheduler_for_proofs() -> TradingScheduler:
    return get_trading_scheduler()


def _build_trading_proofs_payload(
    *,
    kind: ProofKind,
    limit: int,
    window: ProofWindowSelector,
    full_audit: bool,
) -> dict[str, object]:
    scheduler = _trading_scheduler_for_proofs()
    empirical_jobs = _empirical_jobs_status()
    quant_evidence = load_quant_evidence_status(
        account_label=settings.trading_account_label,
    )
    gate_hypothesis_payload = _deferred_hypothesis_payload_for_live_submission_gate()
    with SessionLocal() as session:
        live_submission_gate = _build_live_submission_gate_payload(
            scheduler.state,
            session=session,
            hypothesis_summary=gate_hypothesis_payload,
            empirical_jobs_status=empirical_jobs,
            dspy_runtime_status=cast(
                dict[str, object],
                scheduler.llm_status().get("dspy_runtime", {}),
            ),
            quant_health_status=quant_evidence,
        )
    if not bool(live_submission_gate.get("read_model_unavailable")):
        setattr(scheduler, "_last_live_submission_gate", dict(live_submission_gate))
    live_submission_gate = _merge_external_paper_route_target_plan(
        cast(Mapping[str, Any], live_submission_gate)
    )
    simple_lane_status = _build_simple_lane_status_payload()
    with SessionLocal() as session:
        live_submission_gate = _with_configured_paper_collection_targets(
            cast(Mapping[str, Any], live_submission_gate),
            simple_lane_status=cast(Mapping[str, Any], simple_lane_status),
            session=session,
        )
        route_reacquisition_book = _paper_route_probe_book_from_target_plan(
            live_submission_gate,
            simple_lane_status=simple_lane_status,
            state=scheduler.state,
            session=session,
        )
    if route_reacquisition_book is None:
        with SessionLocal() as session:
            tca_summary = _load_tca_summary(session, scheduler=scheduler)
        market_context_status = scheduler.market_context_status()
        hypothesis_payload, _hypothesis_summary, _dependency_quorum = (
            _build_hypothesis_runtime_payload(
                scheduler,
                tca_summary=tca_summary,
                market_context_status=market_context_status,
            )
        )
        proof_floor = _build_profitability_proof_floor_payload(
            state=scheduler.state,
            torghut_revision=BUILD_VERSION,
            live_submission_gate=live_submission_gate,
            hypothesis_payload=hypothesis_payload,
            empirical_jobs_status=empirical_jobs,
            quant_evidence=quant_evidence,
            market_context_status=market_context_status,
            tca_summary=tca_summary,
            simple_lane_status=simple_lane_status,
        )
        route_reacquisition_book = cast(
            Mapping[str, Any],
            proof_floor.get("route_reacquisition_book") or {},
        )
    with SessionLocal() as session:
        return dict(
            build_proofs_payload(
                session,
                live_submission_gate=cast(Mapping[str, Any], live_submission_gate),
                route_reacquisition_book=route_reacquisition_book,
                kind=kind,
                limit=limit,
                window=window,
                full_audit=full_audit,
                target_account_audit_available=(
                    _paper_route_target_account_audit_available(
                        cast(Mapping[str, Any], live_submission_gate)
                    )
                ),
            )
        )


@router.get("/trading/proofs")
def trading_proofs(
    kind: str = Query(
        "runtime_window",
        pattern="^runtime_window$",
        description="Proof family to return.",
    ),
    limit: int = Query(
        DEFAULT_PAPER_ROUTE_EVIDENCE_TARGET_LIMIT,
        ge=1,
        le=MAX_PAPER_ROUTE_EVIDENCE_TARGET_LIMIT,
        description="Maximum number of proof targets to return.",
    ),
    window: str = Query(
        "auto",
        pattern="^(next|latest_closed|auto)$",
        description="Runtime window selection.",
    ),
    full_audit: bool = Query(
        False,
        description="Run full closed-window source, ledger, and account checks.",
    ),
) -> JSONResponse:
    """Return canonical runtime-window proofs."""

    payload = _build_trading_proofs_payload(
        kind=_proof_kind_value(kind),
        limit=limit,
        window=_proof_window_value(window),
        full_audit=full_audit,
    )
    return JSONResponse(status_code=200, content=jsonable_encoder(payload))


def _mapping_items(value: object) -> list[dict[str, Any]]:
    return shared_mapping_items(value)


def _normalized_paper_route_text(value: object) -> str:
    return str(value or "").strip().upper()


def _paper_route_mapping_targets_sim_account(value: Mapping[str, Any]) -> bool:
    return (
        _normalized_paper_route_text(value.get("account_label"))
        == PAPER_ROUTE_RUNTIME_ACCOUNT_LABEL
        or _normalized_paper_route_text(value.get("target_dsn_env")) == "SIM_DB_DSN"
        or _normalized_paper_route_text(value.get("source_dsn_env")) == "SIM_DB_DSN"
    )


def _paper_route_mapping_targets_configured_collection(
    value: Mapping[str, Any],
) -> bool:
    if _normalized_paper_route_text(value.get("source_kind")) == (
        "CONFIGURED_SIMPLE_LANE_PAPER_DATA_COLLECTION"
    ):
        return True
    if _normalized_paper_route_text(value.get("source")) == (
        "CONFIGURED_SIMPLE_LANE_PAPER_DATA_COLLECTION"
    ):
        return True
    return (
        _normalized_paper_route_text(value.get("source_plan_ref"))
        == "CONFIGURED-SIMPLE-LANE-PAPER-DATA-COLLECTION"
    )


def _paper_route_target_account_audit_available(
    live_submission_gate: Mapping[str, Any],
) -> bool:
    if settings.trading_mode == "paper":
        return True
    if settings.trading_mode != "live":
        return False
    plan = live_submission_gate.get("runtime_ledger_paper_probation_import_plan")
    if not isinstance(plan, Mapping):
        return False
    normalized_plan = cast(Mapping[str, Any], plan)
    if _paper_route_mapping_targets_sim_account(normalized_plan):
        return True
    if _paper_route_mapping_targets_configured_collection(normalized_plan):
        return True
    return any(
        _paper_route_mapping_targets_sim_account(target)
        or _paper_route_mapping_targets_configured_collection(target)
        for target in shared_mapping_items(normalized_plan.get("targets"))
    )


def _paper_route_probe_symbol_values_from_mapping(
    target: Mapping[str, Any],
) -> list[str]:
    symbols: list[str] = []
    for field in (
        "paper_route_probe_symbols",
        "paper_route_probe_raw_target_symbols",
        "symbols",
        "target_symbols",
    ):
        raw_symbols = target.get(field)
        if isinstance(raw_symbols, str):
            values: Sequence[object] = raw_symbols.split(",")
        elif isinstance(raw_symbols, Sequence) and not isinstance(
            raw_symbols,
            (bytes, bytearray),
        ):
            values = cast(Sequence[object], raw_symbols)
        else:
            values = ()
        for item in values:
            symbol = str(item).strip().upper()
            if symbol and symbol not in symbols:
                symbols.append(symbol)
    for field in (
        "paper_route_probe_symbol_actions",
        "symbol_actions",
        "target_symbol_actions",
    ):
        raw_actions = target.get(field)
        if not isinstance(raw_actions, Mapping):
            continue
        for item in cast(Mapping[object, object], raw_actions):
            symbol = str(item).strip().upper()
            if symbol and symbol not in symbols:
                symbols.append(symbol)
    return symbols


def _append_unique_paper_route_symbols(
    symbols: list[str],
    candidates: Sequence[str],
) -> None:
    for symbol in candidates:
        if symbol not in symbols:
            symbols.append(symbol)


def _paper_route_probe_symbol_mappings_from_target(
    target: Mapping[str, Any],
) -> list[Mapping[str, Any]]:
    mappings: list[Mapping[str, Any]] = [target]
    for field in (
        "paper_route_clean_window_baseline_state",
        "clean_window_baseline_state",
    ):
        state = target.get(field)
        if not isinstance(state, Mapping):
            continue
        typed_state = cast(Mapping[str, Any], state)
        mappings.append(typed_state)
        source_audit = typed_state.get("source_audit")
        if isinstance(source_audit, Mapping):
            mappings.append(cast(Mapping[str, Any], source_audit))
    return mappings


def _paper_route_target_plan_probe_symbols(plan: Mapping[str, Any]) -> list[str]:
    symbols: list[str] = []
    for target in _paper_route_target_plan_targets(plan):
        for mapping in _paper_route_probe_symbol_mappings_from_target(target):
            _append_unique_paper_route_symbols(
                symbols,
                _paper_route_probe_symbol_values_from_mapping(mapping),
            )
    return symbols


def _paper_route_target_plan_probe_notional(
    plan: Mapping[str, Any],
    *,
    simple_lane_status: Mapping[str, Any],
) -> str | None:
    candidate_values: list[object] = []
    for target in _paper_route_target_plan_targets(plan):
        candidate_values.extend(
            [
                target.get("paper_route_probe_next_session_max_notional"),
                target.get("bounded_evidence_collection_max_notional"),
                target.get("paper_route_probe_effective_max_notional"),
            ]
        )
    candidate_values.append(simple_lane_status.get("paper_route_probe_max_notional"))
    positive_values = [
        amount
        for value in candidate_values
        if (amount := _decimal_or_none(value)) is not None and amount > 0
    ]
    if not positive_values:
        return None
    return _decimal_to_string(max(positive_values))


def _paper_route_target_plan_truthy(value: object) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, int | float | Decimal):
        return bool(value)
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def _paper_route_source_collection_target_cache_safe(
    target: Mapping[str, Any],
) -> bool:
    source_kind = str(target.get("source_kind") or "").strip()
    handoff = str(target.get("handoff") or "").strip()
    selected_by = str(target.get("selected_by") or "").strip()
    if (
        source_kind != "runtime_ledger_source_collection_candidate"
        and handoff != "runtime_ledger_source_collection_import"
        and selected_by != "runtime_ledger_source_collection"
    ):
        return True

    if not str(target.get("window_start") or "").strip():
        return False
    if not str(target.get("window_end") or "").strip():
        return False
    if str(target.get("runtime_ledger_bucket_ref") or "").strip():
        return True
    return any(
        target.get(key)
        for key in (
            "source_window_ids",
            "runtime_ledger_source_window_ids",
            "trade_decision_ids",
            "execution_ids",
            "execution_order_event_ids",
            "source_offsets",
            "source_refs",
        )
    )


def _paper_route_target_plan_cache_safe_for_live(
    plan: Mapping[str, Any],
) -> bool:
    targets = _paper_route_target_plan_targets(plan)
    if not targets:
        return False
    for key in (
        "promotion_allowed",
        "final_promotion_allowed",
        "final_promotion_authorized",
    ):
        if _paper_route_target_plan_truthy(plan.get(key)):
            return False
    for target in targets:
        target_account = str(
            target.get("account_label") or target.get("source_account_label") or ""
        ).strip()
        if target_account != PAPER_ROUTE_BOUNDED_COLLECTION_ACCOUNT_LABEL:
            return False
        if not _paper_route_source_collection_target_cache_safe(target):
            return False
        for key in (
            "promotion_allowed",
            "final_promotion_allowed",
            "final_promotion_authorized",
        ):
            if _paper_route_target_plan_truthy(target.get(key)):
                return False
    return True


def _paper_route_target_strategy_lookup_names(
    target: Mapping[str, Any],
) -> list[str]:
    names: list[str] = []
    for raw_value in (
        target.get("strategy_lookup_names"),
        target.get("runtime_strategy_name"),
        target.get("strategy_name"),
    ):
        values: Sequence[object]
        if isinstance(raw_value, Sequence) and not isinstance(
            raw_value,
            (str, bytes, bytearray),
        ):
            values = cast(Sequence[object], raw_value)
        else:
            values = (raw_value,)
        for value in values:
            if value is None:
                continue
            name = str(value).strip()
            if name and name not in names:
                names.append(name)
    return names


def _paper_route_probe_symbols_from_target_plan_strategies(
    session: Session,
    targets: Sequence[Mapping[str, Any]],
) -> list[str]:
    lookup_names: list[str] = []
    for target in targets:
        for name in _paper_route_target_strategy_lookup_names(target):
            if name not in lookup_names:
                lookup_names.append(name)
    if not lookup_names:
        return []

    rows = session.execute(
        select(Strategy.name, Strategy.universe_symbols).where(
            Strategy.name.in_(lookup_names)
        )
    ).all()
    universe_by_name = {
        str(name): universe_symbols for name, universe_symbols in rows if name
    }
    symbols: list[str] = []
    for name in lookup_names:
        raw_symbols = universe_by_name.get(name)
        if isinstance(raw_symbols, Sequence) and not isinstance(
            raw_symbols,
            (str, bytes, bytearray),
        ):
            values = cast(Sequence[object], raw_symbols)
        else:
            values = ()
        for raw_symbol in values:
            symbol = str(raw_symbol).strip().upper()
            if symbol and symbol not in symbols:
                symbols.append(symbol)
    return symbols


def _with_configured_paper_collection_targets(
    live_submission_gate: Mapping[str, Any],
    *,
    simple_lane_status: Mapping[str, Any],
    session: Session,
) -> dict[str, Any]:
    payload = dict(live_submission_gate)
    existing_plan = _paper_route_target_plan_from_payload(payload)
    if _paper_route_target_plan_targets(existing_plan):
        return payload

    configured_plan = _configured_paper_collection_target_plan(
        session,
        simple_lane_status=simple_lane_status,
    )
    if not configured_plan:
        return payload

    payload["runtime_ledger_paper_probation_import_plan"] = configured_plan
    payload["paper_route_target_plan_source"] = configured_plan["source"]
    payload["paper_route_target_plan_fallback"] = True
    payload["paper_route_target_plan_fallback_reason"] = (
        "configured_strategy_catalog_paper_collection"
    )
    return payload


def _paper_route_target_plan_eligible_symbols(
    plan: Mapping[str, Any],
    targets: Sequence[Mapping[str, Any]],
    *,
    session: Session | None,
) -> list[str]:
    eligible_symbols = _paper_route_target_plan_probe_symbols(plan)
    if eligible_symbols or session is None:
        return eligible_symbols
    return _paper_route_probe_symbols_from_target_plan_strategies(
        session,
        targets,
    )


def _paper_route_live_submit_activation_blocking_reasons(
    live_submit_activation: Mapping[str, Any],
) -> list[str]:
    if live_submit_activation.get("configured") is not True:
        return ["live_submit_activation_missing"]
    if live_submit_activation.get("valid") is not True:
        return [
            str(
                live_submit_activation.get("reason") or "live_submit_activation_invalid"
            )
        ]
    if live_submit_activation.get("expired") is True:
        return [
            str(
                live_submit_activation.get("reason") or "live_submit_activation_expired"
            )
        ]
    return []


def _paper_route_probe_mode_status(
    simple_lane_status: Mapping[str, Any],
) -> tuple[bool, Mapping[str, Any] | None, list[str]]:
    live_mode_collection_allowed = bool(
        simple_lane_status.get("paper_route_probe_allow_live_mode")
    )
    if settings.trading_mode == "paper":
        return live_mode_collection_allowed, None, []
    if settings.trading_mode == "live" and live_mode_collection_allowed:
        live_submit_activation = cast(
            Mapping[str, Any],
            _live_submit_activation_status(),
        )
        return (
            live_mode_collection_allowed,
            live_submit_activation,
            _paper_route_live_submit_activation_blocking_reasons(
                live_submit_activation
            ),
        )
    if settings.trading_mode == "live":
        return (
            live_mode_collection_allowed,
            None,
            ["live_paper_route_probe_collection_disabled"],
        )
    return live_mode_collection_allowed, None, ["not_paper_mode"]


def _paper_route_probe_book_from_target_plan(
    live_submission_gate: Mapping[str, Any],
    *,
    simple_lane_status: Mapping[str, Any],
    state: object,
    session: Session | None = None,
) -> Mapping[str, Any] | None:
    plan = _paper_route_target_plan_from_payload(live_submission_gate)
    targets = _paper_route_target_plan_targets(plan)
    if not targets:
        return None
    eligible_symbols = _paper_route_target_plan_eligible_symbols(
        plan,
        targets,
        session=session,
    )
    if not eligible_symbols:
        return None
    next_session_max_notional = _paper_route_target_plan_probe_notional(
        plan,
        simple_lane_status=simple_lane_status,
    )
    if next_session_max_notional is None:
        return None

    configured_enabled = bool(simple_lane_status.get("paper_route_probe_enabled"))
    if not configured_enabled:
        return None
    market_session_open = cast(bool | None, getattr(state, "market_session_open", None))
    (
        live_mode_collection_allowed,
        live_submit_activation,
        blocking_reasons,
    ) = _paper_route_probe_mode_status(
        simple_lane_status,
    )
    if market_session_open is not True:
        blocking_reasons.append("market_session_closed")
    active = configured_enabled and market_session_open is True and not blocking_reasons
    effective_max_notional = next_session_max_notional if active else "0"
    active_symbols = eligible_symbols if active else []
    return {
        "schema_version": "torghut.route-reacquisition-book.v1",
        "source": "paper_route_target_plan",
        "state": "repair_only",
        "account_label": settings.trading_account_label,
        "trading_mode": settings.trading_mode,
        "market_session_open": market_session_open,
        "summary": {
            "paper_route_probe_eligible_symbols": eligible_symbols,
            "paper_route_probe_active_symbols": active_symbols,
        },
        "paper_route_probe": {
            "configured_enabled": configured_enabled,
            "active": active,
            "effective_max_notional": effective_max_notional,
            "next_session_max_notional": next_session_max_notional,
            "eligible_symbol_count": len(eligible_symbols),
            "eligible_symbols": eligible_symbols,
            "active_symbols": active_symbols,
            "blocking_reasons": blocking_reasons,
            "capital_authority": "none",
            "live_mode_collection_allowed": live_mode_collection_allowed,
            "live_submit_activation": dict(live_submit_activation or {}),
        },
        "source_refs": {
            "target_plan_source": live_submission_gate.get(
                "paper_route_target_plan_source"
            ),
            "target_plan_target_count": len(targets),
        },
        "rollback_target": {
            "paper_probe_notional_limit": "0",
            "live_submit_enabled": False,
        },
    }


def _paper_route_target_plan_targets(plan: Mapping[str, Any]) -> list[dict[str, Any]]:
    return _mapping_items(plan.get("targets"))


def _paper_route_target_plan_from_payload(payload: Mapping[str, Any]) -> dict[str, Any]:
    return shared_paper_route_target_plan_from_payload(payload)


def _load_external_paper_route_target_plan() -> dict[str, Any]:
    url = str(settings.trading_paper_route_target_plan_url or "").strip()
    if not url:
        return {}
    plan = _fetch_paper_route_target_plan_url(
        url,
        timeout_seconds=settings.trading_paper_route_target_plan_timeout_seconds,
        attempts=3,
        retry_backoff_seconds=0.25,
    )
    load_error = str(plan.get("load_error") or "").strip()
    if load_error:
        cached_plan = _cached_external_paper_route_target_plan_success(load_error)
        if cached_plan:
            logger.warning(
                "Using stale successful paper-route target plan after fetch failure "
                "url=%s error=%s",
                url,
                load_error,
            )
            return cached_plan
        return plan
    if _paper_route_target_plan_targets(plan):
        _remember_external_paper_route_target_plan_success(plan)
    return plan


def _remember_external_paper_route_target_plan_success(
    plan: Mapping[str, Any],
) -> None:
    global _paper_route_target_plan_success_cache

    if not _paper_route_target_plan_targets(plan):
        return
    with PAPER_ROUTE_TARGET_PLAN_SUCCESS_CACHE_LOCK:
        _set_paper_route_target_plan_success_cache((deepcopy(dict(plan)), time.time()))


def _cached_external_paper_route_target_plan_success(
    load_error: str,
) -> dict[str, Any]:
    with PAPER_ROUTE_TARGET_PLAN_SUCCESS_CACHE_LOCK:
        cached = _paper_route_target_plan_success_cache
    if cached is None:
        return {}
    plan, cached_at = cached
    age_seconds = max(time.time() - cached_at, 0.0)
    if age_seconds > PAPER_ROUTE_TARGET_PLAN_STALE_SUCCESS_SECONDS:
        return {}
    cached_plan = deepcopy(plan)
    cached_plan["paper_route_target_plan_cache_status"] = "stale_success"
    cached_plan["paper_route_target_plan_last_load_error"] = load_error
    cached_plan["paper_route_target_plan_stale_success_age_seconds"] = int(age_seconds)
    return cached_plan


def _paper_route_external_plan_unavailable_payload(
    local_plan: Mapping[str, Any],
    load_error: str,
) -> dict[str, object]:
    return {
        "schema_version": local_plan.get("schema_version")
        or "torghut.runtime-ledger-paper-probation-import-plan.v1",
        "target_count": 0,
        "skipped_target_count": len(_paper_route_target_plan_targets(local_plan)),
        "promotion_allowed": False,
        "final_promotion_allowed": False,
        "final_promotion_authorized": False,
        "targets": [],
        "skipped_targets": [
            {
                "reason": "external_paper_route_target_plan_unavailable",
                "missing_or_blocking_fields": [load_error],
            }
        ],
    }


def _paper_route_gate_with_external_load_error(
    gate: dict[str, object],
    *,
    local_plan: Mapping[str, Any],
    load_error: str,
) -> dict[str, object]:
    gate["paper_route_target_plan_error"] = load_error
    if not settings.trading_paper_route_target_plan_url:
        return gate
    if _paper_route_target_plan_cache_safe_for_live(local_plan):
        gate.setdefault(
            "paper_route_target_plan_source",
            "local_runtime_ledger_paper_probation_import_plan",
        )
        gate["paper_route_target_plan_external_source"] = "external_target_plan_url"
        return gate
    gate["runtime_ledger_paper_probation_import_plan"] = (
        _paper_route_external_plan_unavailable_payload(local_plan, load_error)
    )
    gate["paper_route_target_plan_source"] = "external_target_plan_url"
    return gate


def _external_paper_route_target_plan_targets(
    external_plan: Mapping[str, Any],
) -> list[dict[str, Any]]:
    merged_targets: list[dict[str, Any]] = []
    for raw_target in _paper_route_target_plan_targets(external_plan):
        target = dict(raw_target)
        target["paper_route_target_plan_source"] = "external_target_plan_url"
        if target.get("paper_route_probe_symbols"):
            target["paper_route_probe_scope_authority"] = "external_target_plan"
        merged_targets.append(target)
    return merged_targets


def _paper_route_gate_with_external_plan(
    gate: dict[str, object],
    *,
    external_plan: Mapping[str, Any],
) -> dict[str, object]:
    merged_plan = dict(external_plan)
    cache_status = str(
        merged_plan.get("paper_route_target_plan_cache_status") or ""
    ).strip()
    last_load_error = str(
        merged_plan.get("paper_route_target_plan_last_load_error") or ""
    ).strip()
    merged_targets = _external_paper_route_target_plan_targets(external_plan)
    merged_plan["targets"] = merged_targets
    merged_plan["target_count"] = len(merged_targets)
    merged_plan["skipped_target_count"] = int(
        merged_plan.get("skipped_target_count") or 0
    )
    merged_plan["promotion_allowed"] = False
    merged_plan["final_promotion_allowed"] = False
    merged_plan["final_promotion_authorized"] = False
    gate["runtime_ledger_paper_probation_import_plan"] = merged_plan
    gate["paper_route_target_plan_source"] = "external_target_plan_url"
    if cache_status:
        gate["paper_route_target_plan_cache_status"] = cache_status
    if last_load_error:
        gate["paper_route_target_plan_error"] = last_load_error
    return gate


def _merge_external_paper_route_target_plan(
    live_submission_gate: Mapping[str, Any],
) -> dict[str, object]:
    gate = dict(live_submission_gate)
    local_plan = _to_str_map(gate.get("runtime_ledger_paper_probation_import_plan"))
    if (
        _paper_route_target_plan_targets(local_plan)
        and not settings.trading_paper_route_target_plan_url
    ):
        return gate

    external_plan = _load_external_paper_route_target_plan()
    if not external_plan:
        return gate

    load_error = str(external_plan.get("load_error") or "").strip()
    if load_error:
        return _paper_route_gate_with_external_load_error(
            gate,
            local_plan=local_plan,
            load_error=load_error,
        )

    if _paper_route_target_plan_targets(
        local_plan
    ) and not _paper_route_target_plan_targets(external_plan):
        return gate

    if not _paper_route_target_plan_targets(external_plan):
        return gate
    return _paper_route_gate_with_external_plan(gate, external_plan=external_plan)


@router.get("/trading/tca")
def trading_tca(
    symbol: str | None = None,
    strategy_id: str | None = None,
    since: datetime | None = None,
    limit: int = Query(default=200, ge=1, le=500),
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """Return per-order and aggregated transaction cost analytics metrics."""

    stmt = select(ExecutionTCAMetric).order_by(ExecutionTCAMetric.computed_at.desc())
    if symbol:
        stmt = stmt.where(ExecutionTCAMetric.symbol == symbol)
    if strategy_id:
        stmt = stmt.where(ExecutionTCAMetric.strategy_id == strategy_id)
    if since:
        stmt = stmt.where(ExecutionTCAMetric.computed_at >= since)
    rows = session.execute(stmt.limit(limit)).scalars().all()
    scheduler = _trading_scheduler_for_proofs()

    grouped = _aggregate_tca_rows(rows)
    payload_rows = [
        {
            "execution_id": str(row.execution_id),
            "trade_decision_id": str(row.trade_decision_id)
            if row.trade_decision_id
            else None,
            "strategy_id": str(row.strategy_id) if row.strategy_id else None,
            "alpaca_account_label": row.alpaca_account_label,
            "symbol": row.symbol,
            "side": row.side,
            "arrival_price": row.arrival_price,
            "avg_fill_price": row.avg_fill_price,
            "filled_qty": row.filled_qty,
            "signed_qty": row.signed_qty,
            "slippage_bps": row.slippage_bps,
            "shortfall_notional": row.shortfall_notional,
            "churn_qty": row.churn_qty,
            "churn_ratio": row.churn_ratio,
            "computed_at": row.computed_at,
        }
        for row in rows
    ]
    return jsonable_encoder(
        {
            "summary": _load_tca_summary(session, scheduler=scheduler),
            "aggregates": grouped,
            "rows": payload_rows,
        }
    )


__all__ = [
    "_proof_kind_value",
    "_proof_window_value",
    "_trading_scheduler_for_proofs",
    "_build_trading_proofs_payload",
    "trading_proofs",
    "_mapping_items",
    "_normalized_paper_route_text",
    "_paper_route_mapping_targets_sim_account",
    "_paper_route_target_account_audit_available",
    "_paper_route_probe_symbol_values_from_mapping",
    "_paper_route_target_plan_probe_symbols",
    "_paper_route_target_plan_probe_notional",
    "_paper_route_target_plan_truthy",
    "_paper_route_source_collection_target_cache_safe",
    "_paper_route_target_plan_cache_safe_for_live",
    "_paper_route_target_strategy_lookup_names",
    "_paper_route_probe_symbols_from_target_plan_strategies",
    "_strategy_universe_symbol_values",
    "_configured_static_symbol_allowlist",
    "_configured_strategy_paper_collection_symbols",
    "_configured_strategy_paper_collection_targets",
    "_configured_paper_collection_target_plan",
    "_with_configured_paper_collection_targets",
    "_paper_route_probe_book_from_target_plan",
    "_paper_route_target_plan_targets",
    "_paper_route_target_plan_from_payload",
    "_fetch_paper_route_target_plan_url",
    "_paper_route_target_plan_url_points_to_self",
    "_load_external_paper_route_target_plan",
    "_remember_external_paper_route_target_plan_success",
    "_cached_external_paper_route_target_plan_success",
    "_merge_external_paper_route_target_plan",
    "trading_tca",
]
