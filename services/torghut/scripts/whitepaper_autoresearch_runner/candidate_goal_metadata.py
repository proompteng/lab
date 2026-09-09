#!/usr/bin/env python3
"""Run a whitepaper-driven autoresearch epoch targeting a portfolio profit objective."""

from __future__ import annotations

from typing import Any, Mapping, Sequence, cast


from app.trading.discovery.candidate_specs import (
    CandidateSpec,
)
from app.trading.discovery.evidence_bundles import (
    CandidateEvidenceBundle,
)
from app.trading.discovery.portfolio_optimizer import (
    PortfolioCandidateSpec,
)


from scripts.whitepaper_autoresearch_runner.candidate_board_fields import (
    _candidate_board_int_field,
    _candidate_board_first_int_field,
)
from scripts.whitepaper_autoresearch_runner.candidate_board_runtime_windows import (
    _candidate_board_runtime_window_bounds,
    _candidate_board_exact_replay_ledger_refs,
)
from scripts.whitepaper_autoresearch_runner.candidate_board_summaries import (
    _candidate_board_order_type_execution_quality_summary,
    _candidate_board_queue_position_survival_summary,
    _candidate_board_evidence_lineage_summary,
    _candidate_board_replay_window_coverage_summary,
    _candidate_board_market_impact_proof_summary,
    _candidate_board_regime_specialist_summary,
)
from scripts.whitepaper_autoresearch_runner.common import (
    _decimal,
    _string,
    _list_of_mappings,
    _rank_sort_value,
    _string_list_from_value,
    _candidate_board_runtime_ledger_lineage_handoff,
    _candidate_board_runtime_ledger_required_materialized_artifacts,
    _boolish,
)

from scripts.whitepaper_autoresearch_runner.candidate_prior_scoring import (
    _candidate_spec_mechanism_overlay_ids,
    _candidate_spec_required_evidence_tokens,
    _paper_mechanism_prior_score,
)


def _selected_candidate_spec_ids(
    candidate_selection: Mapping[str, Any],
) -> set[str]:
    explicit_ids = set(
        _string_list_from_value(candidate_selection.get("selected_candidate_spec_ids"))
    )
    selected_rows = {
        _string(row.get("candidate_spec_id"))
        for row in _list_of_mappings(candidate_selection.get("rows"))
        if bool(row.get("selected_for_replay"))
        and _string(row.get("candidate_spec_id"))
    }
    return explicit_ids | selected_rows


def _candidate_family_goal_rows(
    *,
    candidate_specs: Sequence[CandidateSpec],
    candidate_selection: Mapping[str, Any],
    evidence_bundles: Sequence[CandidateEvidenceBundle],
) -> list[dict[str, Any]]:
    selected_ids = _selected_candidate_spec_ids(candidate_selection)
    evidence_by_spec = {bundle.candidate_spec_id: bundle for bundle in evidence_bundles}
    rows_by_family: dict[str, dict[str, Any]] = {}
    for spec in candidate_specs:
        family_id = spec.family_template_id
        row = rows_by_family.setdefault(
            family_id,
            {
                "family_template_id": family_id,
                "runtime_families": set(),
                "runtime_strategy_names": set(),
                "candidate_spec_count": 0,
                "selected_for_replay_count": 0,
                "evidence_bundle_count": 0,
                "sample_candidate_spec_ids": [],
                "sample_selected_candidate_spec_ids": [],
            },
        )
        row["candidate_spec_count"] = int(row["candidate_spec_count"]) + 1
        cast(set[str], row["runtime_families"]).add(spec.runtime_family)
        cast(set[str], row["runtime_strategy_names"]).add(spec.runtime_strategy_name)
        if len(cast(list[str], row["sample_candidate_spec_ids"])) < 3:
            cast(list[str], row["sample_candidate_spec_ids"]).append(
                spec.candidate_spec_id
            )
        if spec.candidate_spec_id in selected_ids:
            row["selected_for_replay_count"] = int(row["selected_for_replay_count"]) + 1
            if len(cast(list[str], row["sample_selected_candidate_spec_ids"])) < 3:
                cast(list[str], row["sample_selected_candidate_spec_ids"]).append(
                    spec.candidate_spec_id
                )
        if spec.candidate_spec_id in evidence_by_spec:
            row["evidence_bundle_count"] = int(row["evidence_bundle_count"]) + 1

    payload_rows: list[dict[str, Any]] = []
    for row in rows_by_family.values():
        payload_rows.append(
            {
                **row,
                "runtime_families": sorted(cast(set[str], row["runtime_families"])),
                "runtime_strategy_names": sorted(
                    cast(set[str], row["runtime_strategy_names"])
                ),
            }
        )
    payload_rows.sort(
        key=lambda row: (
            -int(row.get("selected_for_replay_count") or 0),
            -int(row.get("candidate_spec_count") or 0),
            _string(row.get("family_template_id")),
        )
    )
    return payload_rows


def _candidate_sleeve_goal_proof_handoff_fields(
    *,
    selection: Mapping[str, Any],
    spec: CandidateSpec | None,
    scorecard: Mapping[str, Any],
    evidence: CandidateEvidenceBundle | None,
    selected_for_replay: bool,
) -> dict[str, Any]:
    artifact_refs = list(evidence.replay_artifact_refs) if evidence is not None else []
    runtime_ledger_row = {**dict(scorecard), "replay_artifact_refs": artifact_refs}
    exact_replay_ledger_artifact_refs = _candidate_board_exact_replay_ledger_refs(
        runtime_ledger_row
    )
    exact_replay_ledger_artifact_ref = _string(
        scorecard.get("exact_replay_ledger_artifact_ref")
    )
    if not exact_replay_ledger_artifact_ref and exact_replay_ledger_artifact_refs:
        exact_replay_ledger_artifact_ref = exact_replay_ledger_artifact_refs[0]
    runtime_window_start, runtime_window_end = _candidate_board_runtime_window_bounds(
        scorecard
    )
    paper_contract_prior_score = _string(selection.get("paper_contract_prior_score"))
    if not paper_contract_prior_score and spec is not None:
        paper_contract_prior_score = str(_paper_mechanism_prior_score(spec))
    paper_mechanism_overlay_ids = _string_list_from_value(
        selection.get("paper_mechanism_overlay_ids")
    )
    if not paper_mechanism_overlay_ids and spec is not None:
        paper_mechanism_overlay_ids = sorted(
            _candidate_spec_mechanism_overlay_ids(spec)
        )
    paper_required_evidence_tokens = _string_list_from_value(
        selection.get("paper_required_evidence_tokens")
    )
    if not paper_required_evidence_tokens and spec is not None:
        paper_required_evidence_tokens = sorted(
            _candidate_spec_required_evidence_tokens(spec)
        )
    paper_required_evidence_count = _candidate_board_int_field(
        selection, "paper_required_evidence_count"
    )
    if paper_required_evidence_count <= 0:
        paper_required_evidence_count = len(paper_required_evidence_tokens)
    paper_contract_candidate = bool(
        _decimal(paper_contract_prior_score) > 0
        or paper_mechanism_overlay_ids
        or paper_required_evidence_tokens
    )
    runtime_ledger_lineage_handoff = _candidate_board_runtime_ledger_lineage_handoff(
        scorecard=scorecard,
        evidence=evidence,
    )
    runtime_ledger_required_materialized_artifacts = (
        _candidate_board_runtime_ledger_required_materialized_artifacts(
            runtime_ledger_lineage_handoff
        )
    )
    proof_handoff: dict[str, Any] = {
        "replay_selection_reason": _string(selection.get("selection_reason"))
        or ("selected_for_replay" if selected_for_replay else "not_selected_budget"),
        "paper_contract_candidate": paper_contract_candidate,
        "paper_contract_selected_for_replay": bool(
            selected_for_replay and paper_contract_candidate
        ),
        "paper_contract_prior_score": paper_contract_prior_score,
        "paper_mechanism_overlay_ids": paper_mechanism_overlay_ids,
        "paper_required_evidence_tokens": paper_required_evidence_tokens,
        "paper_required_evidence_count": paper_required_evidence_count,
        "runtime_window_start": runtime_window_start,
        "runtime_window_end": runtime_window_end,
        "exact_replay_ledger_artifact_refs": list(exact_replay_ledger_artifact_refs),
        "exact_replay_ledger_artifact_ref": exact_replay_ledger_artifact_ref,
        "exact_replay_ledger_artifact_row_count": _candidate_board_first_int_field(
            scorecard,
            ("exact_replay_ledger_artifact_row_count",),
        ),
        "exact_replay_ledger_artifact_fill_count": _candidate_board_first_int_field(
            scorecard,
            ("exact_replay_ledger_artifact_fill_count",),
        ),
    }
    if runtime_ledger_lineage_handoff:
        proof_handoff["runtime_ledger_lineage_materialization_handoff"] = dict(
            runtime_ledger_lineage_handoff
        )
        proof_handoff["runtime_ledger_required_materialized_artifacts"] = (
            runtime_ledger_required_materialized_artifacts
        )
        materialization_status = _string(
            runtime_ledger_lineage_handoff.get("materialization_status")
            or runtime_ledger_lineage_handoff.get("status")
        )
        if materialization_status:
            proof_handoff["runtime_ledger_materialization_status"] = (
                materialization_status
            )
        if _boolish(
            runtime_ledger_lineage_handoff.get(
                "zero_authoritative_daily_pnl_until_materialized"
            )
        ):
            proof_handoff["zero_authoritative_daily_pnl_until_materialized"] = True
    return proof_handoff


def _candidate_sleeve_goal_rows(
    *,
    candidate_specs: Sequence[CandidateSpec],
    candidate_selection: Mapping[str, Any],
    evidence_bundles: Sequence[CandidateEvidenceBundle],
    false_positive_table: Sequence[Mapping[str, Any]],
    best_false_negative_table: Sequence[Mapping[str, Any]],
    portfolio: PortfolioCandidateSpec | None,
    limit: int = 16,
) -> list[dict[str, Any]]:
    spec_by_id = {spec.candidate_spec_id: spec for spec in candidate_specs}
    evidence_by_spec = {bundle.candidate_spec_id: bundle for bundle in evidence_bundles}
    selection_by_spec = {
        _string(row.get("candidate_spec_id")): row
        for row in _list_of_mappings(candidate_selection.get("rows"))
        if _string(row.get("candidate_spec_id"))
    }
    if portfolio is not None:
        rows: list[dict[str, Any]] = []
        for sleeve in portfolio.sleeves[:limit]:
            row = dict(sleeve)
            candidate_spec_id = _string(row.get("candidate_spec_id"))
            spec = spec_by_id.get(candidate_spec_id)
            evidence = evidence_by_spec.get(candidate_spec_id)
            scorecard = evidence.objective_scorecard if evidence is not None else {}
            selection = selection_by_spec.get(candidate_spec_id, {})
            if spec is not None:
                row["family_template_id"] = spec.family_template_id
                row["runtime_family"] = spec.runtime_family
                row["runtime_strategy_name"] = spec.runtime_strategy_name
                row["market_impact_proof"] = (
                    _candidate_board_market_impact_proof_summary(scorecard)
                )
                row["regime_specialist_validation"] = (
                    _candidate_board_regime_specialist_summary(spec, scorecard)
                )
                row["order_type_execution_quality"] = (
                    _candidate_board_order_type_execution_quality_summary(
                        spec, scorecard
                    )
                )
                row["queue_position_survival_fill_quality"] = (
                    _candidate_board_queue_position_survival_summary(spec, scorecard)
                )
            row["evidence_status"] = "replayed" if evidence is not None else "missing"
            row["evidence_lineage"] = _candidate_board_evidence_lineage_summary(
                evidence
            )
            row["replay_window_coverage"] = (
                _candidate_board_replay_window_coverage_summary(scorecard)
            )
            row["replay_artifact_refs"] = (
                list(evidence.replay_artifact_refs) if evidence is not None else []
            )
            row.update(
                _candidate_sleeve_goal_proof_handoff_fields(
                    selection=selection,
                    spec=spec,
                    scorecard=scorecard,
                    evidence=evidence,
                    selected_for_replay=True,
                )
            )
            rows.append(row)
        return rows

    failure_by_spec = {
        _string(row.get("candidate_spec_id")): list(
            cast(Sequence[Any], row.get("failure_reasons") or ())
        )
        for row in _list_of_mappings(list(false_positive_table))
        if _string(row.get("candidate_spec_id"))
    }
    rows: list[dict[str, Any]] = []
    for selection in _list_of_mappings(candidate_selection.get("rows")):
        candidate_spec_id = _string(selection.get("candidate_spec_id"))
        if not candidate_spec_id or not bool(selection.get("selected_for_replay")):
            continue
        spec = spec_by_id.get(candidate_spec_id)
        evidence = evidence_by_spec.get(candidate_spec_id)
        scorecard = evidence.objective_scorecard if evidence is not None else {}
        order_type_summary = (
            _candidate_board_order_type_execution_quality_summary(spec, scorecard)
            if spec is not None
            else {"required": False, "passed": True, "blockers": []}
        )
        queue_position_survival_summary = (
            _candidate_board_queue_position_survival_summary(spec, scorecard)
            if spec is not None
            else {"required": False, "passed": True, "blockers": []}
        )
        evidence_lineage = _candidate_board_evidence_lineage_summary(evidence)
        replay_window_coverage = _candidate_board_replay_window_coverage_summary(
            scorecard
        )
        proof_handoff = _candidate_sleeve_goal_proof_handoff_fields(
            selection=selection,
            spec=spec,
            scorecard=scorecard,
            evidence=evidence,
            selected_for_replay=True,
        )
        rows.append(
            {
                "candidate_spec_id": candidate_spec_id,
                "candidate_id": evidence.candidate_id if evidence is not None else None,
                "family_template_id": spec.family_template_id
                if spec is not None
                else None,
                "runtime_family": spec.runtime_family if spec is not None else None,
                "runtime_strategy_name": spec.runtime_strategy_name
                if spec is not None
                else None,
                "rank": _rank_sort_value(selection.get("rank")),
                "pre_replay_score": _string(selection.get("pre_replay_score")),
                "evidence_status": "replayed" if evidence is not None else "missing",
                "net_pnl_per_day": _string(scorecard.get("net_pnl_per_day")),
                "active_day_ratio": _string(scorecard.get("active_day_ratio")),
                "positive_day_ratio": _string(scorecard.get("positive_day_ratio")),
                "replay_artifact_refs": list(evidence.replay_artifact_refs)
                if evidence is not None
                else [],
                "evidence_lineage": evidence_lineage,
                "replay_window_coverage": replay_window_coverage,
                "order_type_execution_quality": order_type_summary,
                "queue_position_survival_fill_quality": (
                    queue_position_survival_summary
                ),
                **proof_handoff,
                "failure_reasons": [
                    _string(item)
                    for item in failure_by_spec.get(candidate_spec_id, ())
                    if _string(item)
                ],
            }
        )
        if len(rows) >= limit:
            break

    if len(rows) < limit:
        for row in _list_of_mappings(list(best_false_negative_table)):
            candidate_spec_id = _string(row.get("candidate_spec_id"))
            if not candidate_spec_id:
                continue
            spec = spec_by_id.get(candidate_spec_id)
            selection = selection_by_spec.get(candidate_spec_id, row)
            rows.append(
                {
                    "candidate_spec_id": candidate_spec_id,
                    "candidate_id": None,
                    "family_template_id": spec.family_template_id
                    if spec is not None
                    else None,
                    "runtime_family": spec.runtime_family if spec is not None else None,
                    "runtime_strategy_name": spec.runtime_strategy_name
                    if spec is not None
                    else None,
                    "rank": _rank_sort_value(row.get("rank")),
                    "pre_replay_score": _string(row.get("pre_replay_score")),
                    "evidence_status": "not_replayed",
                    "reason": _string(row.get("reason")) or "not_replayed_budget",
                    **_candidate_sleeve_goal_proof_handoff_fields(
                        selection=selection,
                        spec=spec,
                        scorecard={},
                        evidence=None,
                        selected_for_replay=False,
                    ),
                    "failure_reasons": ["not_replayed_budget"],
                }
            )
            if len(rows) >= limit:
                break
    return rows


__all__ = [
    "_selected_candidate_spec_ids",
    "_candidate_family_goal_rows",
    "_candidate_sleeve_goal_proof_handoff_fields",
    "_candidate_sleeve_goal_rows",
]
