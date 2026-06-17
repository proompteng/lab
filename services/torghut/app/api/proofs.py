"""Extracted Torghut API route and support functions."""

# pyright: reportUnusedImport=false
# ruff: noqa: F401,F403,F405
from __future__ import annotations

from fastapi import APIRouter
from typing import Any, TYPE_CHECKING

if TYPE_CHECKING:
    pass

from .common import (
    BUILD_VERSION,
    DEFAULT_PAPER_ROUTE_EVIDENCE_LOOKBACK_HOURS,
    DEFAULT_PAPER_ROUTE_EVIDENCE_TARGET_LIMIT,
    Decimal,
    Depends,
    ExecutionTCAMetric,
    HTTPConnection,
    HTTPException,
    HTTPSConnection,
    JSONResponse,
    MAX_PAPER_ROUTE_EVIDENCE_LOOKBACK_HOURS,
    MAX_PAPER_ROUTE_EVIDENCE_TARGET_LIMIT,
    Mapping,
    PAPER_ROUTE_RUNTIME_ACCOUNT_LABEL,
    ProofKind,
    ProofWindowSelector,
    Query,
    Sequence,
    Session,
    SessionLocal,
    PAPER_ROUTE_BOUNDED_COLLECTION_ACCOUNT_LABEL,
    PAPER_ROUTE_TARGET_PLAN_STALE_SUCCESS_SECONDS,
    PAPER_ROUTE_TARGET_PLAN_SUCCESS_CACHE_LOCK,
    Strategy,
    TradingScheduler,
    build_proofs_payload,
    cast,
    datetime,
    deepcopy,
    get_session,
    json,
    jsonable_encoder,
    load_quant_evidence_status,
    logger,
    main_runtime_value,
    os,
    select,
    settings,
    shared_mapping_items,
    shared_paper_route_target_plan_from_payload,
    time,
    urlsplit,
)
from .health_checks import (
    build_api_live_submission_gate_payload,
    build_hypothesis_runtime_payload,
    build_simple_lane_status_payload,
    decimal_or_none as _decimal_or_none,
    empirical_jobs_status,
    load_tca_summary,
)
from .proof_floor_payloads import (
    build_profitability_proof_floor_payload as _build_profitability_proof_floor_payload,
)
from .proxy import capture_module_exports
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
_load_tca_summary = load_tca_summary
router = APIRouter()
_paper_route_target_plan_success_cache: tuple[dict[str, Any], float] | None = None


def _set_paper_route_target_plan_success_cache(
    cache: tuple[dict[str, Any], float] | None,
) -> None:
    global _paper_route_target_plan_success_cache

    _paper_route_target_plan_success_cache = cache


def _paper_route_target_plan_audit_mode_value(mode: str) -> bool | None:
    normalized = mode.strip().lower()
    if normalized == "deferred":
        return False
    if normalized == "full":
        return True
    return None


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


@router.get("/trading/paper-route-evidence")
def trading_paper_route_evidence(
    lookback_hours: int = Query(
        DEFAULT_PAPER_ROUTE_EVIDENCE_LOOKBACK_HOURS,
        ge=1,
        le=MAX_PAPER_ROUTE_EVIDENCE_LOOKBACK_HOURS,
        description="Deprecated; use /trading/proofs limit/window instead.",
    ),
    target_limit: int = Query(
        DEFAULT_PAPER_ROUTE_EVIDENCE_TARGET_LIMIT,
        ge=1,
        le=MAX_PAPER_ROUTE_EVIDENCE_TARGET_LIMIT,
        description="Deprecated alias for /trading/proofs limit.",
    ),
    full_audit: bool = Query(
        False,
        description="Deprecated alias for /trading/proofs full_audit.",
    ),
) -> JSONResponse:
    """Deprecated adapter for the canonical proof payload."""

    del lookback_hours
    payload = _build_trading_proofs_payload(
        kind="runtime_window",
        limit=target_limit,
        window="auto",
        full_audit=full_audit,
    )
    payload["deprecated_endpoint"] = True
    payload["replacement_endpoint"] = "/trading/proofs"
    return JSONResponse(status_code=200, content=jsonable_encoder(payload))


@router.get("/trading/paper-route-target-plan")
def trading_paper_route_target_plan(
    runtime_window_import_audit: str = Query(
        "auto",
        pattern="^(auto|deferred|full)$",
        description="Deprecated; use /trading/proofs?window=next.",
    ),
) -> JSONResponse:
    """Deprecated adapter for the canonical proof payload."""

    audit_mode = _paper_route_target_plan_audit_mode_value(runtime_window_import_audit)
    payload = _build_trading_proofs_payload(
        kind="runtime_window",
        limit=DEFAULT_PAPER_ROUTE_EVIDENCE_TARGET_LIMIT,
        window="next",
        full_audit=audit_mode is True,
    )
    payload["deprecated_endpoint"] = True
    payload["replacement_endpoint"] = "/trading/proofs"
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
    return any(
        _paper_route_mapping_targets_sim_account(target)
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


def _paper_route_target_plan_probe_symbols(plan: Mapping[str, Any]) -> list[str]:
    symbols: list[str] = []
    for target in _paper_route_target_plan_targets(plan):
        for symbol in _paper_route_probe_symbol_values_from_mapping(target):
            if symbol not in symbols:
                symbols.append(symbol)
        for field in (
            "paper_route_clean_window_baseline_state",
            "clean_window_baseline_state",
        ):
            state = target.get(field)
            if not isinstance(state, Mapping):
                continue
            typed_state = cast(Mapping[str, Any], state)
            for symbol in _paper_route_probe_symbol_values_from_mapping(typed_state):
                if symbol not in symbols:
                    symbols.append(symbol)
            source_audit = typed_state.get("source_audit")
            if isinstance(source_audit, Mapping):
                for symbol in _paper_route_probe_symbol_values_from_mapping(
                    cast(Mapping[str, Any], source_audit)
                ):
                    if symbol not in symbols:
                        symbols.append(symbol)
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
    eligible_symbols = _paper_route_target_plan_probe_symbols(plan)
    if not eligible_symbols and session is not None:
        eligible_symbols = _paper_route_probe_symbols_from_target_plan_strategies(
            session,
            targets,
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
    blocking_reasons: list[str] = []
    if settings.trading_mode != "paper":
        blocking_reasons.append("not_paper_mode")
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


def _fetch_paper_route_target_plan_url(
    url: str,
    *,
    timeout_seconds: float,
    attempts: int = 1,
    retry_backoff_seconds: float = 0.25,
) -> dict[str, Any]:
    max_attempts = max(int(attempts), 1)
    result: dict[str, Any] = {}
    for attempt in range(1, max_attempts + 1):
        parsed = urlsplit(url)
        scheme = parsed.scheme.lower()
        if scheme not in {"http", "https"}:
            return {
                "load_error": f"paper_route_target_plan_invalid_scheme:{scheme or 'missing'}"
            }
        if not parsed.hostname:
            return {"load_error": "paper_route_target_plan_invalid_host"}
        if _paper_route_target_plan_url_points_to_self(parsed):
            return {"load_error": "paper_route_target_plan_self_reference"}

        path = parsed.path or "/"
        if parsed.query:
            path = f"{path}?{parsed.query}"
        connection_class = HTTPSConnection if scheme == "https" else HTTPConnection
        connection = connection_class(
            parsed.hostname,
            parsed.port,
            timeout=max(float(timeout_seconds), 0.1),
        )
        try:
            host_header = parsed.netloc or parsed.hostname
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
                result = {
                    "load_error": f"paper_route_target_plan_http_status:{response.status}"
                }
            else:
                raw = response.read(5_000_001)
                if len(raw) > 5_000_000:
                    result = {
                        "load_error": "paper_route_target_plan_response_too_large"
                    }
                else:
                    try:
                        payload = json.loads(raw.decode("utf-8"))
                    except Exception as exc:
                        result = {
                            "load_error": f"paper_route_target_plan_invalid_json:{exc}"
                        }
                    else:
                        if not isinstance(payload, Mapping):
                            result = {
                                "load_error": "paper_route_target_plan_invalid_payload"
                            }
                        else:
                            plan = _paper_route_target_plan_from_payload(
                                cast(Mapping[str, Any], payload)
                            )
                            if not plan:
                                result = {
                                    "load_error": "paper_route_target_plan_missing"
                                }
                            else:
                                result = dict(plan)
                                result.setdefault(
                                    "source", "external_paper_route_target_plan"
                                )
        except Exception as exc:  # pragma: no cover - depends on network
            result = {"load_error": f"paper_route_target_plan_fetch_failed:{exc}"}
        finally:
            connection.close()

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


def _paper_route_target_plan_url_points_to_self(parsed: Any) -> bool:
    path = str(getattr(parsed, "path", "") or "").rstrip("/")
    if path not in {"/trading/paper-route-target-plan", "/trading/proofs"}:
        return False
    hostname = str(getattr(parsed, "hostname", "") or "").strip().lower()
    if not hostname:
        return False

    self_hosts = {"localhost", "127.0.0.1", "::1"}
    service_name = os.getenv("K_SERVICE", "").strip().lower()
    namespace = os.getenv("POD_NAMESPACE", os.getenv("NAMESPACE", "")).strip().lower()
    if service_name:
        if not namespace and service_name in {"torghut", "torghut-sim"}:
            namespace = "torghut"
        self_hosts.add(service_name)
        if namespace:
            self_hosts.update(
                {
                    f"{service_name}.{namespace}",
                    f"{service_name}.{namespace}.svc",
                    f"{service_name}.{namespace}.svc.cluster.local",
                }
            )
    return hostname in self_hosts


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
                "Using stale successful paper-route target plan after fetch failure url=%s error=%s",
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
        if _paper_route_target_plan_targets(local_plan):
            return gate
        return gate

    load_error = str(external_plan.get("load_error") or "").strip()
    if load_error:
        gate["paper_route_target_plan_error"] = load_error
        if settings.trading_paper_route_target_plan_url:
            if _paper_route_target_plan_cache_safe_for_live(local_plan):
                gate.setdefault(
                    "paper_route_target_plan_source",
                    "local_runtime_ledger_paper_probation_import_plan",
                )
                gate["paper_route_target_plan_external_source"] = (
                    "external_target_plan_url"
                )
                return gate
            gate["runtime_ledger_paper_probation_import_plan"] = {
                "schema_version": local_plan.get("schema_version")
                or "torghut.runtime-ledger-paper-probation-import-plan.v1",
                "target_count": 0,
                "skipped_target_count": len(
                    _paper_route_target_plan_targets(local_plan)
                ),
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
            gate["paper_route_target_plan_source"] = "external_target_plan_url"
        return gate

    if _paper_route_target_plan_targets(
        local_plan
    ) and not _paper_route_target_plan_targets(external_plan):
        return gate

    if _paper_route_target_plan_targets(external_plan):
        merged_plan = dict(external_plan)
        cache_status = str(
            merged_plan.get("paper_route_target_plan_cache_status") or ""
        ).strip()
        last_load_error = str(
            merged_plan.get("paper_route_target_plan_last_load_error") or ""
        ).strip()
        merged_targets: list[dict[str, Any]] = []
        for raw_target in _paper_route_target_plan_targets(external_plan):
            target = dict(raw_target)
            target["paper_route_target_plan_source"] = "external_target_plan_url"
            if target.get("paper_route_probe_symbols"):
                target["paper_route_probe_scope_authority"] = "external_target_plan"
            merged_targets.append(target)
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

    return gate


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
    "_paper_route_target_plan_audit_mode_value",
    "_proof_kind_value",
    "_proof_window_value",
    "_trading_scheduler_for_proofs",
    "_build_trading_proofs_payload",
    "trading_proofs",
    "trading_paper_route_evidence",
    "trading_paper_route_target_plan",
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
capture_module_exports(globals(), __all__)
