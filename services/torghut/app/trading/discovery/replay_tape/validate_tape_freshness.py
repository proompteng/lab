"""Manifest-verified replay tape artifacts for Torghut research replays."""

from __future__ import annotations

import json
from collections.abc import Iterable, Mapping, Sequence
from datetime import date, timezone
from decimal import Decimal
from typing import Any, cast

from app.trading.models import SignalEnvelope


from .shared_context import (
    HPAIRS_OFI_MEMORY_REGIME_SCHEMA_VERSION,
    HPAIRS_REPLAY_TAPE_FEATURE_SCHEMA_VERSION,
    REPLAY_TAPE_SCHEMA_VERSION,
    ReplayTapeManifest,
    bounded_decimal as _bounded_decimal,
    business_days as _business_days,
    coverage_status as _coverage_status,
    decimal_or_none as _decimal_or_none,
    decimal_text as _decimal_text,
    decode_value as _decode_value,
    encode_value as _encode_value,
    first_decimal_with_key as _first_decimal_with_key,
    first_text as _first_text,
    hpairs_capacity_notional_lineage as _hpairs_capacity_notional_lineage,
    mean_decimal as _mean_decimal,
    missing_symbol_trading_days as _missing_symbol_trading_days,
    normalize_symbols as _normalize_symbols,
    parse_datetime as _parse_datetime,
    signal_sort_key as _signal_sort_key,
    stress_tag_tuple as _stress_tag_tuple,
    string_mapping as _string_mapping,
    symbol_day_entry_in_window as _symbol_day_entry_in_window,
    tag_tuple as _tag_tuple,
    build_hpairs_replay_tape_feature_schema_hash,
    build_replay_tape_cache_key,
)


def validate_tape_freshness(
    manifest: ReplayTapeManifest,
    *,
    start_date: date,
    end_date: date,
    symbols: Sequence[str] = (),
    allow_stale_tape: bool = False,
    require_point_in_time_receipt: bool = False,
    require_exact_cache_identity: bool = False,
    expected_dataset_snapshot_ref: str | None = None,
    expected_source_query_digest: str | None = None,
    expected_feature_schema_hash: str | None = None,
    expected_cost_model_hash: str | None = None,
    expected_strategy_family: str | None = None,
    expected_replay_cache_key: str | None = None,
    expected_feature_versions: Mapping[str, str] | None = None,
    expected_source_table_versions: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    reasons: list[str] = []
    if require_point_in_time_receipt and manifest.point_in_time_receipt is None:
        raise ValueError("replay_tape_point_in_time_receipt_required")
    if manifest.start_date > start_date or manifest.end_date < end_date:
        reasons.append(
            "window_not_covered:"
            f"{manifest.start_date.isoformat()}..{manifest.end_date.isoformat()}"
            f"<{start_date.isoformat()}..{end_date.isoformat()}"
        )

    requested_symbols = set(_normalize_symbols(symbols))
    coverage_symbols = set(manifest.symbols or manifest.row_symbols)
    if requested_symbols:
        missing = sorted(requested_symbols - coverage_symbols)
        if missing:
            reasons.append(f"symbols_not_covered:{','.join(missing)}")

    missing_trading_days = tuple(
        day for day in manifest.missing_trading_days if start_date <= day <= end_date
    )
    if missing_trading_days:
        reasons.append(
            "trading_days_missing:"
            + ",".join(day.isoformat() for day in missing_trading_days)
        )

    requested_trading_days = _business_days(start_date, end_date)
    observed_day_set = {
        day for day in manifest.observed_trading_days if start_date <= day <= end_date
    }
    for raw_day, raw_count in manifest.row_count_by_trading_day.items():
        try:
            day = date.fromisoformat(str(raw_day))
        except ValueError:
            continue
        if start_date <= day <= end_date and int(raw_count or 0) > 0:
            observed_day_set.add(day)
    observed_trading_days = tuple(sorted(observed_day_set))
    missing_symbol_entries = set(
        entry
        for entry in manifest.missing_symbol_trading_days
        if _symbol_day_entry_in_window(
            entry,
            start_date=start_date,
            end_date=end_date,
            requested_symbols=requested_symbols,
        )
    )
    missing_symbol_entries.update(
        _missing_symbol_trading_days(
            row_count_by_symbol_trading_day=manifest.row_count_by_symbol_trading_day,
            requested_symbols=tuple(sorted(requested_symbols)),
            requested_trading_days=requested_trading_days,
            observed_trading_days=observed_trading_days,
        )
    )
    missing_symbol_trading_days = tuple(sorted(missing_symbol_entries))
    if missing_symbol_trading_days:
        reasons.append(
            "symbol_trading_days_missing:" + ",".join(missing_symbol_trading_days)
        )

    cache_identity_reasons = _replay_tape_cache_identity_mismatch_reasons(
        manifest,
        start_date=start_date,
        end_date=end_date,
        symbols=tuple(sorted(requested_symbols)),
        require_exact_cache_identity=require_exact_cache_identity,
        expected_dataset_snapshot_ref=expected_dataset_snapshot_ref,
        expected_source_query_digest=expected_source_query_digest,
        expected_feature_schema_hash=expected_feature_schema_hash,
        expected_cost_model_hash=expected_cost_model_hash,
        expected_strategy_family=expected_strategy_family,
        expected_replay_cache_key=expected_replay_cache_key,
        expected_feature_versions=expected_feature_versions,
        expected_source_table_versions=expected_source_table_versions,
    )
    if cache_identity_reasons:
        raise ValueError(
            "replay_tape_cache_identity_mismatch:" + ";".join(cache_identity_reasons)
        )

    if reasons and not allow_stale_tape:
        raise ValueError(f"replay_tape_stale:{';'.join(reasons)}")
    point_in_time_receipt = manifest.point_in_time_receipt
    return {
        "schema_version": "torghut.replay-tape-validation.v1",
        "status": "stale_override" if reasons else "valid",
        "reasons": reasons,
        "stale_override_used": bool(reasons),
        "content_sha256": manifest.content_sha256,
        "dataset_snapshot_ref": manifest.dataset_snapshot_ref,
        "source_query_digest": manifest.source_query_digest,
        "source_table_versions": dict(manifest.source_table_versions),
        "feature_schema_hash": manifest.feature_schema_hash,
        "cost_model_hash": manifest.cost_model_hash,
        "strategy_family": manifest.strategy_family,
        "feature_versions": dict(manifest.feature_versions),
        "replay_cache_key": manifest.replay_cache_key,
        "cache_identity": manifest.cache_identity_diagnostics(),
        "point_in_time_receipt": (
            {
                "status": "verified_on_load",
                "receipt_sha256": point_in_time_receipt.receipt_sha256,
                "observation_cutoff": point_in_time_receipt.observation_cutoff.isoformat(),
                "input_row_set_sha256": point_in_time_receipt.input_row_set_sha256,
                "feature_matrix_sha256": point_in_time_receipt.feature_matrix_sha256,
            }
            if point_in_time_receipt is not None
            else {"status": "missing"}
        ),
        "row_count": manifest.row_count,
        "trading_day_count": manifest.trading_day_count,
        "requested_symbols": sorted(requested_symbols),
        "requested_trading_days": [
            item.isoformat() for item in manifest.requested_trading_days
        ],
        "observed_trading_days": [
            item.isoformat() for item in manifest.observed_trading_days
        ],
        "missing_trading_days": [item.isoformat() for item in missing_trading_days],
        "row_count_by_trading_day": dict(manifest.row_count_by_trading_day),
        "missing_symbol_trading_days": list(missing_symbol_trading_days),
        "row_count_by_symbol_trading_day": {
            symbol: dict(days)
            for symbol, days in manifest.row_count_by_symbol_trading_day.items()
        },
        "coverage_status": _coverage_status(
            missing_trading_days=missing_trading_days,
            missing_symbol_trading_days=missing_symbol_trading_days,
        ),
    }


def _replay_tape_cache_identity_mismatch_reasons(
    manifest: ReplayTapeManifest,
    *,
    start_date: date,
    end_date: date,
    symbols: Sequence[str],
    require_exact_cache_identity: bool,
    expected_dataset_snapshot_ref: str | None,
    expected_source_query_digest: str | None,
    expected_feature_schema_hash: str | None,
    expected_cost_model_hash: str | None,
    expected_strategy_family: str | None,
    expected_replay_cache_key: str | None,
    expected_feature_versions: Mapping[str, str] | None,
    expected_source_table_versions: Mapping[str, str] | None,
) -> list[str]:
    reasons: list[str] = []
    requested_symbols = _normalize_symbols(symbols)

    if require_exact_cache_identity:
        diagnostics = manifest.cache_identity_diagnostics()
        raw_missing_components = diagnostics.get("missing_components", ())
        missing_component_values: Sequence[Any] = ()
        if isinstance(raw_missing_components, Sequence) and not isinstance(
            raw_missing_components, (str, bytes, bytearray)
        ):
            missing_component_values = cast(Sequence[Any], raw_missing_components)
        missing_components = tuple(
            str(component) for component in missing_component_values if str(component)
        )
        if missing_components:
            reasons.append("missing_components:" + ",".join(sorted(missing_components)))
        if manifest.start_date != start_date or manifest.end_date != end_date:
            reasons.append(
                "date_range:"
                f"{manifest.start_date.isoformat()}..{manifest.end_date.isoformat()}"
                f"!={start_date.isoformat()}..{end_date.isoformat()}"
            )
        if requested_symbols and tuple(manifest.symbols) != requested_symbols:
            reasons.append(
                "symbol_universe:"
                f"{','.join(manifest.symbols)}!={','.join(requested_symbols)}"
            )
        recomputed_cache_key = build_replay_tape_cache_key(
            dataset_snapshot_ref=manifest.dataset_snapshot_ref,
            symbols=manifest.symbols,
            start_date=manifest.start_date,
            end_date=manifest.end_date,
            source_query_digest=manifest.source_query_digest,
            feature_schema_hash=manifest.feature_schema_hash,
            cost_model_hash=manifest.cost_model_hash,
            strategy_family=manifest.strategy_family,
            feature_versions=manifest.feature_versions,
            source_table_versions=manifest.source_table_versions,
        )
        if manifest.replay_cache_key != recomputed_cache_key:
            reasons.append(
                f"replay_cache_key:{manifest.replay_cache_key}!={recomputed_cache_key}"
            )

    def append_string_mismatch(
        component: str,
        observed: str,
        expected: str | None,
    ) -> None:
        if expected is None:
            return
        expected_value = str(expected or "")
        if str(observed or "") != expected_value:
            reasons.append(f"{component}:{observed}!={expected_value}")

    append_string_mismatch(
        "dataset_snapshot_ref",
        manifest.dataset_snapshot_ref,
        expected_dataset_snapshot_ref,
    )
    append_string_mismatch(
        "source_query_digest",
        manifest.source_query_digest,
        expected_source_query_digest,
    )
    append_string_mismatch(
        "feature_schema_hash",
        manifest.feature_schema_hash,
        expected_feature_schema_hash,
    )
    append_string_mismatch(
        "cost_model_hash",
        manifest.cost_model_hash,
        expected_cost_model_hash,
    )
    append_string_mismatch(
        "strategy_family",
        manifest.strategy_family,
        expected_strategy_family,
    )
    append_string_mismatch(
        "replay_cache_key",
        manifest.replay_cache_key,
        expected_replay_cache_key,
    )

    if expected_feature_versions is not None:
        expected_versions = _string_mapping(expected_feature_versions)
        if dict(manifest.feature_versions) != expected_versions:
            reasons.append(
                "feature_versions:"
                f"{dict(manifest.feature_versions)}!={expected_versions}"
            )
    if expected_source_table_versions is not None:
        expected_table_versions = dict(expected_source_table_versions)
        if dict(manifest.source_table_versions) != expected_table_versions:
            reasons.append(
                "source_table_versions:"
                f"{dict(manifest.source_table_versions)}!={expected_table_versions}"
            )
    return reasons


def slice_tape_by_window(
    rows: Iterable[SignalEnvelope],
    *,
    start_date: date,
    end_date: date,
) -> tuple[SignalEnvelope, ...]:
    selected = (
        row
        for row in rows
        if start_date <= row.event_ts.astimezone(timezone.utc).date() <= end_date
    )
    return tuple(sorted(selected, key=_signal_sort_key))


def slice_tape_by_symbols(
    rows: Iterable[SignalEnvelope],
    *,
    symbols: Sequence[str] = (),
) -> tuple[SignalEnvelope, ...]:
    selected_symbols = set(_normalize_symbols(symbols))
    if not selected_symbols:
        return tuple(sorted(rows, key=_signal_sort_key))
    selected = (row for row in rows if row.symbol.upper() in selected_symbols)
    return tuple(sorted(selected, key=_signal_sort_key))


def signal_to_tape_payload(signal: SignalEnvelope) -> dict[str, Any]:
    return {
        "schema_version": REPLAY_TAPE_SCHEMA_VERSION,
        "event_ts": signal.event_ts.astimezone(timezone.utc).isoformat(),
        "symbol": signal.symbol,
        "payload": _encode_value(signal.payload),
        "hpairs_features": _encode_value(hpairs_replay_tape_features(signal)),
        "timeframe": signal.timeframe,
        "ingest_ts": signal.ingest_ts.astimezone(timezone.utc).isoformat()
        if signal.ingest_ts is not None
        else None,
        "seq": signal.seq,
        "source": signal.source,
    }


def signal_from_tape_payload(payload: Mapping[str, Any]) -> SignalEnvelope:
    schema_version = str(payload.get("schema_version") or "")
    if schema_version != REPLAY_TAPE_SCHEMA_VERSION:
        raise ValueError(f"replay_tape_row_schema_invalid:{schema_version}")
    ingest_ts = payload.get("ingest_ts")
    decoded_signal_payload = _decode_value(payload.get("payload") or {})
    signal_payload: dict[str, Any] = (
        dict(cast(Mapping[str, Any], decoded_signal_payload))
        if isinstance(decoded_signal_payload, Mapping)
        else {}
    )
    hpairs_features = _decode_value(payload.get("hpairs_features") or {})
    if (
        isinstance(hpairs_features, Mapping)
        and hpairs_features
        and "hpairs_replay_tape_features" not in signal_payload
    ):
        signal_payload["hpairs_replay_tape_features"] = dict(
            cast(Mapping[str, Any], hpairs_features)
        )
    return SignalEnvelope(
        event_ts=_parse_datetime(str(payload["event_ts"])),
        symbol=str(payload["symbol"]),
        payload=signal_payload,
        timeframe=str(payload["timeframe"]) if payload.get("timeframe") else None,
        ingest_ts=_parse_datetime(str(ingest_ts)) if ingest_ts else None,
        seq=int(payload["seq"]) if payload.get("seq") is not None else None,
        source=str(payload["source"]) if payload.get("source") else None,
    )


def hpairs_replay_tape_features(signal: SignalEnvelope) -> dict[str, Any]:
    """Normalize H-PAIRS discovery features carried by a replay-tape row.

    The representation is deliberately metadata-only: it preserves ClusterLOB/
    OFI-style inputs for deterministic offline candidate narrowing, but marks
    every row as prefilter-only so a downstream consumer cannot treat it as
    runtime-ledger proof or promotion authority.
    """

    payload = signal.payload
    source_fields: set[str] = set()
    horizon_ofi = _hpairs_ofi_horizons(payload, source_fields=source_fields)
    decay_memory = _hpairs_ofi_decay_memory(payload, source_fields=source_fields)
    regime_tags = _tag_tuple(
        payload,
        ("regime_tags", "regime_tag", "market_regime", "liquidity_regime"),
        source_fields=source_fields,
    )
    stress_tags = _stress_tag_tuple(payload, source_fields=source_fields)
    cluster_lob = _hpairs_cluster_lob_payload(payload, source_fields=source_fields)
    ofi_memory_regime_slices = _hpairs_ofi_memory_regime_slices(
        horizon_ofi=horizon_ofi,
        decay_memory=decay_memory,
        regime_tags=regime_tags,
        stress_tags=stress_tags,
    )
    capacity_notional_lineage = _hpairs_capacity_notional_lineage(
        payload,
        source_fields=source_fields,
    )
    return {
        "schema_version": HPAIRS_REPLAY_TAPE_FEATURE_SCHEMA_VERSION,
        "feature_schema_hash": build_hpairs_replay_tape_feature_schema_hash(),
        "order_flow_imbalance_horizons": horizon_ofi,
        "ofi_decay_memory": decay_memory,
        "ofi_memory_regime_slices": ofi_memory_regime_slices,
        "cluster_lob": cluster_lob,
        "regime_tags": list(regime_tags),
        "stress_tags": list(stress_tags),
        "capacity_notional_lineage": capacity_notional_lineage,
        "source_fields": sorted(source_fields),
        "prefilter_only": True,
        "promotion_proof": False,
        "proof_authority": False,
        "promotion_authority": False,
        "promotion_allowed": False,
        "final_promotion_allowed": False,
        "proof_semantics_label": (
            "hpairs_replay_tape_features_prefilter_only_exact_replay_and_runtime_ledger_required"
        ),
    }


def _canonical_row_json(signal: SignalEnvelope) -> str:
    return json.dumps(
        signal_to_tape_payload(signal),
        sort_keys=True,
        separators=(",", ":"),
    )


def _hpairs_ofi_horizons(
    payload: Mapping[str, Any],
    *,
    source_fields: set[str],
) -> dict[str, str]:
    horizons: dict[str, str] = {}
    for key in (
        "order_flow_imbalance_horizons",
        "ofi_horizons",
        "horizon_ofi",
        "ofi_by_horizon",
    ):
        raw = payload.get(key)
        if not isinstance(raw, Mapping):
            continue
        source_fields.add(key)
        for horizon, value in cast(Mapping[object, object], raw).items():
            parsed = _decimal_or_none(value)
            if parsed is not None:
                horizons[str(horizon)] = str(parsed)
    for key in (
        "ofi_pressure_score",
        "order_flow_imbalance",
        "ofi",
        "signed_order_flow_imbalance",
        "queue_imbalance",
        "book_imbalance",
        "depth_imbalance",
    ):
        parsed = _decimal_or_none(payload.get(key))
        if parsed is not None:
            source_fields.add(key)
            horizons.setdefault("instant", str(parsed))
            break
    for key, value in payload.items():
        text_key = str(key)
        if not (
            text_key.startswith("ofi_horizon_")
            or text_key.startswith("order_flow_imbalance_horizon_")
        ):
            continue
        parsed = _decimal_or_none(value)
        if parsed is None:
            continue
        source_fields.add(text_key)
        horizons[text_key.rsplit("_", 1)[-1]] = str(parsed)
    return dict(sorted(horizons.items()))


def _hpairs_ofi_decay_memory(
    payload: Mapping[str, Any],
    *,
    source_fields: set[str],
) -> dict[str, str]:
    memory: dict[str, str] = {}
    for key in (
        "ofi_decay_memory",
        "ofi_memory",
        "order_flow_memory",
        "ofi_decay",
    ):
        raw = payload.get(key)
        if not isinstance(raw, Mapping):
            continue
        source_fields.add(key)
        for name, value in cast(Mapping[object, object], raw).items():
            parsed = _decimal_or_none(value)
            if parsed is not None:
                memory[str(name)] = str(parsed)
    for key in (
        "ofi_decay_score",
        "ofi_memory_score",
        "ofi_ewma_short",
        "ofi_ewma_long",
    ):
        parsed = _decimal_or_none(payload.get(key))
        if parsed is None:
            continue
        source_fields.add(key)
        memory[key] = str(parsed)
    return dict(sorted(memory.items()))


def _hpairs_cluster_lob_payload(
    payload: Mapping[str, Any],
    *,
    source_fields: set[str],
) -> dict[str, Any]:
    label = _first_text(
        payload,
        (
            "cluster_lob_label",
            "cluster_label",
            "order_cluster",
            "lob_event_type",
            "event_type",
        ),
        source_fields=source_fields,
    )
    raw_bucket = _first_text(
        payload,
        (
            "cluster_lob_bucket",
            "cluster_bucket",
            "participant_bucket",
            "behavior_bucket",
        ),
        source_fields=source_fields,
    )
    behavior_bucket = raw_bucket or _cluster_lob_behavior_bucket(label)
    quote_behavior_bucket = _quote_behavior_bucket(payload, source_fields=source_fields)
    return {
        "label": label,
        "bucket": behavior_bucket,
        "source_bucket": raw_bucket,
        "behavior_bucket": behavior_bucket,
        "quote_behavior_bucket": quote_behavior_bucket,
        "bucket_policy": (
            "source_bucket"
            if raw_bucket
            else "deterministic_event_quote_behavior_fallback"
        ),
    }


def _cluster_lob_behavior_bucket(label: str | None) -> str:
    text = str(label or "").strip().lower()
    if not text:
        return "unknown"
    if any(token in text for token in ("buy", "bid", "lift", "add_bid")):
        return "aggressive_buy_pressure"
    if any(token in text for token in ("sell", "ask", "hit", "add_ask")):
        return "aggressive_sell_pressure"
    if any(token in text for token in ("cancel", "delete", "remove", "withdraw")):
        return "liquidity_withdrawal"
    if any(token in text for token in ("quote", "replace", "modify", "update")):
        return "quote_revision"
    if "trade" in text or "print" in text:
        return "trade_print"
    return text.replace(" ", "_")


def _quote_behavior_bucket(
    payload: Mapping[str, Any],
    *,
    source_fields: set[str],
) -> str:
    bid_size = _first_decimal_with_key(
        payload,
        (
            "bid_size",
            "bid_qty",
            "best_bid_size",
            "best_bid_qty",
            "bid_depth",
            "bid_volume",
        ),
    )
    ask_size = _first_decimal_with_key(
        payload,
        (
            "ask_size",
            "ask_qty",
            "best_ask_size",
            "best_ask_qty",
            "ask_depth",
            "ask_volume",
        ),
    )
    if bid_size[0] is None or ask_size[0] is None:
        return "quote_depth_missing"
    bid_value, bid_key = bid_size
    ask_value, ask_key = ask_size
    if bid_key is not None:
        source_fields.add(bid_key)
    if ask_key is not None:
        source_fields.add(ask_key)
    assert bid_value is not None
    assert ask_value is not None
    total = bid_value + ask_value
    if total <= 0:
        return "quote_depth_empty"
    imbalance = (bid_value - ask_value) / total
    if imbalance >= Decimal("0.20"):
        return "bid_depth_dominant"
    if imbalance <= Decimal("-0.20"):
        return "ask_depth_dominant"
    return "balanced_quote_depth"


def _hpairs_ofi_memory_regime_slices(
    *,
    horizon_ofi: Mapping[str, str],
    decay_memory: Mapping[str, str],
    regime_tags: Sequence[str],
    stress_tags: Sequence[str],
) -> dict[str, Any]:
    instant = _mean_decimal_for_keys(horizon_ofi, ("instant", "1", "1_events"))
    short = _mean_decimal_for_token(horizon_ofi, ("short", "3", "5"))
    medium = _mean_decimal_for_token(horizon_ofi, ("medium", "12", "15"))
    long = _mean_decimal_for_token(horizon_ofi, ("long", "36", "60"))
    all_horizon_mean = _mean_decimal(horizon_ofi.values())
    instant = instant if instant is not None else all_horizon_mean
    short = short if short is not None else instant
    medium = medium if medium is not None else short
    long = long if long is not None else medium
    memory_score = _mean_decimal(decay_memory.values())
    if memory_score is None:
        memory_score = _mean_decimal(
            value for value in (short, medium, long) if value is not None
        )
    bounded_memory_score = _bounded_decimal(memory_score or Decimal("0"))
    shock_score = _bounded_decimal((short or Decimal("0")) - (long or Decimal("0")))
    directional_alignment = _bounded_decimal(
        Decimal("0.60") * shock_score + Decimal("0.40") * bounded_memory_score
    )
    return {
        "schema_version": HPAIRS_OFI_MEMORY_REGIME_SCHEMA_VERSION,
        "horizons": {
            "instant": _decimal_text(instant or Decimal("0")),
            "short": _decimal_text(short or Decimal("0")),
            "medium": _decimal_text(medium or Decimal("0")),
            "long": _decimal_text(long or Decimal("0")),
        },
        "memory_score": _decimal_text(bounded_memory_score),
        "shock_score": _decimal_text(shock_score),
        "directional_alignment_score": _decimal_text(directional_alignment),
        "regime_bucket": _ofi_regime_bucket(
            memory_score=bounded_memory_score,
            shock_score=shock_score,
            regime_tags=regime_tags,
            stress_tags=stress_tags,
        ),
        "regime_tags": list(regime_tags),
        "stress_tags": list(stress_tags),
        "prefilter_only": True,
        "proof_authority": False,
        "promotion_authority": False,
    }


def _ofi_regime_bucket(
    *,
    memory_score: Decimal,
    shock_score: Decimal,
    regime_tags: Sequence[str],
    stress_tags: Sequence[str],
) -> str:
    if stress_tags:
        return "stress_veto_window"
    tags = {str(tag).strip().lower() for tag in regime_tags}
    if any("wide" in tag or "illiquid" in tag for tag in tags):
        return "wide_spread_liquidity_regime"
    if any("tight" in tag or "liquid" in tag for tag in tags):
        return "tight_spread_liquidity_regime"
    if shock_score >= Decimal("0.20"):
        return "positive_ofi_shock"
    if shock_score <= Decimal("-0.20"):
        return "negative_ofi_shock"
    if memory_score >= Decimal("0.20"):
        return "positive_ofi_memory"
    if memory_score <= Decimal("-0.20"):
        return "negative_ofi_memory"
    return "balanced_ofi_memory"


def _mean_decimal_for_keys(
    values: Mapping[str, str],
    keys: Sequence[str],
) -> Decimal | None:
    wanted = {str(key).lower() for key in keys}
    return _mean_decimal(
        value for key, value in values.items() if str(key).strip().lower() in wanted
    )


def _mean_decimal_for_token(
    values: Mapping[str, str],
    tokens: Sequence[str],
) -> Decimal | None:
    lowered_tokens = tuple(str(token).lower() for token in tokens)
    return _mean_decimal(
        value
        for key, value in values.items()
        if any(
            _horizon_key_matches_token(str(key).strip().lower(), token)
            for token in lowered_tokens
        )
    )


def _horizon_key_matches_token(key: str, token: str) -> bool:
    if key == token:
        return True
    if token in {"short", "medium", "long"}:
        return token in key
    return key.startswith(f"{token}_") or key.startswith(f"{token}-")


# Public aliases used by split-module consumers.
canonical_row_json = _canonical_row_json
cluster_lob_behavior_bucket = _cluster_lob_behavior_bucket
horizon_key_matches_token = _horizon_key_matches_token
hpairs_cluster_lob_payload = _hpairs_cluster_lob_payload
hpairs_ofi_decay_memory = _hpairs_ofi_decay_memory
hpairs_ofi_horizons = _hpairs_ofi_horizons
hpairs_ofi_memory_regime_slices = _hpairs_ofi_memory_regime_slices
mean_decimal_for_keys = _mean_decimal_for_keys
mean_decimal_for_token = _mean_decimal_for_token
ofi_regime_bucket = _ofi_regime_bucket
replay_tape_cache_identity_mismatch_reasons = (
    _replay_tape_cache_identity_mismatch_reasons
)
__all__ = (
    "validate_tape_freshness",
    "slice_tape_by_window",
    "slice_tape_by_symbols",
    "signal_to_tape_payload",
    "signal_from_tape_payload",
    "hpairs_replay_tape_features",
    "canonical_row_json",
    "cluster_lob_behavior_bucket",
    "horizon_key_matches_token",
    "hpairs_cluster_lob_payload",
    "hpairs_ofi_decay_memory",
    "hpairs_ofi_horizons",
    "hpairs_ofi_memory_regime_slices",
    "mean_decimal_for_keys",
    "mean_decimal_for_token",
    "ofi_regime_bucket",
    "replay_tape_cache_identity_mismatch_reasons",
)
