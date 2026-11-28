from __future__ import annotations

from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

from scripts.historical_simulation_runtime_verification import runtime_health
from scripts.historical_simulation_startup import (
    _build_resources,
    _runtime_verify,
    _wait_for_torghut_service_revision_ready,
    argocd_rollouts,
)
from tests.historical_simulation.fixtures import (
    open_hour_resources,
    open_hour_trading_env,
    patch_ready_compute,
    ready_knative_service,
)


class TestStartHistoricalSimulationRuntimeVerifyA(TestCase):
    def test_wait_for_torghut_service_revision_ready_waits_for_created_revision(
        self,
    ) -> None:
        resources = _build_resources(
            "sim-teardown-settle",
            {
                "dataset_id": "dataset-a",
                "runtime": {
                    "target_mode": "dedicated_service",
                    "namespace": "torghut",
                    "torghut_service": "torghut-sim",
                },
            },
        )
        pending_service = {
            "status": {
                "latestCreatedRevisionName": "torghut-sim-00002",
                "latestReadyRevisionName": "torghut-sim-00001",
                "conditions": [{"type": "Ready", "status": "Unknown"}],
            }
        }
        ready_service = {
            "status": {
                "latestCreatedRevisionName": "torghut-sim-00002",
                "latestReadyRevisionName": "torghut-sim-00002",
                "conditions": [{"type": "Ready", "status": "True"}],
            }
        }

        with (
            patch.object(
                argocd_rollouts,
                "_kubectl_json",
                side_effect=[pending_service, ready_service],
            ),
            patch(
                "scripts.historical_simulation_startup.argocd_rollouts.time.sleep",
                return_value=None,
            ) as sleep_mock,
        ):
            report = _wait_for_torghut_service_revision_ready(
                resources=resources,
                timeout_seconds=30,
                poll_seconds=5,
            )

        self.assertTrue(report["ready"])
        self.assertEqual(report["latest_ready_revision"], "torghut-sim-00002")
        sleep_mock.assert_called_once_with(5)

    def test_wait_for_torghut_service_revision_ready_returns_unready_report_on_timeout(
        self,
    ) -> None:
        resources = _build_resources(
            "sim-teardown-settle-timeout",
            {
                "dataset_id": "dataset-a",
                "runtime": {
                    "target_mode": "dedicated_service",
                    "namespace": "torghut",
                    "torghut_service": "torghut-sim",
                },
            },
        )
        pending_service = {
            "status": {
                "latestCreatedRevisionName": "torghut-sim-00002",
                "latestReadyRevisionName": "torghut-sim-00001",
                "conditions": [{"type": "Ready", "status": "Unknown"}],
            }
        }

        with (
            patch.object(
                argocd_rollouts,
                "_kubectl_json",
                return_value=pending_service,
            ),
            patch(
                "scripts.historical_simulation_startup.argocd_rollouts.time.sleep",
                return_value=None,
            ) as sleep_mock,
        ):
            report = _wait_for_torghut_service_revision_ready(
                resources=resources,
                timeout_seconds=0,
                poll_seconds=5,
            )

        self.assertFalse(report["ready"])
        self.assertEqual(report["latest_ready_revision"], "torghut-sim-00001")
        sleep_mock.assert_not_called()

    def test_runtime_verify_requires_exact_clickhouse_database_match(self) -> None:
        manifest = {
            "window": {
                "start": "2026-03-06T14:30:00Z",
                "end": "2026-03-06T15:30:00Z",
            }
        }
        resources = open_hour_resources()
        wrong_database = f"{resources.clickhouse_db}_stale"
        kservice_payload = ready_knative_service(
            open_hour_trading_env(
                TRADING_STRATEGY_RUNTIME_MODE="scheduler_v3",
                TRADING_SIGNAL_TABLE=resources.clickhouse_signal_table,
                TRADING_PRICE_TABLE=resources.clickhouse_price_table,
                TRADING_ORDER_FEED_TOPIC=resources.simulation_topic_by_role[
                    "order_updates"
                ],
                TRADING_SIMULATION_ORDER_UPDATES_TOPIC=resources.simulation_topic_by_role[
                    "order_updates"
                ],
                TRADING_SIMULATION_RUN_ID=resources.run_id,
            ),
        )
        ta_configmap_payload = {
            "data": {
                "TA_TRADES_TOPIC": resources.simulation_topic_by_role["trades"],
                "TA_QUOTES_TOPIC": resources.simulation_topic_by_role["quotes"],
                "TA_BARS1M_TOPIC": resources.simulation_topic_by_role["bars"],
                "TA_MICROBARS_TOPIC": resources.simulation_topic_by_role[
                    "ta_microbars"
                ],
                "TA_SIGNALS_TOPIC": resources.simulation_topic_by_role["ta_signals"],
                "TA_CLICKHOUSE_URL": f"jdbc:clickhouse://clickhouse/{wrong_database}?run={resources.run_token}",
            }
        }

        with (
            patch_ready_compute(kservice_payload, ta_configmap_payload),
        ):
            report = _runtime_verify(resources=resources, manifest=manifest)

        self.assertEqual(report["runtime_state"], "not_ready")
        self.assertFalse(report["ta_runtime_config"]["clickhouse_database"])
        self.assertEqual(
            report["ta_runtime_config"]["expected_clickhouse_database"],
            resources.clickhouse_db,
        )
        self.assertEqual(
            report["ta_runtime_config"]["current_clickhouse_database"], wrong_database
        )

    def test_runtime_verify_derives_expected_clickhouse_database_from_signal_table_when_resource_field_missing(
        self,
    ) -> None:
        manifest = {
            "window": {
                "start": "2026-03-06T14:30:00Z",
                "end": "2026-03-06T15:30:00Z",
            }
        }
        resources = open_hour_resources()
        resources_without_db = SimpleNamespace(
            **{
                key: value
                for key, value in vars(resources).items()
                if key != "clickhouse_db"
            }
        )
        kservice_payload = ready_knative_service(
            open_hour_trading_env(
                TRADING_STRATEGY_RUNTIME_MODE="scheduler_v3",
                TRADING_SIGNAL_TABLE=resources.clickhouse_signal_table,
                TRADING_PRICE_TABLE=resources.clickhouse_price_table,
                TRADING_ORDER_FEED_TOPIC=resources.simulation_topic_by_role[
                    "order_updates"
                ],
                TRADING_SIMULATION_ORDER_UPDATES_TOPIC=resources.simulation_topic_by_role[
                    "order_updates"
                ],
                TRADING_SIMULATION_RUN_ID=resources.run_id,
            ),
        )
        ta_configmap_payload = {
            "data": {
                "TA_TRADES_TOPIC": resources.simulation_topic_by_role["trades"],
                "TA_QUOTES_TOPIC": resources.simulation_topic_by_role["quotes"],
                "TA_BARS1M_TOPIC": resources.simulation_topic_by_role["bars"],
                "TA_MICROBARS_TOPIC": resources.simulation_topic_by_role[
                    "ta_microbars"
                ],
                "TA_SIGNALS_TOPIC": resources.simulation_topic_by_role["ta_signals"],
                "TA_CLICKHOUSE_URL": f"jdbc:clickhouse://clickhouse/{resources.clickhouse_db}?run={resources.run_token}",
            }
        }

        with (
            patch_ready_compute(kservice_payload, ta_configmap_payload),
        ):
            report = _runtime_verify(resources=resources_without_db, manifest=manifest)

        self.assertEqual(report["runtime_state"], "ready")
        self.assertTrue(report["ta_runtime_config"]["clickhouse_database"])
        self.assertEqual(
            report["ta_runtime_config"]["expected_clickhouse_database"],
            resources.clickhouse_db,
        )
        self.assertEqual(
            report["ta_runtime_config"]["current_clickhouse_database"],
            resources.clickhouse_db,
        )

    def test_runtime_verify_accepts_options_lane_topics_and_tables(self) -> None:
        manifest = {
            "schema_version": "torghut.options-simulation-manifest.v1",
            "lane": "options",
            "feed": "indicative",
            "underlyings": ["AAPL"],
            "contract_policy": {"dte_min": 5, "dte_max": 45},
            "catalog_snapshot_ref": "artifacts/options/catalog.json",
            "raw_source_policy": {"prefer_kafka": True},
            "cost_model": {"contract_multiplier": 100},
            "proof_gates": {"minimum_contracts": 5},
            "window": {
                "start": "2026-03-06T14:30:00Z",
                "end": "2026-03-06T15:00:00Z",
            },
        }
        resources = _build_resources(
            "options-sim-2026-03-06-open",
            {
                **manifest,
                "dataset_id": "dataset-a",
                "runtime": {
                    "target_mode": "dedicated_service",
                    "namespace": "torghut",
                    "ta_configmap": "torghut-options-ta-sim-config",
                    "ta_deployment": "torghut-options-ta-sim",
                    "torghut_service": "torghut-sim",
                },
            },
        )
        kservice_payload = ready_knative_service(
            open_hour_trading_env(
                TRADING_STRATEGY_RUNTIME_MODE="scheduler_v3",
                TRADING_SIGNAL_TABLE=resources.clickhouse_signal_table,
                TRADING_PRICE_TABLE=resources.clickhouse_price_table,
                TRADING_ORDER_FEED_TOPIC=resources.simulation_topic_by_role[
                    "order_updates"
                ],
                TRADING_SIMULATION_ORDER_UPDATES_TOPIC=resources.simulation_topic_by_role[
                    "order_updates"
                ],
                TRADING_SIMULATION_RUN_ID=resources.run_id,
            ),
        )
        ta_configmap_payload = {
            "data": {
                "TOPIC_OPTIONS_CONTRACTS": resources.simulation_topic_by_role[
                    "contracts"
                ],
                "TOPIC_OPTIONS_TRADES": resources.simulation_topic_by_role["trades"],
                "TOPIC_OPTIONS_QUOTES": resources.simulation_topic_by_role["quotes"],
                "TOPIC_OPTIONS_SNAPSHOTS": resources.simulation_topic_by_role[
                    "snapshots"
                ],
                "TOPIC_OPTIONS_STATUS": resources.simulation_topic_by_role["status"],
                "TOPIC_OPTIONS_TA_CONTRACT_BARS": resources.simulation_topic_by_role[
                    "ta_contract_bars"
                ],
                "TOPIC_OPTIONS_TA_CONTRACT_FEATURES": resources.simulation_topic_by_role[
                    "ta_contract_features"
                ],
                "TOPIC_OPTIONS_TA_SURFACE_FEATURES": resources.simulation_topic_by_role[
                    "ta_surface_features"
                ],
                "TOPIC_OPTIONS_TA_STATUS": resources.simulation_topic_by_role[
                    "ta_status"
                ],
                "OPTIONS_TA_CLICKHOUSE_URL": "jdbc:clickhouse://clickhouse/torghut_sim_options_sim_2026_03_06_open",
            }
        }

        with (
            patch.object(
                runtime_health,
                "_kubectl_json",
                side_effect=[kservice_payload, ta_configmap_payload],
            ),
            patch.object(
                runtime_health,
                "_deployment_replica_health",
                side_effect=[
                    {
                        "name": "torghut-sim-00001-deployment",
                        "ready_replicas": 1,
                        "available_replicas": 1,
                        "replicas": 1,
                    },
                ],
            ),
            patch.object(
                runtime_health,
                "_flink_runtime_health",
                return_value={
                    "name": "torghut-options-ta-sim",
                    "desired_state": "running",
                    "lifecycle_state": "RUNNING",
                    "job_manager_status": "DEPLOYED",
                },
            ),
        ):
            report = _runtime_verify(resources=resources, manifest=manifest)

        self.assertEqual(report["runtime_state"], "ready")
        self.assertTrue(all(report["ta_runtime_config"].values()))

    def test_runtime_verify_rejects_simple_sim_runtime_without_order_feed_telemetry(
        self,
    ) -> None:
        manifest = {
            "window": {
                "start": "2026-03-06T14:30:00Z",
                "end": "2026-03-06T15:30:00Z",
            }
        }
        resources = open_hour_resources()
        kservice_payload = ready_knative_service(
            open_hour_trading_env(
                TRADING_PIPELINE_MODE="simple",
                TRADING_SIMPLE_ORDER_FEED_TELEMETRY_ENABLED="false",
                TRADING_STRATEGY_RUNTIME_MODE="scheduler_v3",
                TRADING_SIGNAL_TABLE=resources.clickhouse_signal_table,
                TRADING_PRICE_TABLE=resources.clickhouse_price_table,
                TRADING_ORDER_FEED_TOPIC=resources.simulation_topic_by_role[
                    "order_updates"
                ],
                TRADING_ORDER_FEED_AUTO_OFFSET_RESET="latest",
                TRADING_SIMULATION_ORDER_UPDATES_TOPIC=resources.simulation_topic_by_role[
                    "order_updates"
                ],
                TRADING_SIMULATION_RUN_ID=resources.run_id,
            ),
        )
        ta_configmap_payload = {
            "data": {
                "TA_TRADES_TOPIC": resources.simulation_topic_by_role["trades"],
                "TA_QUOTES_TOPIC": resources.simulation_topic_by_role["quotes"],
                "TA_BARS1M_TOPIC": resources.simulation_topic_by_role["bars"],
                "TA_MICROBARS_TOPIC": resources.simulation_topic_by_role[
                    "ta_microbars"
                ],
                "TA_SIGNALS_TOPIC": resources.simulation_topic_by_role["ta_signals"],
                "TA_CLICKHOUSE_URL": f"jdbc:clickhouse://clickhouse/{resources.clickhouse_db}",
            }
        }

        with (
            patch.object(
                runtime_health,
                "_kubectl_json",
                side_effect=[kservice_payload, ta_configmap_payload],
            ),
            patch.object(
                runtime_health,
                "_deployment_replica_health",
                return_value={
                    "name": "torghut-sim-00001-deployment",
                    "ready_replicas": 1,
                    "available_replicas": 1,
                    "replicas": 1,
                },
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
            report = _runtime_verify(resources=resources, manifest=manifest)

        trading_config = report["torghut_service"]["trading_config"]
        self.assertEqual(report["runtime_state"], "not_ready")
        self.assertFalse(trading_config["simple_order_feed_telemetry"])
        self.assertFalse(trading_config["order_feed_auto_offset_reset"])
