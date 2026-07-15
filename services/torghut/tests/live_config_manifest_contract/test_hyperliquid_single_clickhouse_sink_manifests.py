from __future__ import annotations

from tests.live_config_manifest_contract.support import (
    Mapping,
    _load_yaml_mapping,
    _repo_root,
    cast,
)


def test_hyperliquid_feed_has_no_shadow_clickhouse_path() -> None:
    application_path = "argocd/applications/torghut-hyperliquid-feed"
    repo_root = _repo_root()
    for filename in (
        "writer-deployment.yaml",
        "writer-service.yaml",
        "parity-cronjob.yaml",
    ):
        assert not (repo_root / application_path / filename).exists()

    kustomization = _load_yaml_mapping(f"{application_path}/kustomization.yaml")
    resources = cast(list[object], kustomization.get("resources", []))
    assert resources == [
        "configmap.yaml",
        "clickhouse-schema-configmap.yaml",
        "clickhouse-schema-job.yaml",
        "deployment.yaml",
        "service.yaml",
        "pdb.yaml",
    ]

    config = _load_yaml_mapping(f"{application_path}/configmap.yaml")
    data = cast(Mapping[str, object], config.get("data", {}))
    assert not any(
        key.startswith(("CLICKHOUSE_WRITER_", "CLICKHOUSE_PARITY_")) for key in data
    )

    schema_config = _load_yaml_mapping(
        f"{application_path}/clickhouse-schema-configmap.yaml"
    )
    schema_data = cast(Mapping[str, object], schema_config.get("data", {}))
    schema = str(schema_data.get("schema.sql", ""))
    assert "_kafka_staging" not in schema
    assert "kafka_topic" not in schema
    assert "kafka_partition" not in schema
    assert "kafka_offset" not in schema
