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


def test_parity_cronjob_is_an_operator_gate_without_degrading_argo_health() -> None:
    cronjob = _load_yaml_mapping(
        "argocd/applications/torghut-hyperliquid-feed/parity-cronjob.yaml"
    )
    metadata = cast(Mapping[str, object], cronjob.get("metadata", {}))
    annotations = cast(Mapping[str, object], metadata.get("annotations", {}))
    assert annotations.get("argocd.argoproj.io/ignore-healthcheck") == "true"

    spec = cast(Mapping[str, object], cronjob.get("spec", {}))
    assert spec.get("suspend") is True
    assert spec.get("concurrencyPolicy") == "Forbid"
    job_template = cast(Mapping[str, object], spec.get("jobTemplate", {}))
    job_spec = cast(Mapping[str, object], job_template.get("spec", {}))
    assert job_spec.get("backoffLimit") == 0
