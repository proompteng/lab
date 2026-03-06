"""Evidence authority contracts for promotion-safe Torghut artifacts."""

from __future__ import annotations

from enum import Enum
from typing import Any, Mapping, cast


class ArtifactProvenance(str, Enum):
    STRUCTURAL_PLACEHOLDER = 'structural_placeholder'
    SYNTHETIC_GENERATED = 'synthetic_generated'
    HISTORICAL_MARKET_REPLAY = 'historical_market_replay'
    PAPER_RUNTIME_OBSERVED = 'paper_runtime_observed'
    LIVE_RUNTIME_OBSERVED = 'live_runtime_observed'


class EvidenceMaturity(str, Enum):
    STUB = 'stub'
    UNCALIBRATED = 'uncalibrated'
    CALIBRATED = 'calibrated'
    EMPIRICALLY_VALIDATED = 'empirically_validated'


NON_AUTHORITATIVE_PROVENANCE: frozenset[ArtifactProvenance] = frozenset(
    {
        ArtifactProvenance.STRUCTURAL_PLACEHOLDER,
        ArtifactProvenance.SYNTHETIC_GENERATED,
    }
)


def evidence_contract_payload(
    *,
    provenance: ArtifactProvenance,
    maturity: EvidenceMaturity,
    authoritative: bool | None = None,
    placeholder: bool | None = None,
    calibration_summary: Mapping[str, Any] | None = None,
    deviation_summary: Mapping[str, Any] | None = None,
    notes: str | None = None,
) -> dict[str, Any]:
    resolved_authoritative = (
        authoritative
        if authoritative is not None
        else provenance not in NON_AUTHORITATIVE_PROVENANCE
    )
    resolved_placeholder = (
        placeholder
        if placeholder is not None
        else provenance in NON_AUTHORITATIVE_PROVENANCE
    )
    payload: dict[str, Any] = {
        'provenance': provenance.value,
        'maturity': maturity.value,
        'authoritative': bool(resolved_authoritative),
        'placeholder': bool(resolved_placeholder),
    }
    if calibration_summary:
        payload['calibration_summary'] = dict(calibration_summary)
    if deviation_summary:
        payload['deviation_summary'] = dict(deviation_summary)
    if notes:
        payload['notes'] = notes
    return payload


def parse_evidence_contract(value: Any) -> dict[str, Any]:
    payload = cast(dict[str, Any], value) if isinstance(value, dict) else {}
    provenance = _coerce_provenance(payload.get('provenance'))
    maturity = _coerce_maturity(payload.get('maturity'))
    authoritative = bool(payload.get('authoritative', provenance not in NON_AUTHORITATIVE_PROVENANCE))
    placeholder = bool(payload.get('placeholder', provenance in NON_AUTHORITATIVE_PROVENANCE))
    normalized: dict[str, Any] = {
        'provenance': provenance.value,
        'maturity': maturity.value,
        'authoritative': authoritative,
        'placeholder': placeholder,
    }
    calibration_summary = payload.get('calibration_summary')
    if isinstance(calibration_summary, dict):
        normalized['calibration_summary'] = dict(calibration_summary)
    deviation_summary = payload.get('deviation_summary')
    if isinstance(deviation_summary, dict):
        normalized['deviation_summary'] = dict(deviation_summary)
    notes = str(payload.get('notes', '')).strip()
    if notes:
        normalized['notes'] = notes
    return normalized


def contract_from_artifact_payload(payload: Any) -> dict[str, Any]:
    artifact_payload = cast(dict[str, Any], payload) if isinstance(payload, dict) else {}
    raw_contract = artifact_payload.get('artifact_authority')
    if isinstance(raw_contract, dict):
        return parse_evidence_contract(raw_contract)
    raw_contract = artifact_payload.get('evidence_contract')
    if isinstance(raw_contract, dict):
        return parse_evidence_contract(raw_contract)
    return {}


def _coerce_provenance(value: Any) -> ArtifactProvenance:
    normalized = str(value or '').strip().lower()
    for item in ArtifactProvenance:
        if item.value == normalized:
            return item
    return ArtifactProvenance.STRUCTURAL_PLACEHOLDER


def _coerce_maturity(value: Any) -> EvidenceMaturity:
    normalized = str(value or '').strip().lower()
    for item in EvidenceMaturity:
        if item.value == normalized:
            return item
    return EvidenceMaturity.STUB


__all__ = [
    'ArtifactProvenance',
    'EvidenceMaturity',
    'NON_AUTHORITATIVE_PROVENANCE',
    'contract_from_artifact_payload',
    'evidence_contract_payload',
    'parse_evidence_contract',
]
