"""Source-qualified profit lease projection for Torghut capital consumers."""

from __future__ import annotations

import hashlib
import json
from collections import Counter
from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta, timezone
from typing import Any, Literal, cast

PROFIT_LEASE_PROJECTION_SCHEMA_VERSION = "torghut.profit-lease-provenance.v1"

ProfitProofState = Literal["current", "stale", "missing", "contradictory", "blocked"]
ProfitCapitalDecision = Literal[
    "observe_only",
    "repair_only",
    "paper_candidate",
    "live_candidate",
    "blocked",
]

_BLOCKING_PROOF_STATE_RANK: dict[ProfitProofState, int] = {
    "current": 0,
    "stale": 1,
    "missing": 2,
    "contradictory": 3,
    "blocked": 4,
}
_CAPITAL_DECISION_RANK: dict[ProfitCapitalDecision, int] = {
    "observe_only": 0,
    "repair_only": 1,
    "paper_candidate": 2,
    "live_candidate": 3,
    "blocked": 4,
}
_EMPIRICAL_REPAIR_REASONS = frozenset(
    {
        "empirical_jobs_not_ready",
        "empirical_jobs_degraded",
        "empirical_jobs_status_missing",
    }
)
_QUANT_METRICS_REASONS = frozenset(
    {
        "quant_health_not_configured",
        "quant_health_invalid_endpoint",
        "quant_health_fetch_failed",
        "quant_latest_metrics_empty",
        "quant_latest_store_alarm",
        "quant_metrics_update_missing",
        "quant_pipeline_degraded",
        "quant_pipeline_stages_missing",
    }
)
_LEGACY_PROMOTION_TABLE_NAMES = (
    "research_candidates",
    "research_promotions",
    "strategy_promotion_decisions",
    "vnext_promotion_decisions",
)
_AUTORESEARCH_PROMOTION_TABLE_NAMES = (
    "autoresearch_epochs",
    "autoresearch_candidate_specs",
    "autoresearch_proposal_scores",
    "autoresearch_portfolio_candidates",
    "autoresearch_portfolio_ready",
    "autoresearch_portfolio_blocked",
)
_PROMOTION_TABLE_NAMES = (
    *_LEGACY_PROMOTION_TABLE_NAMES,
    *_AUTORESEARCH_PROMOTION_TABLE_NAMES,
)


def _safe_text(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _safe_int(value: object) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str) and value.strip():
        try:
            return int(value.strip())
        except ValueError:
            return 0
    return 0


def _safe_float(value: object) -> float | None:
    if isinstance(value, bool):
        return float(int(value))
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str) and value.strip():
        try:
            return float(value.strip())
        except ValueError:
            return None
    return None


def _string_list(value: object) -> list[str]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        return []
    return sorted(
        {text for item in cast(Sequence[object], value) if (text := _safe_text(item))}
    )


def _runtime_autoresearch_refs(item: Mapping[str, Any]) -> list[str]:
    refs: list[str] = []
    for key in (
        "autoresearch_portfolio_candidate_id",
        "portfolio_candidate_id",
        "autoresearch_candidate_spec_id",
        "candidate_spec_id",
        "candidate_id",
        "hypothesis_id",
    ):
        if text := _safe_text(item.get(key)):
            refs.append(f"{key}:{text}")
    source_ids = _string_list(item.get("source_candidate_ids"))
    refs.extend(f"source_candidate_id:{source_id}" for source_id in source_ids)
    evidence_refs = _string_list(item.get("evidence_refs"))
    refs.extend(f"evidence_ref:{evidence_ref}" for evidence_ref in evidence_refs)
    return sorted(set(refs))


def _as_mapping(value: object) -> Mapping[str, Any]:
    return cast(Mapping[str, Any], value) if isinstance(value, Mapping) else {}


def _stable_hash(prefix: str, payload: Mapping[str, object]) -> str:
    encoded = json.dumps(
        {"prefix": prefix, **dict(payload)},
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()[:24]


def _ensure_aware(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _most_blocking_state(states: Sequence[ProfitProofState]) -> ProfitProofState:
    if not states:
        return "missing"
    return max(states, key=lambda item: _BLOCKING_PROOF_STATE_RANK[item])


def _least_permissive_decision(
    decisions: Sequence[ProfitCapitalDecision],
) -> ProfitCapitalDecision:
    if not decisions:
        return "blocked"
    return min(decisions, key=lambda item: _CAPITAL_DECISION_RANK[item])


def _is_options_hypothesis(item: Mapping[str, Any]) -> bool:
    text = " ".join(
        value
        for value in (
            _safe_text(item.get("hypothesis_id")),
            _safe_text(item.get("lane_id")),
            _safe_text(item.get("strategy_family")),
        )
        if value is not None
    ).lower()
    if "option" in text:
        return True
    required_features = _string_list(item.get("required_feature_sets") or [])
    return any("option" in feature.lower() for feature in required_features)


def _source_record(
    *,
    proof_id: str,
    hypothesis_id: str,
    account: str | None,
    window: str | None,
    source_class: str,
    source_ref: object = None,
    observed_at: object = None,
    fresh_until: object = None,
    freshness_state: ProfitProofState,
    rows: int | None = None,
    symbols: int | None = None,
    expected_net_edge_bps: float | None = None,
    rejection_drag_bps: float | None = None,
    decision: ProfitCapitalDecision,
    blocking_reason_codes: Sequence[str] = (),
) -> dict[str, object]:
    return {
        "proof_id": proof_id,
        "hypothesis_id": hypothesis_id,
        "account": account,
        "window": window,
        "source_class": source_class,
        "source_ref": _safe_text(source_ref),
        "observed_at": _safe_text(observed_at),
        "fresh_until": _safe_text(fresh_until),
        "freshness_state": freshness_state,
        "rows": rows,
        "symbols": symbols,
        "expected_net_edge_bps": expected_net_edge_bps,
        "rejection_drag_bps": rejection_drag_bps,
        "decision": decision,
        "blocking_reason_codes": sorted(set(blocking_reason_codes)),
    }


def _empirical_source(
    *,
    proof_id: str,
    hypothesis_id: str,
    account: str | None,
    window: str | None,
    empirical_jobs_status: Mapping[str, Any],
) -> dict[str, object]:
    if not empirical_jobs_status:
        return _source_record(
            proof_id=proof_id,
            hypothesis_id=hypothesis_id,
            account=account,
            window=window,
            source_class="empirical_job",
            freshness_state="missing",
            decision="repair_only",
            blocking_reason_codes=["empirical_jobs_status_missing"],
        )
    if bool(empirical_jobs_status.get("ready")):
        dataset_refs = _string_list(empirical_jobs_status.get("dataset_snapshot_refs"))
        return _source_record(
            proof_id=proof_id,
            hypothesis_id=hypothesis_id,
            account=account,
            window=window,
            source_class="empirical_job",
            source_ref=",".join(dataset_refs),
            observed_at=empirical_jobs_status.get("last_completed_at")
            or empirical_jobs_status.get("as_of"),
            fresh_until=empirical_jobs_status.get("fresh_until"),
            freshness_state="current",
            rows=_safe_int(empirical_jobs_status.get("completed_jobs")),
            decision="paper_candidate",
        )
    stale_jobs = _string_list(empirical_jobs_status.get("stale_jobs"))
    missing_jobs = _string_list(empirical_jobs_status.get("missing_jobs"))
    ineligible_jobs = _string_list(empirical_jobs_status.get("ineligible_jobs"))
    reasons = [
        *(f"job_stale:{item}" for item in stale_jobs),
        *(f"job_missing:{item}" for item in missing_jobs),
        *(f"job_ineligible:{item}" for item in ineligible_jobs),
        *_string_list(empirical_jobs_status.get("blocked_reasons")),
    ]
    state: ProfitProofState = "stale" if stale_jobs else "missing"
    return _source_record(
        proof_id=proof_id,
        hypothesis_id=hypothesis_id,
        account=account,
        window=window,
        source_class="empirical_job",
        source_ref=",".join(
            _string_list(empirical_jobs_status.get("dataset_snapshot_refs"))
        ),
        observed_at=empirical_jobs_status.get("last_completed_at")
        or empirical_jobs_status.get("as_of"),
        fresh_until=empirical_jobs_status.get("fresh_until"),
        freshness_state=state,
        rows=_safe_int(empirical_jobs_status.get("completed_jobs")),
        decision="repair_only",
        blocking_reason_codes=reasons
        or [
            _safe_text(empirical_jobs_status.get("status")) or "empirical_jobs_degraded"
        ],
    )


def _quant_source(
    *,
    proof_id: str,
    hypothesis_id: str,
    account: str | None,
    window: str | None,
    quant_evidence: Mapping[str, Any],
) -> dict[str, object]:
    required = bool(quant_evidence.get("required", True))
    blocking_reasons = _string_list(quant_evidence.get("blocking_reasons"))
    informational_reasons = _string_list(quant_evidence.get("informational_reasons"))
    reason_codes = sorted({*blocking_reasons, *informational_reasons})
    if not required:
        return _source_record(
            proof_id=proof_id,
            hypothesis_id=hypothesis_id,
            account=account,
            window=window,
            source_class="quant_metrics",
            source_ref=quant_evidence.get("source_url"),
            observed_at=quant_evidence.get("latest_metrics_updated_at")
            or quant_evidence.get("as_of"),
            freshness_state="current",
            rows=_safe_int(quant_evidence.get("latest_metrics_count")),
            decision="observe_only",
        )
    if bool(quant_evidence.get("ok")) and not reason_codes:
        return _source_record(
            proof_id=proof_id,
            hypothesis_id=hypothesis_id,
            account=account,
            window=window,
            source_class="quant_metrics",
            source_ref=quant_evidence.get("source_url"),
            observed_at=quant_evidence.get("latest_metrics_updated_at")
            or quant_evidence.get("as_of"),
            freshness_state="current",
            rows=_safe_int(quant_evidence.get("latest_metrics_count")),
            decision="paper_candidate",
        )
    freshness_state: ProfitProofState = (
        "missing" if set(reason_codes) & _QUANT_METRICS_REASONS else "blocked"
    )
    return _source_record(
        proof_id=proof_id,
        hypothesis_id=hypothesis_id,
        account=account,
        window=window,
        source_class="quant_metrics",
        source_ref=quant_evidence.get("source_url"),
        observed_at=quant_evidence.get("latest_metrics_updated_at")
        or quant_evidence.get("as_of"),
        freshness_state=freshness_state,
        rows=_safe_int(quant_evidence.get("latest_metrics_count")),
        decision="repair_only",
        blocking_reason_codes=reason_codes
        or [_safe_text(quant_evidence.get("reason")) or "quant_metrics_missing"],
    )


def _data_readiness_source(
    *,
    proof_id: str,
    hypothesis_id: str,
    account: str | None,
    window: str | None,
    item: Mapping[str, Any],
    data_readiness: Mapping[str, Any],
) -> dict[str, object]:
    options_hypothesis = _is_options_hypothesis(item)
    source_class = "options_features" if options_hypothesis else "equity_ta"
    rows_key = "options_feature_rows" if options_hypothesis else "equity_ta_rows"
    symbols_key = "options_symbols" if options_hypothesis else "equity_ta_symbols"
    rows = _safe_int(
        item.get(rows_key)
        or data_readiness.get(rows_key)
        or item.get("data_plane_rows")
        or 0
    )
    symbols = _safe_int(
        item.get(symbols_key)
        or data_readiness.get(symbols_key)
        or item.get("data_plane_symbols")
        or 0
    )
    if options_hypothesis and rows <= 0:
        return _source_record(
            proof_id=proof_id,
            hypothesis_id=hypothesis_id,
            account=account,
            window=window,
            source_class=source_class,
            source_ref=data_readiness.get("options_source_ref"),
            freshness_state="missing",
            rows=rows,
            symbols=symbols,
            decision="repair_only",
            blocking_reason_codes=["options_feature_rows_missing"],
        )
    if rows <= 0 and symbols <= 0:
        return _source_record(
            proof_id=proof_id,
            hypothesis_id=hypothesis_id,
            account=account,
            window=window,
            source_class=source_class,
            source_ref=data_readiness.get("equity_ta_source_ref"),
            freshness_state="missing",
            rows=rows,
            symbols=symbols,
            decision="observe_only",
            blocking_reason_codes=[f"{source_class}_rows_missing"],
        )
    return _source_record(
        proof_id=proof_id,
        hypothesis_id=hypothesis_id,
        account=account,
        window=window,
        source_class=source_class,
        source_ref=data_readiness.get("options_source_ref")
        if options_hypothesis
        else data_readiness.get("equity_ta_source_ref"),
        observed_at=data_readiness.get("observed_at"),
        fresh_until=data_readiness.get("fresh_until"),
        freshness_state="current",
        rows=rows,
        symbols=symbols,
        decision="observe_only" if not options_hypothesis else "paper_candidate",
    )


def _promotion_source(
    *,
    proof_id: str,
    hypothesis_id: str,
    account: str | None,
    window: str | None,
    item: Mapping[str, Any],
    promotion_table_counts: Mapping[str, Any],
) -> dict[str, object]:
    counts = {
        name: _safe_int(promotion_table_counts.get(name))
        for name in _PROMOTION_TABLE_NAMES
    }
    count_errors = _string_list(promotion_table_counts.get("count_errors"))
    truncated_counts = _string_list(promotion_table_counts.get("truncated_counts"))
    read_blockers = [
        f"promotion_table_read_unavailable:{name}" for name in count_errors
    ] + [f"promotion_table_count_truncated:{name}" for name in truncated_counts]
    if read_blockers:
        return _source_record(
            proof_id=proof_id,
            hypothesis_id=hypothesis_id,
            account=account,
            window=window,
            source_class="research_candidate",
            source_ref="postgres:promotion_tables:bounded_read",
            freshness_state="blocked",
            rows=sum(counts.values()),
            decision="repair_only",
            blocking_reason_codes=read_blockers,
        )
    legacy_counts = {name: counts[name] for name in _LEGACY_PROMOTION_TABLE_NAMES}
    legacy_missing = [name for name, count in legacy_counts.items() if count <= 0]
    if not legacy_missing:
        return _source_record(
            proof_id=proof_id,
            hypothesis_id=hypothesis_id,
            account=account,
            window=window,
            source_class="research_candidate",
            source_ref="postgres:promotion_tables",
            freshness_state="current",
            rows=sum(legacy_counts.values()),
            decision="paper_candidate",
        )

    autoresearch_candidates = counts["autoresearch_candidate_specs"]
    autoresearch_proposals = counts["autoresearch_proposal_scores"]
    autoresearch_portfolios = counts["autoresearch_portfolio_candidates"]
    autoresearch_ready = counts["autoresearch_portfolio_ready"]
    autoresearch_blocked = counts["autoresearch_portfolio_blocked"]
    autoresearch_rows = (
        autoresearch_candidates + autoresearch_proposals + autoresearch_portfolios
    )
    if autoresearch_rows > 0:
        autoresearch_refs = _runtime_autoresearch_refs(item)
        ready_refs = set(
            _string_list(
                promotion_table_counts.get("autoresearch_portfolio_ready_refs")
            )
        )
        matching_ready_refs = sorted(set(autoresearch_refs) & ready_refs)
        autoresearch_missing: list[str] = []
        if autoresearch_candidates <= 0:
            autoresearch_missing.append("autoresearch_candidate_specs_empty")
        if autoresearch_proposals <= 0:
            autoresearch_missing.append("autoresearch_proposal_scores_empty")
        if autoresearch_portfolios <= 0:
            autoresearch_missing.append("autoresearch_portfolio_candidates_empty")
        if autoresearch_ready > 0 and not autoresearch_missing:
            if not autoresearch_refs:
                return _source_record(
                    proof_id=proof_id,
                    hypothesis_id=hypothesis_id,
                    account=account,
                    window=window,
                    source_class="research_candidate",
                    source_ref="postgres:autoresearch_ledgers:unqualified",
                    freshness_state="blocked",
                    rows=autoresearch_rows,
                    decision="repair_only",
                    blocking_reason_codes=[
                        "autoresearch_candidate_ref_missing",
                        "autoresearch_portfolio_match_unverified",
                    ],
                )
            if not ready_refs:
                return _source_record(
                    proof_id=proof_id,
                    hypothesis_id=hypothesis_id,
                    account=account,
                    window=window,
                    source_class="research_candidate",
                    source_ref="postgres:autoresearch_ledgers:ready_refs_missing",
                    freshness_state="blocked",
                    rows=autoresearch_rows,
                    decision="repair_only",
                    blocking_reason_codes=[
                        "autoresearch_portfolio_ready_refs_missing",
                        "autoresearch_portfolio_match_unverified",
                    ],
                )
            if not matching_ready_refs:
                return _source_record(
                    proof_id=proof_id,
                    hypothesis_id=hypothesis_id,
                    account=account,
                    window=window,
                    source_class="research_candidate",
                    source_ref=(
                        "postgres:autoresearch_ledgers:unmatched:"
                        f"{','.join(autoresearch_refs)}"
                    ),
                    freshness_state="blocked",
                    rows=autoresearch_rows,
                    decision="repair_only",
                    blocking_reason_codes=["autoresearch_portfolio_match_unverified"],
                )
            return _source_record(
                proof_id=proof_id,
                hypothesis_id=hypothesis_id,
                account=account,
                window=window,
                source_class="research_candidate",
                source_ref=(
                    f"postgres:autoresearch_ledgers:{','.join(matching_ready_refs)}"
                ),
                freshness_state="current",
                rows=autoresearch_rows,
                decision="paper_candidate",
            )

        blockers = list(autoresearch_missing)
        if autoresearch_ready <= 0:
            blockers.append("autoresearch_portfolio_ready_empty")
        if autoresearch_blocked > 0:
            blockers.append("autoresearch_portfolio_candidates_blocked")
        return _source_record(
            proof_id=proof_id,
            hypothesis_id=hypothesis_id,
            account=account,
            window=window,
            source_class="research_candidate",
            source_ref="postgres:autoresearch_ledgers",
            freshness_state="blocked"
            if autoresearch_portfolios > 0 or autoresearch_blocked > 0
            else "missing",
            rows=autoresearch_rows,
            decision="repair_only",
            blocking_reason_codes=blockers,
        )

    return _source_record(
        proof_id=proof_id,
        hypothesis_id=hypothesis_id,
        account=account,
        window=window,
        source_class="research_candidate",
        source_ref="postgres:promotion_tables",
        freshness_state="missing",
        rows=sum(legacy_counts.values()),
        decision="repair_only",
        blocking_reason_codes=[f"{name}_empty" for name in legacy_missing],
    )


def _rejection_source(
    *,
    proof_id: str,
    hypothesis_id: str,
    account: str | None,
    window: str | None,
    rejection_summary: Mapping[str, Any],
) -> dict[str, object]:
    rejected = _safe_int(rejection_summary.get("rejected"))
    blocked = _safe_int(rejection_summary.get("blocked"))
    filled = _safe_int(rejection_summary.get("filled"))
    total = _safe_int(rejection_summary.get("total")) or rejected + blocked + filled
    ratio = _safe_float(rejection_summary.get("rejection_drag_ratio"))
    if ratio is None and total > 0:
        ratio = float(rejected + blocked) / float(total)
    drag_bps = round(float(ratio) * 10_000, 4) if ratio is not None else None
    if total <= 0 or ratio is None:
        return _source_record(
            proof_id=proof_id,
            hypothesis_id=hypothesis_id,
            account=account,
            window=window,
            source_class="rejection_drag",
            source_ref=rejection_summary.get("source_ref")
            or "scheduler:decision_state_total",
            freshness_state="missing",
            rows=total,
            rejection_drag_bps=drag_bps,
            decision="repair_only",
            blocking_reason_codes=["rejection_drag_unmeasured"],
        )
    decision: ProfitCapitalDecision = (
        "paper_candidate" if ratio < 0.5 else "repair_only"
    )
    reasons = ["rejection_drag_high"] if decision == "repair_only" else []
    return _source_record(
        proof_id=proof_id,
        hypothesis_id=hypothesis_id,
        account=account,
        window=window,
        source_class="rejection_drag",
        source_ref=rejection_summary.get("source_ref")
        or "scheduler:decision_state_total",
        freshness_state="current",
        rows=total,
        rejection_drag_bps=drag_bps,
        decision=decision,
        blocking_reason_codes=reasons,
    )


def _torghut_capital_lease_source(
    *,
    proof_id: str,
    hypothesis_id: str,
    account: str | None,
    window: str | None,
    dependency_quorum: Mapping[str, Any],
) -> dict[str, object]:
    decision = str(dependency_quorum.get("decision") or "").strip().lower() or "unknown"
    reasons = _string_list(dependency_quorum.get("reasons"))
    if decision == "allow":
        return _source_record(
            proof_id=proof_id,
            hypothesis_id=hypothesis_id,
            account=account,
            window=window,
            source_class="torghut_capital_lease",
            source_ref=dependency_quorum.get("source_ref"),
            observed_at=dependency_quorum.get("observed_at"),
            fresh_until=dependency_quorum.get("fresh_until"),
            freshness_state="current",
            decision="paper_candidate",
        )
    capital_hold = any("torghut_capital" in reason for reason in reasons)
    return _source_record(
        proof_id=proof_id,
        hypothesis_id=hypothesis_id,
        account=account,
        window=window,
        source_class="torghut_capital_lease",
        source_ref=dependency_quorum.get("source_ref"),
        observed_at=dependency_quorum.get("observed_at"),
        fresh_until=dependency_quorum.get("fresh_until"),
        freshness_state="blocked" if capital_hold or decision == "block" else "missing",
        decision="repair_only",
        blocking_reason_codes=reasons or [f"torghut_capital_lease_{decision}"],
    )


def _decision_from_sources(
    *,
    sources: Sequence[Mapping[str, object]],
    live_controls: Mapping[str, object],
    promotion_eligible: bool,
) -> ProfitCapitalDecision:
    source_decisions: list[ProfitCapitalDecision] = []
    for source in sources:
        decision = source.get("decision")
        if decision in _CAPITAL_DECISION_RANK:
            source_decisions.append(decision)
    if not promotion_eligible:
        return "repair_only"
    if any(source.get("freshness_state") == "blocked" for source in sources):
        return "repair_only"
    if any(
        source.get("freshness_state") in {"stale", "missing", "contradictory"}
        for source in sources
    ):
        return "repair_only"
    candidate_decisions: list[ProfitCapitalDecision] = [
        decision for decision in source_decisions if decision != "observe_only"
    ]
    proof_decision = _least_permissive_decision(candidate_decisions)
    if proof_decision != "paper_candidate":
        return proof_decision
    if (
        bool(live_controls.get("live_submission_enabled"))
        and bool(live_controls.get("rollback_ready"))
        and bool(live_controls.get("deployer_approved"))
    ):
        return "live_candidate"
    return "paper_candidate"


def _rehydration_lane(reason_codes: Sequence[str]) -> str:
    reasons = set(reason_codes)
    if any(reason.startswith("options_feature") for reason in reasons):
        return "options_data_readiness"
    if reasons & _EMPIRICAL_REPAIR_REASONS or any(
        reason.startswith(("job_stale:", "job_missing:", "job_ineligible:"))
        for reason in reasons
    ):
        return "empirical_replay"
    if reasons & _QUANT_METRICS_REASONS:
        return "quant_metrics_rebuild"
    if "rejection_drag_high" in reasons or "rejection_drag_unmeasured" in reasons:
        return "rejection_drag_repair"
    if any(reason.startswith("autoresearch_") for reason in reasons):
        return "autoresearch_promotion_repair"
    if any(reason.endswith("_empty") for reason in reasons):
        return "promotion_table_repair"
    if any(
        "torghut_capital_lease" in reason or "torghut_capital" in reason
        for reason in reasons
    ):
        return "torghut_capital_lease_reconcile"
    return "proof_repair"


def _source_reasons(sources: Sequence[Mapping[str, object]]) -> list[str]:
    reasons = [
        normalized
        for source in sources
        for raw_reason in cast(
            Sequence[object], source.get("blocking_reason_codes") or []
        )
        if (normalized := _safe_text(raw_reason)) is not None
    ]
    return sorted(set(reasons))


def build_profit_lease_projection(
    *,
    runtime_items: Sequence[Mapping[str, Any]],
    quant_evidence: Mapping[str, Any] | None,
    empirical_jobs_status: Mapping[str, Any] | None,
    dependency_quorum: Mapping[str, Any] | None,
    rejection_summary: Mapping[str, Any] | None = None,
    promotion_table_counts: Mapping[str, Any] | None = None,
    data_readiness: Mapping[str, Any] | None = None,
    live_controls: Mapping[str, object] | None = None,
    account: str | None = None,
    window: str | None = None,
    now: datetime | None = None,
) -> dict[str, object]:
    """Build a compact shadow projection for source-qualified profit leases."""

    generated_at = _ensure_aware(now or datetime.now(timezone.utc))
    fresh_until = generated_at + timedelta(minutes=15)
    quant = _as_mapping(quant_evidence)
    empirical = _as_mapping(empirical_jobs_status)
    quorum = _as_mapping(dependency_quorum)
    rejection = _as_mapping(rejection_summary)
    raw_promotion_counts = _as_mapping(promotion_table_counts)
    counts = {
        name: _safe_int(raw_promotion_counts.get(name))
        for name in _PROMOTION_TABLE_NAMES
    }
    promotion_evidence: dict[str, Any] = dict(counts)
    promotion_evidence["autoresearch_portfolio_ready_refs"] = _string_list(
        raw_promotion_counts.get("autoresearch_portfolio_ready_refs")
    )
    promotion_evidence["count_errors"] = _string_list(
        raw_promotion_counts.get("count_errors")
    )
    promotion_evidence["truncated_counts"] = _string_list(
        raw_promotion_counts.get("truncated_counts")
    )
    readiness = _as_mapping(data_readiness)
    controls = _as_mapping(live_controls)
    account_label = account or _safe_text(quant.get("account"))
    window_label = window or _safe_text(quant.get("window"))

    normalized_items = [
        _as_mapping(item)
        for item in runtime_items
        if _safe_text(item.get("hypothesis_id")) is not None
    ]
    if not normalized_items:
        normalized_items = [
            {
                "hypothesis_id": "runtime",
                "lane_id": "runtime",
                "strategy_family": "runtime",
                "promotion_eligible": False,
            }
        ]

    leases: list[dict[str, object]] = []
    source_records: list[dict[str, object]] = []
    for item in normalized_items:
        hypothesis_id = _safe_text(item.get("hypothesis_id")) or "runtime"
        lane_id = _safe_text(item.get("lane_id")) or hypothesis_id
        proof_id = f"tpp-{_stable_hash('torghut-profit-proof', {'hypothesis_id': hypothesis_id, 'account': account_label, 'window': window_label})}"
        promotion_eligible = bool(item.get("promotion_eligible"))
        expected_edge = _safe_float(
            item.get("expected_net_edge_bps") or item.get("expected_gross_edge_bps")
        )
        sources = [
            _data_readiness_source(
                proof_id=proof_id,
                hypothesis_id=hypothesis_id,
                account=account_label,
                window=window_label,
                item=item,
                data_readiness=readiness,
            ),
            _quant_source(
                proof_id=proof_id,
                hypothesis_id=hypothesis_id,
                account=account_label,
                window=window_label,
                quant_evidence=quant,
            ),
            _empirical_source(
                proof_id=proof_id,
                hypothesis_id=hypothesis_id,
                account=account_label,
                window=window_label,
                empirical_jobs_status=empirical,
            ),
            _promotion_source(
                proof_id=proof_id,
                hypothesis_id=hypothesis_id,
                account=account_label,
                window=window_label,
                item=item,
                promotion_table_counts=promotion_evidence,
            ),
            _rejection_source(
                proof_id=proof_id,
                hypothesis_id=hypothesis_id,
                account=account_label,
                window=window_label,
                rejection_summary=rejection,
            ),
            _torghut_capital_lease_source(
                proof_id=proof_id,
                hypothesis_id=hypothesis_id,
                account=account_label,
                window=window_label,
                dependency_quorum=quorum,
            ),
        ]
        if expected_edge is not None:
            for source in sources:
                source["expected_net_edge_bps"] = expected_edge
        source_records.extend(sources)
        reason_codes = _source_reasons(sources)
        if not promotion_eligible:
            reason_codes.append("hypothesis_not_promotion_eligible")
        reason_codes = sorted(set(reason_codes))
        source_states: list[ProfitProofState] = []
        for source in sources:
            freshness_state = source.get("freshness_state")
            if freshness_state in _BLOCKING_PROOF_STATE_RANK:
                source_states.append(freshness_state)
        proof_state = _most_blocking_state(source_states)
        capital_decision = _decision_from_sources(
            sources=sources,
            live_controls=controls,
            promotion_eligible=promotion_eligible,
        )
        lease_id = f"tpl-{_stable_hash('torghut-profit-lease', {'proof_id': proof_id, 'hypothesis_id': hypothesis_id, 'account': account_label, 'window': window_label, 'decision': capital_decision})}"
        leases.append(
            {
                "profit_lease_id": lease_id,
                "proof_id": proof_id,
                "hypothesis_id": hypothesis_id,
                "lane_id": lane_id,
                "strategy_family": item.get("strategy_family"),
                "account": account_label,
                "window": window_label,
                "generated_at": generated_at.isoformat(),
                "fresh_until": fresh_until.isoformat(),
                "proof_state": proof_state,
                "capital_decision": capital_decision,
                "blocking_reason_codes": reason_codes,
                "rehydration_lane": _rehydration_lane(reason_codes),
                "source_classes": [
                    str(source["source_class"])
                    for source in sources
                    if source.get("source_class")
                ],
                "source_proof_ids": [str(source["proof_id"]) for source in sources],
            }
        )

    decision_totals = Counter(str(lease["capital_decision"]) for lease in leases)
    proof_state_totals = Counter(str(lease["proof_state"]) for lease in leases)
    capital_allowed = any(
        lease.get("capital_decision") in {"paper_candidate", "live_candidate"}
        for lease in leases
    )
    compact_decision: ProfitCapitalDecision = (
        "live_candidate"
        if any(lease.get("capital_decision") == "live_candidate" for lease in leases)
        else "paper_candidate"
        if any(lease.get("capital_decision") == "paper_candidate" for lease in leases)
        else "repair_only"
        if any(lease.get("capital_decision") == "repair_only" for lease in leases)
        else "observe_only"
    )
    compact_reasons = sorted(
        {
            normalized
            for lease in leases
            for reason in cast(
                Sequence[object], lease.get("blocking_reason_codes") or []
            )
            if (normalized := _safe_text(reason)) is not None
        }
    )
    compact_states: list[ProfitProofState] = []
    for lease in leases:
        proof_state = lease.get("proof_state")
        if proof_state in _BLOCKING_PROOF_STATE_RANK:
            compact_states.append(proof_state)
    return {
        "schema_version": PROFIT_LEASE_PROJECTION_SCHEMA_VERSION,
        "generated_at": generated_at.isoformat(),
        "fresh_until": fresh_until.isoformat(),
        "account": account_label,
        "window": window_label,
        "leases": leases,
        "source_provenance": source_records,
        "torghut_capital": {
            "action_class": "torghut_capital",
            "allowed": capital_allowed,
            "capital_decision": compact_decision,
            "proof_state": _most_blocking_state(compact_states),
            "blocking_reason_codes": compact_reasons,
        },
        "summary": {
            "leases_total": len(leases),
            "decision_totals": dict(sorted(decision_totals.items())),
            "proof_state_totals": dict(sorted(proof_state_totals.items())),
            "promotion_table_counts": counts,
        },
    }


__all__ = [
    "PROFIT_LEASE_PROJECTION_SCHEMA_VERSION",
    "build_profit_lease_projection",
]
