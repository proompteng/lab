from __future__ import annotations

from tests.live_config_manifest_contract.support import (
    Mapping,
    _load_yaml_mapping,
    cast,
)


def test_kafka_clickhouse_writer_is_active_only_against_staging_tables() -> None:
    deployment = _load_yaml_mapping(
        "argocd/applications/torghut-hyperliquid-feed/writer-deployment.yaml"
    )
    spec = cast(Mapping[str, object], deployment.get("spec", {}))
    assert spec.get("replicas") == 1
    assert spec.get("strategy") == {"type": "Recreate"}

    config = _load_yaml_mapping(
        "argocd/applications/torghut-hyperliquid-feed/configmap.yaml"
    )
    data = cast(Mapping[str, object], config.get("data", {}))
    assert data.get("CLICKHOUSE_ENABLED") == "true"
    assert data.get("CLICKHOUSE_WRITER_AUTO_OFFSET_RESET") == "earliest"
    assert data.get("CLICKHOUSE_WRITER_DESTINATION_SUFFIX") == "_kafka_staging"
