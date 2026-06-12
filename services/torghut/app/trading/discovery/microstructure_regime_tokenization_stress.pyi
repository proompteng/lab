from __future__ import annotations

# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false
# ruff: noqa: F401,F403,F405,F811,F821
from typing import Any
import hashlib
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from math import isfinite
from statistics import median
from typing import Any, cast
from app.trading.models import SignalEnvelope

MICROSTRUCTURE_REGIME_TOKENIZATION_STRESS_SCHEMA_VERSION: Any
MICROSTRUCTURE_REGIME_TOKENIZATION_STRESS_CONTRACT_SCHEMA_VERSION: Any
MICROSTRUCTURE_REGIME_TOKENIZATION_STRESS_PROOF_SEMANTICS_LABEL: Any
MICROSTRUCTURE_REGIME_TOKENIZATION_STRESS_PRIMARY_SOURCES: tuple[Mapping[str, str], ...]
_EVENT_TYPE_FIELDS: Any
_SIDE_FIELDS: Any
_PRICE_FIELDS: Any
_SIZE_FIELDS: Any
_SPREAD_FIELDS: Any
_DEPTH_FIELDS: Any
_OFI_FIELDS: Any
_RETURN_BPS_FIELDS: Any
_RAW_EVENT_FIELDS: Any
_ORDER_ID_FIELDS: Any
_MESSAGE_TIME_DELTA_FIELDS: Any
_POST_MESSAGE_SNAPSHOT_PRICE_FIELDS: Any
_LOBERT_LIFECYCLE_ACTIONS: Any
_BINNED_FIELD_TOKENS: Any
_MIN_EARLY_WARNING_ROWS: Any
_EARLY_WARNING_LOOKAHEAD: Any

class MicrostructureRegimeTokenizationStressSummary:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    row_count: int
    observed_event_type_count: int
    observed_side_count: int
    observed_price_count: int
    observed_size_count: int
    observed_spread_count: int
    observed_depth_count: int
    observed_ofi_count: int
    observed_raw_event_count: int
    observed_sequence_count: int
    observed_order_id_count: int
    observed_lifecycle_action_count: int
    observed_time_delta_count: int
    observed_post_message_snapshot_count: int
    event_alphabet_size: int
    dominant_event_type_share: float
    scale_invariant_feature_coverage_score: float
    universal_tokenization_gap_score: float
    byte_stream_precision_gap_score: float
    lobert_message_semantics_gap_score: float
    binned_numeric_field_share: float
    latent_regime_trigger_count: int
    latent_regime_stress_event_count: int
    latent_regime_lead_coverage: float
    mean_positive_lead_steps: float
    reactive_detection_gap_score: float
    stylized_fact_gap_score: float
    signed_return_autocorr_abs: float
    abs_return_clustering_score: float
    tail_event_share: float
    replay_rank_penalty_bps: float
    warnings: tuple[str, ...]
    feature_schema_hash: str
    def to_payload(*args: Any, **kwargs: Any) -> Any: ...

def microstructure_regime_tokenization_stress_contract(
    *args: Any, **kwargs: Any
) -> Any: ...
def build_microstructure_regime_tokenization_stress_schema_hash(
    *args: Any, **kwargs: Any
) -> Any: ...
def extract_microstructure_regime_tokenization_stress(
    *args: Any, **kwargs: Any
) -> Any: ...

class _MicrostructureObservation:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    price: float | None
    spread_bps: float | None
    depth: float | None
    ofi: float | None
    explicit_return_bps: float | None
    computed_return_bps: float

class _EarlyWarningSummary:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    trigger_count: int
    stress_event_count: int
    lead_coverage: float
    mean_positive_lead_steps: float
    reactive_gap_score: float

class _StylizedFactSummary:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    gap_score: float
    signed_return_autocorr_abs: float
    abs_return_clustering_score: float
    tail_event_share: float

def _attach_computed_returns(*args: Any, **kwargs: Any) -> Any: ...
def _latent_regime_early_warning(*args: Any, **kwargs: Any) -> Any: ...
def _series_returns(*args: Any, **kwargs: Any) -> Any: ...
def _regime_channel_values(*args: Any, **kwargs: Any) -> Any: ...
def _stylized_fact_gap(*args: Any, **kwargs: Any) -> Any: ...
def _robust_threshold(*args: Any, **kwargs: Any) -> Any: ...
def _lag1_corr(*args: Any, **kwargs: Any) -> Any: ...
def _event_type(*args: Any, **kwargs: Any) -> Any: ...
def _has_lobert_lifecycle_action(*args: Any, **kwargs: Any) -> Any: ...
def _has_post_message_snapshot(*args: Any, **kwargs: Any) -> Any: ...
def _depth_proxy(*args: Any, **kwargs: Any) -> Any: ...
def _first_value(*args: Any, **kwargs: Any) -> Any: ...
def _first_number(*args: Any, **kwargs: Any) -> Any: ...
def _number_or_none(*args: Any, **kwargs: Any) -> Any: ...
def _stable_float(*args: Any, **kwargs: Any) -> Any: ...
def _stable_hash(*args: Any, **kwargs: Any) -> Any: ...
def _json_ready(*args: Any, **kwargs: Any) -> Any: ...

__all__: Any
