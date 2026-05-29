"""Lane-local profit window and evidence escrow projection helpers."""

from __future__ import annotations

import hashlib
import json
from collections import Counter
from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from typing import Any, cast

from .market_context_domains import (
    active_market_context_mapping,
    active_market_context_reasons,
)

PROFIT_WINDOW_CONTRACT_SCHEMA_VERSION = "torghut.profit-window-contract.v1"

_CLICKHOUSE_FRESHNESS_REASONS = frozenset(
    {
        "quant_latest_metrics_empty",
        "quant_latest_store_alarm",
        "quant_metrics_update_missing",
        "quant_pipeline_degraded",
        "quant_pipeline_stages_missing",
    }
)
_FORECAST_OR_FEATURE_REASONS = frozenset(
    {
        "drift_checks_missing",
        "feature_rows_missing",
        "required_feature_set_unavailable",
    }
)
_MARKET_CONTEXT_STALE_STATES = frozenset(
    {"blocked", "degraded", "down", "error", "stale"}
)


def _safe_text(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _as_mapping(value: object) -> Mapping[str, Any]:
    return cast(Mapping[str, Any], value) if isinstance(value, Mapping) else {}


def _string_list(value: object) -> list[str]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        return []
    return sorted(
        {text for item in cast(Sequence[object], value) if (text := _safe_text(item))}
    )


def _stable_hash(prefix: str, payload: Mapping[str, object]) -> str:
    encoded = json.dumps(
        {"prefix": prefix, **dict(payload)},
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()[:24]


def _session_class(*, market_session_open: object, replay: bool) -> str:
    if replay:
        return "replay"
    if market_session_open is True:
        return "market_open"
    if market_session_open is False:
        return "off_session"
    return "market_close"


def _escrow(
    *,
    account: str | None,
    window: str | None,
    hypothesis_id: str,
    escrow_type: str,
    status: str,
    required: bool,
    reason_codes: Sequence[str] = (),
    source_ref: object = None,
) -> dict[str, object]:
    normalized_reasons = _string_list(reason_codes)
    source_text = _safe_text(source_ref)
    escrow_id = _stable_hash(
        "evidence-escrow",
        {
            "account": account,
            "window": window,
            "hypothesis_id": hypothesis_id,
            "escrow_type": escrow_type,
            "source_ref": source_text,
        },
    )
    return {
        "evidence_escrow_id": escrow_id,
        "hypothesis_id": hypothesis_id,
        "type": escrow_type,
        "status": status,
        "required": required,
        "reason_codes": normalized_reasons,
        "source_ref": source_text,
    }


def _quant_escrow(
    *,
    account: str | None,
    window: str | None,
    hypothesis_id: str,
    quant_evidence: Mapping[str, Any],
) -> dict[str, object]:
    required = bool(quant_evidence.get("required", True))
    blocking_reasons = _string_list(quant_evidence.get("blocking_reasons") or [])
    informational_reasons = _string_list(
        quant_evidence.get("informational_reasons") or []
    )
    health_reasons = sorted({*blocking_reasons, *informational_reasons})
    ok = bool(quant_evidence.get("ok"))
    if ok and not health_reasons:
        status = "funded"
        reason_codes: list[str] = []
    elif set(health_reasons) & _CLICKHOUSE_FRESHNESS_REASONS:
        status = "expired"
        reason_codes = health_reasons
    else:
        status = "underfunded"
        reason_codes = health_reasons or [
            _safe_text(quant_evidence.get("reason")) or "quant_health_unavailable"
        ]
    return _escrow(
        account=account,
        window=window,
        hypothesis_id=hypothesis_id,
        escrow_type="torghut_quant",
        status=status,
        required=required,
        reason_codes=reason_codes,
        source_ref=quant_evidence.get("source_url"),
    )


def _clickhouse_freshness_escrow(
    *,
    account: str | None,
    window: str | None,
    hypothesis_id: str,
    quant_evidence: Mapping[str, Any],
) -> dict[str, object]:
    required = bool(quant_evidence.get("required", True))
    blocking_reasons = _string_list(quant_evidence.get("blocking_reasons") or [])
    informational_reasons = _string_list(
        quant_evidence.get("informational_reasons") or []
    )
    health_reasons = sorted({*blocking_reasons, *informational_reasons})
    freshness_reasons = sorted(set(health_reasons) & _CLICKHOUSE_FRESHNESS_REASONS)
    funded = bool(quant_evidence.get("ok")) and not health_reasons
    status = "funded" if funded else "expired"
    return _escrow(
        account=account,
        window=window,
        hypothesis_id=hypothesis_id,
        escrow_type="clickhouse_freshness",
        status=status,
        required=required,
        reason_codes=[] if funded else freshness_reasons or health_reasons,
        source_ref=quant_evidence.get("source_url"),
    )


def _empirical_escrow(
    *,
    account: str | None,
    window: str | None,
    hypothesis_id: str,
    empirical_jobs_status: Mapping[str, Any],
) -> dict[str, object]:
    if not empirical_jobs_status:
        return _escrow(
            account=account,
            window=window,
            hypothesis_id=hypothesis_id,
            escrow_type="empirical_jobs",
            status="underfunded",
            required=True,
            reason_codes=["empirical_jobs_status_missing"],
        )
    if bool(empirical_jobs_status.get("ready")):
        return _escrow(
            account=account,
            window=window,
            hypothesis_id=hypothesis_id,
            escrow_type="empirical_jobs",
            status="funded",
            required=True,
            source_ref=",".join(
                _string_list(empirical_jobs_status.get("dataset_snapshot_refs") or [])
            ),
        )
    stale_jobs = _string_list(empirical_jobs_status.get("stale_jobs") or [])
    missing_jobs = _string_list(empirical_jobs_status.get("missing_jobs") or [])
    ineligible_jobs = _string_list(empirical_jobs_status.get("ineligible_jobs") or [])
    status = "expired" if stale_jobs else "underfunded"
    reason_codes = [f"job_stale:{item}" for item in stale_jobs]
    reason_codes.extend(f"job_missing:{item}" for item in missing_jobs)
    reason_codes.extend(f"job_ineligible:{item}" for item in ineligible_jobs)
    reason_codes.extend(
        _string_list(empirical_jobs_status.get("blocked_reasons") or [])
    )
    return _escrow(
        account=account,
        window=window,
        hypothesis_id=hypothesis_id,
        escrow_type="empirical_jobs",
        status=status,
        required=True,
        reason_codes=reason_codes
        or [
            _safe_text(empirical_jobs_status.get("status")) or "empirical_jobs_degraded"
        ],
        source_ref=",".join(
            _string_list(empirical_jobs_status.get("dataset_snapshot_refs") or [])
        ),
    )


def _market_context_escrow(
    *,
    account: str | None,
    window: str | None,
    hypothesis_id: str,
    required: bool,
    market_context_ref: Mapping[str, Any],
    segment_summary: Mapping[str, Mapping[str, object]],
) -> dict[str, object]:
    segment = _as_mapping(segment_summary.get("market-context"))
    reason_codes = active_market_context_reasons(
        _string_list(segment.get("reason_codes") or [])
    )
    domain_states = active_market_context_mapping(
        _as_mapping(market_context_ref.get("last_domain_states"))
    )
    source_ref = market_context_ref.get("last_as_of") or market_context_ref.get(
        "last_checked_at"
    )
    stale_domains = [
        f"market_context_domain_{name}_{state}"
        for name, state in sorted(
            (str(key), str(value).strip().lower())
            for key, value in domain_states.items()
        )
        if state in _MARKET_CONTEXT_STALE_STATES
    ]
    reason_codes.extend(stale_domains)
    if bool(market_context_ref.get("alert_active")):
        reason_codes.extend(
            active_market_context_reasons(
                [
                    _safe_text(market_context_ref.get("alert_reason"))
                    or "market_context_alert_active"
                ]
            )
        )
    missing_required_evidence = required and source_ref is None and not domain_states
    if missing_required_evidence and not reason_codes:
        reason_codes.append("market_context_evidence_missing")
    status = (
        "underfunded"
        if missing_required_evidence
        else "funded"
        if not reason_codes
        else "expired"
    )
    return _escrow(
        account=account,
        window=window,
        hypothesis_id=hypothesis_id,
        escrow_type="market_context",
        status=status,
        required=required,
        reason_codes=reason_codes,
        source_ref=source_ref,
    )


def _forecast_escrow(
    *,
    account: str | None,
    window: str | None,
    hypothesis_id: str,
    required: bool,
    item_reasons: Sequence[str],
) -> dict[str, object]:
    reason_codes = sorted(set(item_reasons) & _FORECAST_OR_FEATURE_REASONS)
    status = "funded" if not reason_codes else "underfunded"
    return _escrow(
        account=account,
        window=window,
        hypothesis_id=hypothesis_id,
        escrow_type="forecast",
        status=status,
        required=required,
        reason_codes=reason_codes,
    )


def _schema_lineage_escrow(
    *,
    account: str | None,
    window: str | None,
    hypothesis_id: str,
    lineage_ref: Mapping[str, object],
) -> dict[str, object]:
    status_text = _safe_text(lineage_ref.get("status")) or "unverified"
    if status_text == "ready":
        status = "funded"
        reason_codes: list[str] = []
    elif status_text == "missing":
        status = "underfunded"
        reason_codes = ["schema_lineage_missing"]
    else:
        status = "underfunded"
        reason_codes = [f"schema_lineage_{status_text}"]
    return _escrow(
        account=account,
        window=window,
        hypothesis_id=hypothesis_id,
        escrow_type="schema_lineage",
        status=status,
        required=True,
        reason_codes=reason_codes,
        source_ref=lineage_ref.get("dataset_snapshot_ref"),
    )


def _window_decision(
    escrows: Sequence[Mapping[str, object]], item: Mapping[str, Any]
) -> str:
    required = [escrow for escrow in escrows if bool(escrow.get("required"))]
    blocking = [escrow for escrow in required if escrow.get("status") != "funded"]
    blocking_statuses = {str(escrow.get("status")) for escrow in blocking}
    if bool(item.get("rollback_required")):
        return "quarantined"
    if "underfunded" in blocking_statuses:
        return "underfunded"
    if "expired" in blocking_statuses:
        return "expired"
    return "funded"


def _capital_state(decision: str, capital_stage: object) -> str:
    if decision == "quarantined":
        return "quarantine"
    if decision != "funded":
        return "shadow"
    stage = _safe_text(capital_stage) or "shadow"
    if "live" in stage:
        return "live"
    if "canary" in stage:
        return "canary"
    return "shadow"


def build_profit_window_contract(
    *,
    runtime_items: Sequence[Mapping[str, Any]],
    quant_evidence: Mapping[str, Any] | None,
    empirical_jobs_status: Mapping[str, Any] | None,
    market_context_ref: Mapping[str, Any] | None,
    segment_summary: Mapping[str, Mapping[str, object]] | None,
    lineage_ref: Mapping[str, object] | None = None,
    account: str | None = None,
    window: str | None = None,
    market_session_open: object = None,
    replay: bool = False,
    now: datetime | None = None,
) -> dict[str, object]:
    """Build deterministic shadow profit-window accounting for one gate snapshot."""

    generated_at = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    quant = _as_mapping(quant_evidence)
    empirical = _as_mapping(empirical_jobs_status)
    market_context = _as_mapping(market_context_ref)
    segments = cast(Mapping[str, Mapping[str, object]], segment_summary or {})
    lineage = _as_mapping(lineage_ref)
    account_label = account or _safe_text(quant.get("account"))
    window_label = window or _safe_text(quant.get("window"))
    session_class = _session_class(
        market_session_open=market_session_open, replay=replay
    )

    windows: list[dict[str, object]] = []
    escrows: list[dict[str, object]] = []
    for raw_item in runtime_items:
        item = _as_mapping(raw_item)
        hypothesis_id = _safe_text(item.get("hypothesis_id")) or "unknown"
        lane_id = _safe_text(item.get("lane_id")) or hypothesis_id
        capabilities = _as_mapping(item.get("dependency_capabilities"))
        required_capabilities = set(
            _string_list(
                capabilities.get("required")
                or item.get("required_dependency_capabilities")
                or []
            )
        )
        item_reasons = _string_list(item.get("reasons") or [])
        market_context_required = "market_context_freshness" in required_capabilities
        forecast_required = bool(
            {"feature_coverage", "drift_governance"} & required_capabilities
        )

        item_escrows = [
            _quant_escrow(
                account=account_label,
                window=window_label,
                hypothesis_id=hypothesis_id,
                quant_evidence=quant,
            ),
            _clickhouse_freshness_escrow(
                account=account_label,
                window=window_label,
                hypothesis_id=hypothesis_id,
                quant_evidence=quant,
            ),
            _empirical_escrow(
                account=account_label,
                window=window_label,
                hypothesis_id=hypothesis_id,
                empirical_jobs_status=empirical,
            ),
            _market_context_escrow(
                account=account_label,
                window=window_label,
                hypothesis_id=hypothesis_id,
                required=market_context_required,
                market_context_ref=market_context,
                segment_summary=segments,
            ),
            _forecast_escrow(
                account=account_label,
                window=window_label,
                hypothesis_id=hypothesis_id,
                required=forecast_required,
                item_reasons=item_reasons,
            ),
            _schema_lineage_escrow(
                account=account_label,
                window=window_label,
                hypothesis_id=hypothesis_id,
                lineage_ref=lineage,
            ),
        ]
        decision = _window_decision(item_escrows, item)
        blocking_escrow_ids = [
            str(escrow["evidence_escrow_id"])
            for escrow in item_escrows
            if bool(escrow.get("required")) and escrow.get("status") != "funded"
        ]
        profit_window_id = _stable_hash(
            "profit-window",
            {
                "account": account_label,
                "window": window_label,
                "session_class": session_class,
                "hypothesis_id": hypothesis_id,
                "lane_id": lane_id,
            },
        )
        windows.append(
            {
                "profit_window_id": profit_window_id,
                "hypothesis_id": hypothesis_id,
                "lane_id": lane_id,
                "strategy_family": item.get("strategy_family"),
                "account": account_label,
                "window": window_label,
                "window_session_class": session_class,
                "decision": decision,
                "capital_state": _capital_state(decision, item.get("capital_stage")),
                "required_escrow_ids": [
                    str(escrow["evidence_escrow_id"])
                    for escrow in item_escrows
                    if bool(escrow.get("required"))
                ],
                "blocking_escrow_ids": blocking_escrow_ids,
                "reason_codes": sorted(
                    {
                        *item_reasons,
                        *[
                            reason
                            for escrow in item_escrows
                            for reason in cast(
                                Sequence[str], escrow.get("reason_codes") or []
                            )
                        ],
                    }
                ),
            }
        )
        escrows.extend(item_escrows)

    decision_totals = Counter(str(item.get("decision")) for item in windows)
    return {
        "schema_version": PROFIT_WINDOW_CONTRACT_SCHEMA_VERSION,
        "generated_at": generated_at.isoformat(),
        "account": account_label,
        "window": window_label,
        "window_session_class": session_class,
        "windows": windows,
        "escrows": escrows,
        "summary": {
            "windows_total": len(windows),
            "decision_totals": dict(sorted(decision_totals.items())),
            "blocking_windows": [
                str(item["profit_window_id"])
                for item in windows
                if item.get("decision") in {"expired", "underfunded", "quarantined"}
            ],
        },
    }


__all__ = [
    "PROFIT_WINDOW_CONTRACT_SCHEMA_VERSION",
    "build_profit_window_contract",
]
