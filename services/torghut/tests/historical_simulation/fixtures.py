"""Input and boundary fixtures for the historical simulation startup tests."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import ExitStack, contextmanager
from dataclasses import replace
from datetime import datetime, timezone
from unittest import TestCase
from unittest.mock import patch

from scripts.historical_simulation_runtime_verification import runtime_health
from scripts.historical_simulation_startup import (
    ArgocdAutomationConfig,
    ClickHouseRuntimeConfig,
    KafkaRuntimeConfig,
    PostgresRuntimeConfig,
    RolloutsAnalysisConfig,
    _build_resources,
    replay_execution,
    state_and_cache,
)
from scripts.historical_simulation_startup.runtime_config import SimulationResources


def make_kafka_config(**overrides: object) -> KafkaRuntimeConfig:
    return replace(
        KafkaRuntimeConfig("kafka:9092", None, None, None, None), **overrides
    )


def make_clickhouse_config(
    *, password: str | None, http_url: str = "http://clickhouse:8123"
) -> ClickHouseRuntimeConfig:
    return ClickHouseRuntimeConfig(
        http_url=http_url, username="torghut", password=password
    )


def make_postgres_config(**overrides: object) -> PostgresRuntimeConfig:
    return replace(
        PostgresRuntimeConfig(
            admin_dsn="postgresql://torghut:secret@localhost:5432/postgres",
            simulation_dsn="postgresql://torghut:secret@localhost:5432/torghut_sim_sim_1",
            simulation_db="torghut_sim_sim_1",
            migrations_command="true",
        ),
        **overrides,
    )


def make_argocd_config(
    *, manage_automation: bool, verify_timeout_seconds: int = 600
) -> ArgocdAutomationConfig:
    return ArgocdAutomationConfig(
        manage_automation=manage_automation,
        applicationset_name="product",
        applicationset_namespace="argocd",
        app_name="torghut",
        root_app_name="root",
        desired_mode_during_run="manual",
        restore_mode_after_run="previous",
        verify_timeout_seconds=verify_timeout_seconds,
    )


def disabled_rollouts_config(
    *, verify_timeout_seconds: int = 900
) -> RolloutsAnalysisConfig:
    return RolloutsAnalysisConfig(
        enabled=False,
        namespace="agents",
        runtime_template="torghut-runtime-ready-v1",
        activity_template="torghut-sim-activity-v1",
        teardown_template="torghut-teardown-v1",
        artifact_template="torghut-artifact-v1",
        verify_timeout_seconds=verify_timeout_seconds,
        verify_poll_seconds=5,
    )


def simulation_resources() -> SimulationResources:
    return _build_resources("sim-1", {"dataset_id": "dataset-a"})


def open_hour_resources() -> SimulationResources:
    return _build_resources(
        "sim-2026-03-06-open-hour",
        {
            "dataset_id": "dataset-a",
            "runtime": {
                "target_mode": "dedicated_service",
                "namespace": "torghut",
                "ta_configmap": "torghut-ta-sim-config",
                "ta_deployment": "torghut-ta-sim",
                "torghut_service": "torghut-sim",
            },
        },
    )


def open_hour_trading_env(**overrides: str) -> dict[str, str]:
    return {
        "TRADING_ENABLED": "true",
        "TRADING_SIMULATION_ENABLED": "true",
        "TRADING_SIGNAL_TABLE": "torghut_sim_sim_2026_03_06_open_hour.ta_signals",
        "TRADING_PRICE_TABLE": "torghut_sim_sim_2026_03_06_open_hour.ta_microbars",
        "TRADING_ORDER_FEED_ENABLED": "true",
        "TRADING_ORDER_FEED_TOPIC": "torghut.sim.trade-updates.v1.sim_2026_03_06_open_hour",
        "TRADING_SIMULATION_ORDER_UPDATES_TOPIC": "torghut.sim.trade-updates.v1.sim_2026_03_06_open_hour",
        "TRADING_SIMULATION_RUN_ID": "sim-2026-03-06-open-hour",
        "TRADING_SIGNAL_ALLOWED_SOURCES": "ws,ta",
        **overrides,
    }


def ready_knative_service(
    env: dict[str, str],
    *,
    env_from: list[dict[str, object]] | None = None,
    image: str | None = None,
) -> dict[str, object]:
    container: dict[str, object] = {
        "name": "user-container",
        "env": [{"name": name, "value": value} for name, value in env.items()],
    }
    if env_from is not None:
        container["envFrom"] = env_from
    if image is not None:
        container["image"] = image
    return {
        "spec": {"template": {"spec": {"containers": [container]}}},
        "status": {
            "latestReadyRevisionName": "torghut-sim-00001",
            "conditions": [{"type": "Ready", "status": "True"}],
        },
    }


@contextmanager
def patch_ready_compute(*config_responses: dict[str, object]) -> Iterator[None]:
    """Stub Kubernetes/Flink reads while the real runtime verifier checks config."""
    with (
        patch.object(runtime_health, "_kubectl_json", side_effect=config_responses),
        patch.object(
            runtime_health,
            "_deployment_replica_health",
            side_effect=[
                {
                    "name": "torghut-sim-00001-deployment",
                    "ready_replicas": 1,
                    "available_replicas": 1,
                    "replicas": 1,
                }
            ],
        ),
        patch.object(
            runtime_health,
            "_flink_runtime_health",
            return_value={
                "name": "torghut-ta-sim",
                "desired_state": "running",
                "lifecycle_state": "RUNNING",
                "job_manager_status": "DEPLOYED",
            },
        ),
    ):
        yield


def stub_replay_preflight(stack: ExitStack, resources: SimulationResources) -> None:
    stack.enter_context(
        patch.object(replay_execution, "_ensure_supported_binary", return_value=None)
    )
    stack.enter_context(
        patch.object(replay_execution, "_ensure_lz4_codec_available", return_value=None)
    )
    stack.enter_context(
        patch.object(
            replay_execution,
            "_acquire_simulation_runtime_lock",
            return_value={"status": "acquired", "run_id": resources.run_id},
        )
    )


def stub_replay_databases(stack: ExitStack) -> None:
    stack.enter_context(patch.object(replay_execution, "_ensure_clickhouse_database"))
    stack.enter_context(
        patch.object(
            replay_execution, "_ensure_clickhouse_runtime_tables", return_value=None
        )
    )
    stack.enter_context(patch.object(replay_execution, "_ensure_postgres_database"))
    stack.enter_context(
        patch.object(
            replay_execution,
            "_ensure_postgres_runtime_permissions",
            return_value={"grants_applied": True},
        )
    )


def stub_replay_storage(stack: ExitStack) -> None:
    for name, result in (
        ("_run_migrations", None),
        ("_reset_postgres_runtime_state", None),
        (
            "_seed_simulation_trade_cursor",
            datetime(2026, 2, 27, 14, 30, tzinfo=timezone.utc),
        ),
        ("_upsert_simulation_runtime_context", None),
        ("_dump_topics", {"records": 1, "sha256": "abc"}),
        ("_validate_dump_coverage", {"coverage_ratio": 1.0}),
    ):
        stack.enter_context(patch.object(replay_execution, name, return_value=result))


class SimulationOrchestrationTestCase(TestCase):
    def setUp(self) -> None:
        # Orchestration tests exercise progress reporting without attempting
        # production-DSN connections and transient retries on the test host.
        self.enterContext(patch.object(state_and_cache, "psycopg", autospec=True))
