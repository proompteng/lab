"""Shared lane contracts for Torghut historical simulation."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping


@dataclass(frozen=True)
class SimulationLaneContract:
    lane: str
    schema_version: str | None
    source_topic_by_role: dict[str, str]
    simulation_topic_by_role: dict[str, str]
    replay_roles: tuple[str, ...]
    clickhouse_source_table_by_role: dict[str, str]
    clickhouse_simulation_table_by_role: dict[str, str]
    signal_table_role: str
    price_table_role: str
    ta_topic_key_by_role: dict[str, str]
    ta_clickhouse_url_key: str
    ta_group_id_key: str
    ta_auto_offset_reset_key: str
    schema_registry_subject_roles: tuple[str, ...] = ()
    schema_registry_schema_file_by_role: dict[str, str] = field(default_factory=dict)
    required_manifest_fields: tuple[str, ...] = ()


EQUITY_SIMULATION_LANE = SimulationLaneContract(
    lane="equity",
    schema_version=None,
    source_topic_by_role={
        "trades": "torghut.trades.v1",
        "quotes": "torghut.quotes.v1",
        "bars": "torghut.bars.1m.v1",
        "status": "torghut.status.v1",
        "ta_microbars": "torghut.ta.bars.1s.v1",
        "ta_signals": "torghut.ta.signals.v1",
        "ta_status": "torghut.ta.status.v1",
        "order_updates": "torghut.trade-updates.v1",
    },
    simulation_topic_by_role={
        "trades": "torghut.sim.trades.v1",
        "quotes": "torghut.sim.quotes.v1",
        "bars": "torghut.sim.bars.1m.v1",
        "status": "torghut.sim.status.v1",
        "ta_microbars": "torghut.sim.ta.bars.1s.v1",
        "ta_signals": "torghut.sim.ta.signals.v1",
        "ta_status": "torghut.sim.ta.status.v1",
        "order_updates": "torghut.sim.trade-updates.v1",
    },
    replay_roles=("trades", "quotes", "bars", "status"),
    clickhouse_source_table_by_role={
        "price": "ta_microbars",
        "signal": "ta_signals",
    },
    clickhouse_simulation_table_by_role={
        "price": "ta_microbars",
        "signal": "ta_signals",
    },
    signal_table_role="signal",
    price_table_role="price",
    ta_topic_key_by_role={
        "trades": "TA_TRADES_TOPIC",
        "quotes": "TA_QUOTES_TOPIC",
        "bars": "TA_BARS1M_TOPIC",
        "ta_microbars": "TA_MICROBARS_TOPIC",
        "ta_signals": "TA_SIGNALS_TOPIC",
    },
    ta_clickhouse_url_key="TA_CLICKHOUSE_URL",
    ta_group_id_key="TA_GROUP_ID",
    ta_auto_offset_reset_key="TA_AUTO_OFFSET_RESET",
    schema_registry_subject_roles=("ta_microbars", "ta_signals"),
    schema_registry_schema_file_by_role={
        "ta_microbars": "docs/torghut/schemas/ta-bars-1s.avsc",
        "ta_signals": "docs/torghut/schemas/ta-signals.avsc",
    },
)

OPTIONS_SIMULATION_LANE = SimulationLaneContract(
    lane="options",
    schema_version="torghut.options-simulation-manifest.v1",
    source_topic_by_role={
        "contracts": "torghut.options.contracts.v1",
        "trades": "torghut.options.trades.v1",
        "quotes": "torghut.options.quotes.v1",
        "snapshots": "torghut.options.snapshots.v1",
        "status": "torghut.options.status.v1",
        "ta_contract_bars": "torghut.options.ta.contract-bars.1s.v1",
        "ta_contract_features": "torghut.options.ta.contract-features.v1",
        "ta_surface_features": "torghut.options.ta.surface-features.v1",
        "ta_status": "torghut.options.ta.status.v1",
        "order_updates": "torghut.options.trade-updates.v1",
    },
    simulation_topic_by_role={
        "contracts": "torghut.sim.options.contracts.v1",
        "trades": "torghut.sim.options.trades.v1",
        "quotes": "torghut.sim.options.quotes.v1",
        "snapshots": "torghut.sim.options.snapshots.v1",
        "status": "torghut.sim.options.status.v1",
        "ta_contract_bars": "torghut.sim.options.ta.contract-bars.1s.v1",
        "ta_contract_features": "torghut.sim.options.ta.contract-features.v1",
        "ta_surface_features": "torghut.sim.options.ta.surface-features.v1",
        "ta_status": "torghut.sim.options.ta.status.v1",
        "order_updates": "torghut.sim.options.trade-updates.v1",
    },
    replay_roles=("contracts", "trades", "quotes", "snapshots", "status"),
    clickhouse_source_table_by_role={
        "price": "options_contract_bars_1s",
        "signal": "options_contract_features",
        "surface": "options_surface_features",
    },
    clickhouse_simulation_table_by_role={
        "price": "sim_options_contract_bars_1s",
        "signal": "sim_options_contract_features",
        "surface": "sim_options_surface_features",
    },
    signal_table_role="signal",
    price_table_role="price",
    ta_topic_key_by_role={
        "contracts": "TOPIC_OPTIONS_CONTRACTS",
        "trades": "TOPIC_OPTIONS_TRADES",
        "quotes": "TOPIC_OPTIONS_QUOTES",
        "snapshots": "TOPIC_OPTIONS_SNAPSHOTS",
        "status": "TOPIC_OPTIONS_STATUS",
        "ta_contract_bars": "TOPIC_OPTIONS_TA_CONTRACT_BARS",
        "ta_contract_features": "TOPIC_OPTIONS_TA_CONTRACT_FEATURES",
        "ta_surface_features": "TOPIC_OPTIONS_TA_SURFACE_FEATURES",
        "ta_status": "TOPIC_OPTIONS_TA_STATUS",
    },
    ta_clickhouse_url_key="OPTIONS_TA_CLICKHOUSE_URL",
    ta_group_id_key="OPTIONS_TA_GROUP_ID",
    ta_auto_offset_reset_key="OPTIONS_TA_AUTO_OFFSET_RESET",
    required_manifest_fields=(
        "feed",
        "underlyings",
        "contract_policy",
        "catalog_snapshot_ref",
        "raw_source_policy",
        "cost_model",
        "proof_gates",
    ),
)


def simulation_schema_registry_subject_roles(
    contract: SimulationLaneContract,
) -> tuple[str, ...]:
    configured_roles = contract.schema_registry_subject_roles or tuple(contract.ta_topic_key_by_role.keys())
    return tuple(role for role in configured_roles if role in contract.ta_topic_key_by_role)

SIMULATION_LANE_BY_NAME = {
    EQUITY_SIMULATION_LANE.lane: EQUITY_SIMULATION_LANE,
    OPTIONS_SIMULATION_LANE.lane: OPTIONS_SIMULATION_LANE,
}


def simulation_lane_contract(value: str | None) -> SimulationLaneContract:
    lane = (value or "equity").strip().lower() or "equity"
    try:
        return SIMULATION_LANE_BY_NAME[lane]
    except KeyError as exc:
        supported = ",".join(sorted(SIMULATION_LANE_BY_NAME))
        raise RuntimeError(
            f"unsupported_simulation_lane:{lane} supported={supported}"
        ) from exc


def simulation_lane_contract_for_manifest(
    manifest: Mapping[str, Any],
) -> SimulationLaneContract:
    contract = simulation_lane_contract(_manifest_text(manifest.get("lane")))
    schema_version = _manifest_text(manifest.get("schema_version"))
    if (
        contract.schema_version is not None
        and schema_version != contract.schema_version
    ):
        raise RuntimeError(
            "simulation_manifest_schema_version_invalid "
            f"lane={contract.lane} expected={contract.schema_version} observed={schema_version or 'missing'}"
        )
    if contract.lane == "options":
        _validate_options_manifest(manifest, contract=contract)
    return contract


def simulation_clickhouse_table_names(
    *,
    lane: str,
    database: str,
) -> dict[str, str]:
    contract = simulation_lane_contract(lane)
    return {
        role: f"{database}.{table}"
        for role, table in contract.clickhouse_simulation_table_by_role.items()
    }


def _validate_options_manifest(
    manifest: Mapping[str, Any],
    *,
    contract: SimulationLaneContract,
) -> None:
    feed = _manifest_text(manifest.get("feed"))
    if feed not in {"indicative", "opra"}:
        raise RuntimeError(
            f"options_simulation_feed_invalid observed={feed or 'missing'} expected=indicative|opra"
        )

    missing: list[str] = []
    for key in contract.required_manifest_fields:
        if not _manifest_value_present(manifest.get(key)):
            missing.append(key)
    if missing:
        raise RuntimeError(
            f"options_simulation_manifest_missing_fields:{','.join(missing)}"
        )


def _manifest_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    return text


def _manifest_value_present(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, Mapping):
        return len(value) > 0
    if isinstance(value, list):
        return len(value) > 0
    return True


__all__ = [
    "EQUITY_SIMULATION_LANE",
    "OPTIONS_SIMULATION_LANE",
    "SIMULATION_LANE_BY_NAME",
    "SimulationLaneContract",
    "simulation_clickhouse_table_names",
    "simulation_lane_contract",
    "simulation_lane_contract_for_manifest",
]
