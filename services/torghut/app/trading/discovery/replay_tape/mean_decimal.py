"""Manifest-verified replay tape artifacts for Torghut research replays."""

from __future__ import annotations


from .shared_context import (
    HPAIRS_REPLAY_TAPE_FEATURE_SCHEMA_VERSION,
    REPLAY_TAPE_CACHE_IDENTITY_SCHEMA_VERSION,
    REPLAY_TAPE_MANIFEST_SCHEMA_VERSION,
    REPLAY_TAPE_SCHEMA_VERSION,
    ReplayTape,
    ReplayTapeCoverageError,
    ReplayTapeManifest,
    build_replay_tape_cache_identity_diagnostics,
    build_replay_tape_cache_key,
    build_source_query_digest,
    default_manifest_path,
    load_replay_tape,
    materialize_signal_tape,
)
from .validate_tape_freshness import (
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
