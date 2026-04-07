"""Family template registry for discovery Harness v2."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, cast

import yaml

_SCHEMA_VERSION = 'torghut.family-template.v1'
_DEFAULT_DIR = Path(__file__).resolve().parents[3] / 'config' / 'trading' / 'families'


@dataclass(frozen=True)
class FamilyTemplate:
    family_id: str
    economic_mechanism: str
    supported_markets: tuple[str, ...]
    required_features: tuple[str, ...]
    allowed_normalizations: tuple[str, ...]
    entry_motifs: tuple[str, ...]
    exit_motifs: tuple[str, ...]
    risk_controls: tuple[str, ...]
    activity_model: Mapping[str, Any]
    liquidity_assumptions: Mapping[str, Any]
    regime_activation_rules: tuple[Mapping[str, Any], ...]
    day_veto_rules: tuple[Mapping[str, Any], ...]
    default_hard_vetoes: Mapping[str, Any]
    default_selection_objectives: Mapping[str, Any]
    schema_version: str = _SCHEMA_VERSION

    def to_payload(self) -> dict[str, Any]:
        return {
            'schema_version': self.schema_version,
            'family_id': self.family_id,
            'economic_mechanism': self.economic_mechanism,
            'supported_markets': list(self.supported_markets),
            'required_features': list(self.required_features),
            'allowed_normalizations': list(self.allowed_normalizations),
            'entry_motifs': list(self.entry_motifs),
            'exit_motifs': list(self.exit_motifs),
            'risk_controls': list(self.risk_controls),
            'activity_model': dict(self.activity_model),
            'liquidity_assumptions': dict(self.liquidity_assumptions),
            'regime_activation_rules': [dict(item) for item in self.regime_activation_rules],
            'day_veto_rules': [dict(item) for item in self.day_veto_rules],
            'default_hard_vetoes': dict(self.default_hard_vetoes),
            'default_selection_objectives': dict(self.default_selection_objectives),
        }


def family_template_dir(path: Path | None = None) -> Path:
    return (path or _DEFAULT_DIR).resolve()


def _mapping(value: object) -> Mapping[str, Any]:
    if isinstance(value, Mapping):
        return cast(Mapping[str, Any], value)
    return {}


def _string_tuple(value: object) -> tuple[str, ...]:
    if not isinstance(value, list):
        return ()
    raw_values = cast(list[Any], value)
    resolved: list[str] = []
    for item in raw_values:
        normalized = str(item).strip()
        if normalized:
            resolved.append(normalized)
    return tuple(resolved)


def _mapping_tuple(value: object) -> tuple[Mapping[str, Any], ...]:
    if not isinstance(value, list):
        return ()
    raw_values = cast(list[Any], value)
    resolved: list[Mapping[str, Any]] = []
    for item in raw_values:
        if isinstance(item, Mapping):
            resolved.append(cast(Mapping[str, Any], item))
    return tuple(resolved)


def load_family_template(
    family_template_id: str,
    *,
    directory: Path | None = None,
) -> FamilyTemplate:
    resolved_id = family_template_id.strip()
    if not resolved_id:
        raise ValueError('family_template_id_required')
    root = family_template_dir(directory)
    template_path = root / f'{resolved_id}.yaml'
    raw_payload = yaml.safe_load(template_path.read_text(encoding='utf-8'))
    if not isinstance(raw_payload, Mapping):
        raise ValueError(f'family_template_not_mapping:{resolved_id}')
    payload = cast(Mapping[str, Any], raw_payload)
    schema_version = str(payload.get('schema_version') or '').strip()
    if schema_version != _SCHEMA_VERSION:
        raise ValueError(f'family_template_schema_invalid:{resolved_id}:{schema_version}')
    if str(payload.get('family_id') or '').strip() != resolved_id:
        raise ValueError(f'family_template_id_mismatch:{resolved_id}')
    return FamilyTemplate(
        family_id=resolved_id,
        economic_mechanism=str(payload.get('economic_mechanism') or '').strip(),
        supported_markets=_string_tuple(payload.get('supported_markets')),
        required_features=_string_tuple(payload.get('required_features')),
        allowed_normalizations=_string_tuple(payload.get('allowed_normalizations')),
        entry_motifs=_string_tuple(payload.get('entry_motifs')),
        exit_motifs=_string_tuple(payload.get('exit_motifs')),
        risk_controls=_string_tuple(payload.get('risk_controls')),
        activity_model=_mapping(payload.get('activity_model')),
        liquidity_assumptions=_mapping(payload.get('liquidity_assumptions')),
        regime_activation_rules=_mapping_tuple(payload.get('regime_activation_rules')),
        day_veto_rules=_mapping_tuple(payload.get('day_veto_rules')),
        default_hard_vetoes=_mapping(payload.get('default_hard_vetoes')),
        default_selection_objectives=_mapping(payload.get('default_selection_objectives')),
    )


def derive_family_template_id(*, explicit_id: str | None, family: str) -> str:
    if explicit_id and explicit_id.strip():
        return explicit_id.strip()
    normalized = family.strip().lower()
    aliases = {
        'intraday_tsmom_consistent': 'intraday_tsmom_v2',
        'breakout_reclaim': 'breakout_reclaim_v2',
        'washout_rebound': 'washout_rebound_v2',
    }
    return aliases.get(normalized, normalized)
