# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Manifest-verified replay tape artifacts for Torghut research replays."""

from __future__ import annotations

import gzip
import hashlib
import json
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, TextIO, cast

from app.trading.models import SignalEnvelope
from app.trading.session_context import (
    iter_regular_equities_session_dates,
    regular_session_close_utc_for,
    regular_session_open_utc_for,
)

# ruff: noqa: F401,F403,F405,F811,F821

from .shared_context import (
    HPAIRS_CLUSTERLOB_FEATURE_VERSION,
    HPAIRS_OFI_FEATURE_VERSION,
    HPAIRS_OFI_MEMORY_REGIME_SCHEMA_VERSION,
    HPAIRS_REPLAY_TAPE_FEATURE_CONTRACT_SCHEMA_VERSION,
    HPAIRS_REPLAY_TAPE_FEATURE_SCHEMA_VERSION,
    REPLAY_TAPE_CACHE_IDENTITY_SCHEMA_VERSION,
    REPLAY_TAPE_MANIFEST_SCHEMA_VERSION,
    REPLAY_TAPE_SCHEMA_VERSION,
    ReplayTape,
    ReplayTapeCoverageError,
    ReplayTapeManifest,
    DATETIME_TAG as _DATETIME_TAG,
    DECIMAL_TAG as _DECIMAL_TAG,
    bounded_decimal as _bounded_decimal,
    business_days as _business_days,
    coverage_error_diagnostics as _coverage_error_diagnostics,
    coverage_status as _coverage_status,
    date_tuple as _date_tuple,
    decimal_or_none as _decimal_or_none,
    decimal_text as _decimal_text,
    decode_value as _decode_value,
    encode_value as _encode_value,
    empty_row_count_by_symbol_trading_day as _empty_row_count_by_symbol_trading_day,
    empty_row_count_by_trading_day as _empty_row_count_by_trading_day,
    empty_string_mapping as _empty_string_mapping,
    first_decimal_with_key as _first_decimal_with_key,
    first_text as _first_text,
    hpairs_capacity_notional_lineage as _hpairs_capacity_notional_lineage,
    int_mapping as _int_mapping,
    json_ready as _json_ready,
    mean_decimal as _mean_decimal,
    missing_symbol_trading_days as _missing_symbol_trading_days,
    nested_int_mapping as _nested_int_mapping,
    normalize_symbols as _normalize_symbols,
    open_text_reader as _open_text_reader,
    open_text_writer as _open_text_writer,
    parse_datetime as _parse_datetime,
    parse_symbol_day_entry as _parse_symbol_day_entry,
    resolve_replay_feature_versions as _resolve_replay_feature_versions,
    row_count_by_symbol_trading_day as _row_count_by_symbol_trading_day,
    signal_sort_key as _signal_sort_key,
    stress_tag_tuple as _stress_tag_tuple,
    string_mapping as _string_mapping,
    string_tuple as _string_tuple,
    symbol_day_entry as _symbol_day_entry,
    symbol_day_entry_in_window as _symbol_day_entry_in_window,
    tag_tuple as _tag_tuple,
    build_hpairs_replay_tape_feature_schema_hash,
    build_replay_tape_cache_identity_diagnostics,
    build_replay_tape_cache_key,
    build_source_query_digest,
    default_manifest_path,
    hpairs_replay_tape_feature_contract,
    hpairs_replay_tape_feature_versions,
    load_replay_tape,
    materialize_signal_tape,
)
from .validate_tape_freshness import (
    canonical_row_json as _canonical_row_json,
    cluster_lob_behavior_bucket as _cluster_lob_behavior_bucket,
    horizon_key_matches_token as _horizon_key_matches_token,
    hpairs_cluster_lob_payload as _hpairs_cluster_lob_payload,
    hpairs_ofi_decay_memory as _hpairs_ofi_decay_memory,
    hpairs_ofi_horizons as _hpairs_ofi_horizons,
    hpairs_ofi_memory_regime_slices as _hpairs_ofi_memory_regime_slices,
    mean_decimal_for_keys as _mean_decimal_for_keys,
    mean_decimal_for_token as _mean_decimal_for_token,
    ofi_regime_bucket as _ofi_regime_bucket,
    quote_behavior_bucket as _quote_behavior_bucket,
    replay_tape_cache_identity_mismatch_reasons as _replay_tape_cache_identity_mismatch_reasons,
    hpairs_replay_tape_features,
    signal_from_tape_payload,
    signal_to_tape_payload,
    slice_tape_by_symbols,
    slice_tape_by_window,
    validate_tape_freshness,
)


__all__ = [
    "REPLAY_TAPE_CACHE_IDENTITY_SCHEMA_VERSION",
    "HPAIRS_REPLAY_TAPE_FEATURE_SCHEMA_VERSION",
    "REPLAY_TAPE_MANIFEST_SCHEMA_VERSION",
    "REPLAY_TAPE_SCHEMA_VERSION",
    "ReplayTape",
    "ReplayTapeCoverageError",
    "ReplayTapeManifest",
    "build_replay_tape_cache_key",
    "build_replay_tape_cache_identity_diagnostics",
    "build_source_query_digest",
    "default_manifest_path",
    "load_replay_tape",
    "materialize_signal_tape",
    "hpairs_replay_tape_features",
    "signal_from_tape_payload",
    "signal_to_tape_payload",
    "slice_tape_by_symbols",
    "slice_tape_by_window",
    "validate_tape_freshness",
]


__all__ = [name for name in globals() if not name.startswith("__")]
