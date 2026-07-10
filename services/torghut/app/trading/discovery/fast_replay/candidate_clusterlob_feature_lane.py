"""Preview-only vectorized scoring over manifest-verified replay tapes."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any


from app.trading.discovery.cluster_lob_features import (
    HPAIRS_CLUSTER_LOB_FEATURE_SCHEMA_VERSION,
)


def _candidate_clusterlob_feature_lane(
    *,
    requested_symbols: Sequence[str],
    feature_lane_by_symbol: Mapping[str, Mapping[str, Any]],
) -> dict[str, Any]:
    from .extract_price import (
        decimal_string_from_float as _decimal_string_from_float,
        float_or_none as _float_or_none,
        mapping as _mapping,
        string_tuple as _string_tuple,
        weighted_average as _weighted_average,
    )

    matched_symbols = tuple(
        symbol for symbol in requested_symbols if symbol in feature_lane_by_symbol
    )
    symbol_features = {
        symbol: dict(feature_lane_by_symbol[symbol]) for symbol in matched_symbols
    }
    row_counts = [
        int(_float_or_none(payload.get("row_count")) or 0.0)
        for payload in symbol_features.values()
    ]
    weights = [max(1, row_count) for row_count in row_counts]
    ranking_payloads = [
        _mapping(payload.get("ranking_features"))
        for payload in symbol_features.values()
    ]
    directional_alignment_score = _weighted_average(
        [
            (
                _float_or_none(ranking.get("directional_alignment_score")) or 0.0,
                weight,
            )
            for ranking, weight in zip(ranking_payloads, weights)
        ]
    )
    imbalance_abs_mean = _weighted_average(
        [
            (_float_or_none(ranking.get("imbalance_abs_mean")) or 0.0, weight)
            for ranking, weight in zip(ranking_payloads, weights)
        ]
    )
    cluster_entropy = _weighted_average(
        [
            (_float_or_none(ranking.get("cluster_entropy")) or 0.0, weight)
            for ranking, weight in zip(ranking_payloads, weights)
        ]
    )
    cluster_switch_rate = _weighted_average(
        [
            (_float_or_none(ranking.get("cluster_switch_rate")) or 0.0, weight)
            for ranking, weight in zip(ranking_payloads, weights)
        ]
    )
    event_taxonomy_coverage_ratio = _weighted_average(
        [
            (
                _float_or_none(ranking.get("event_taxonomy_coverage_ratio")) or 0.0,
                weight,
            )
            for ranking, weight in zip(ranking_payloads, weights)
        ]
    )
    event_mix_entropy = _weighted_average(
        [
            (_float_or_none(ranking.get("event_mix_entropy")) or 0.0, weight)
            for ranking, weight in zip(ranking_payloads, weights)
        ]
    )
    hawkes_time_rescaling_ks_proxy = _weighted_average(
        [
            (
                _float_or_none(ranking.get("hawkes_time_rescaling_ks_proxy")) or 0.0,
                weight,
            )
            for ranking, weight in zip(ranking_payloads, weights)
        ]
    )
    hawkes_nearly_unstable_branching_pressure = _weighted_average(
        [
            (
                _float_or_none(ranking.get("hawkes_nearly_unstable_branching_pressure"))
                or 0.0,
                weight,
            )
            for ranking, weight in zip(ranking_payloads, weights)
        ]
    )
    missing_penalty = _weighted_average(
        [
            (_float_or_none(ranking.get("missing_data_penalty")) or 0.0, weight)
            for ranking, weight in zip(ranking_payloads, weights)
        ]
    )
    preview_rank_feature_score = (
        abs(directional_alignment_score) * 18.0
        + imbalance_abs_mean * 10.0
        + cluster_entropy * 4.0
        + cluster_switch_rate * 2.0
        + event_mix_entropy * 2.0
        - (1.0 - event_taxonomy_coverage_ratio) * 3.0
        - hawkes_time_rescaling_ks_proxy * 4.0
        - hawkes_nearly_unstable_branching_pressure * 2.0
        - missing_penalty * 8.0
    )
    feature_schema_hashes = tuple(
        sorted(
            {
                str(payload.get("feature_schema_hash") or "")
                for payload in symbol_features.values()
                if str(payload.get("feature_schema_hash") or "")
            }
        )
    )
    warnings = tuple(
        sorted(
            {
                str(warning)
                for payload in symbol_features.values()
                for warning in _string_tuple(payload.get("warnings"))
            }
        )
    )
    return {
        "schema_version": "torghut.fast-replay-clusterlob-order-flow-feature-lane.v1",
        "feature_schema_version": HPAIRS_CLUSTER_LOB_FEATURE_SCHEMA_VERSION,
        "status": "preview_only_research_ranking",
        "matched_symbols": list(matched_symbols),
        "requested_symbols": list(requested_symbols),
        "matched_symbol_count": len(matched_symbols),
        "requested_symbol_count": len(requested_symbols),
        "row_count": sum(row_counts),
        "feature_schema_hashes": list(feature_schema_hashes),
        "warnings": list(warnings),
        "ranking_features": {
            "directional_alignment_score": _decimal_string_from_float(
                directional_alignment_score
            ),
            "imbalance_abs_mean": _decimal_string_from_float(imbalance_abs_mean),
            "cluster_entropy": _decimal_string_from_float(cluster_entropy),
            "cluster_switch_rate": _decimal_string_from_float(cluster_switch_rate),
            "event_taxonomy_coverage_ratio": _decimal_string_from_float(
                event_taxonomy_coverage_ratio
            ),
            "event_mix_entropy": _decimal_string_from_float(event_mix_entropy),
            "hawkes_time_rescaling_ks_proxy": _decimal_string_from_float(
                hawkes_time_rescaling_ks_proxy
            ),
            "hawkes_nearly_unstable_branching_pressure": (
                _decimal_string_from_float(hawkes_nearly_unstable_branching_pressure)
            ),
            "missing_data_penalty": _decimal_string_from_float(missing_penalty),
            "preview_rank_feature_score": _decimal_string_from_float(
                preview_rank_feature_score
            ),
        },
        "symbol_features": symbol_features,
        "resource_scope": "local_offline_replay_tape_or_fixture_rows_only",
        "research_ranking_only": True,
        "prefilter_only": True,
        "promotion_proof": False,
        "proof_authority": False,
        "promotion_authority": False,
        "promotion_allowed": False,
        "final_promotion_allowed": False,
        "final_authority_ok": False,
    }


def _clusterlob_feature_lane_manifest(
    *, feature_lane_by_symbol: Mapping[str, Mapping[str, Any]]
) -> dict[str, Any]:
    feature_schema_hashes = tuple(
        sorted(
            {
                str(payload.get("feature_schema_hash") or "")
                for payload in feature_lane_by_symbol.values()
                if str(payload.get("feature_schema_hash") or "")
            }
        )
    )
    return {
        "schema_version": "torghut.fast-replay-clusterlob-order-flow-feature-lane-manifest.v1",
        "feature_schema_version": HPAIRS_CLUSTER_LOB_FEATURE_SCHEMA_VERSION,
        "status": "preview_only_research_ranking",
        "symbol_count": len(feature_lane_by_symbol),
        "feature_schema_hashes": list(feature_schema_hashes),
        "resource_scope": "local_offline_replay_tape_or_fixture_rows_only",
        "research_ranking_only": True,
        "prefilter_only": True,
        "promotion_proof": False,
        "proof_authority": False,
        "promotion_authority": False,
        "promotion_allowed": False,
        "final_promotion_allowed": False,
        "final_authority_ok": False,
    }


def _clusterlob_feature_lane_score(
    payload: Mapping[str, Any], *, direction: float
) -> float:
    from .extract_price import (
        float_or_none as _float_or_none,
        mapping as _mapping,
    )

    ranking_features = _mapping(payload.get("ranking_features"))
    directional_alignment_score = (
        _float_or_none(ranking_features.get("directional_alignment_score")) or 0.0
    )
    imbalance_abs_mean = (
        _float_or_none(ranking_features.get("imbalance_abs_mean")) or 0.0
    )
    cluster_entropy = _float_or_none(ranking_features.get("cluster_entropy")) or 0.0
    cluster_switch_rate = (
        _float_or_none(ranking_features.get("cluster_switch_rate")) or 0.0
    )
    event_taxonomy_coverage_ratio = (
        _float_or_none(ranking_features.get("event_taxonomy_coverage_ratio")) or 0.0
    )
    event_mix_entropy = _float_or_none(ranking_features.get("event_mix_entropy")) or 0.0
    hawkes_time_rescaling_ks_proxy = (
        _float_or_none(ranking_features.get("hawkes_time_rescaling_ks_proxy")) or 0.0
    )
    hawkes_nearly_unstable_branching_pressure = (
        _float_or_none(
            ranking_features.get("hawkes_nearly_unstable_branching_pressure")
        )
        or 0.0
    )
    missing_penalty = (
        _float_or_none(ranking_features.get("missing_data_penalty")) or 0.0
    )
    return (
        direction * directional_alignment_score * 30.0
        + imbalance_abs_mean * 8.0
        + cluster_entropy * 3.0
        + cluster_switch_rate * 2.0
        + event_mix_entropy * 1.5
        - (1.0 - event_taxonomy_coverage_ratio) * 2.0
        - hawkes_time_rescaling_ks_proxy * 3.0
        - hawkes_nearly_unstable_branching_pressure * 2.0
        - missing_penalty * 12.0
    )


# Public aliases used by split-module consumers.
candidate_clusterlob_feature_lane = _candidate_clusterlob_feature_lane
clusterlob_feature_lane_manifest = _clusterlob_feature_lane_manifest
clusterlob_feature_lane_score = _clusterlob_feature_lane_score

__all__ = (
    "candidate_clusterlob_feature_lane",
    "clusterlob_feature_lane_manifest",
    "clusterlob_feature_lane_score",
)
