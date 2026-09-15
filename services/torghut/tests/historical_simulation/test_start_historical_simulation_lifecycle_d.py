from __future__ import annotations

from tests.historical_simulation.start_historical_simulation_base import (
    StartHistoricalSimulationTestCaseBase,
    _build_resources,
    _runtime_verify,
    patch,
)


class TestStartHistoricalSimulationLifecycleD(StartHistoricalSimulationTestCaseBase):
    def test_runtime_verify_rejects_simple_sim_runtime_without_order_feed_telemetry(
        self,
    ) -> None:
        manifest = {
            "window": {
                "start": "2026-03-06T14:30:00Z",
                "end": "2026-03-06T15:30:00Z",
            }
        }
        resources = _build_resources(
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
        kservice_payload = {
            "spec": {
                "template": {
                    "spec": {
                        "containers": [
                            {
                                "name": "user-container",
                                "env": [
                                    {"name": "TRADING_ENABLED", "value": "true"},
                                    {
                                        "name": "TRADING_PIPELINE_MODE",
                                        "value": "simple",
                                    },
                                    {
                                        "name": "TRADING_SIMPLE_ORDER_FEED_TELEMETRY_ENABLED",
                                        "value": "false",
                                    },
                                    {
                                        "name": "TRADING_SIMULATION_ENABLED",
                                        "value": "true",
                                    },
                                    {
                                        "name": "TRADING_STRATEGY_RUNTIME_MODE",
                                        "value": "scheduler_v3",
                                    },
                                    {
                                        "name": "TRADING_SIGNAL_TABLE",
                                        "value": resources.clickhouse_signal_table,
                                    },
                                    {
                                        "name": "TRADING_PRICE_TABLE",
                                        "value": resources.clickhouse_price_table,
                                    },
                                    {
                                        "name": "TRADING_ORDER_FEED_ENABLED",
                                        "value": "true",
                                    },
                                    {
                                        "name": "TRADING_ORDER_FEED_TOPIC",
                                        "value": resources.simulation_topic_by_role[
                                            "order_updates"
                                        ],
                                    },
                                    {
                                        "name": "TRADING_ORDER_FEED_AUTO_OFFSET_RESET",
                                        "value": "latest",
                                    },
                                    {
                                        "name": "TRADING_SIMULATION_ORDER_UPDATES_TOPIC",
                                        "value": resources.simulation_topic_by_role[
                                            "order_updates"
                                        ],
                                    },
                                    {
                                        "name": "TRADING_SIMULATION_RUN_ID",
                                        "value": resources.run_id,
                                    },
                                    {
                                        "name": "TRADING_SIGNAL_ALLOWED_SOURCES",
                                        "value": "ws,ta",
                                    },
                                ],
                            }
                        ]
                    }
                }
            },
            "status": {
                "latestReadyRevisionName": "torghut-sim-00001",
                "conditions": [{"type": "Ready", "status": "True"}],
            },
        }
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
            patch(
                "scripts.historical_simulation_runtime_verification.runtime_health._kubectl_json",
                side_effect=[kservice_payload, ta_configmap_payload],
            ),
            patch(
                "scripts.historical_simulation_runtime_verification.runtime_health._deployment_replica_health",
                return_value={
                    "name": "torghut-sim-00001-deployment",
                    "ready_replicas": 1,
                    "available_replicas": 1,
                    "replicas": 1,
                },
            ),
            patch(
                "scripts.historical_simulation_runtime_verification.runtime_health._flink_runtime_health",
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
