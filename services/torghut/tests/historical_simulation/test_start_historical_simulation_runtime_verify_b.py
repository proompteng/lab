from __future__ import annotations

from tests.historical_simulation.start_historical_simulation_base import (
    StartHistoricalSimulationTestCaseBase,
    _build_resources,
    _runtime_verify,
    patch,
)


class TestStartHistoricalSimulationRuntimeVerifyB(
    StartHistoricalSimulationTestCaseBase
):
    def test_runtime_verify_reads_strategy_runtime_flags_from_envfrom_configmap(
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
                                "envFrom": [
                                    {
                                        "configMapRef": {
                                            "name": "torghut-autonomy-config"
                                        }
                                    },
                                ],
                                "env": [
                                    {"name": "TRADING_ENABLED", "value": "true"},
                                    {
                                        "name": "TRADING_SIMULATION_ENABLED",
                                        "value": "true",
                                    },
                                    {
                                        "name": "TRADING_SIGNAL_TABLE",
                                        "value": "torghut_sim_sim_2026_03_06_open_hour.ta_signals",
                                    },
                                    {
                                        "name": "TRADING_PRICE_TABLE",
                                        "value": "torghut_sim_sim_2026_03_06_open_hour.ta_microbars",
                                    },
                                    {
                                        "name": "TRADING_ORDER_FEED_ENABLED",
                                        "value": "true",
                                    },
                                    {
                                        "name": "TRADING_ORDER_FEED_TOPIC",
                                        "value": "torghut.sim.trade-updates.v1.sim_2026_03_06_open_hour",
                                    },
                                    {
                                        "name": "TRADING_SIMULATION_ORDER_UPDATES_TOPIC",
                                        "value": "torghut.sim.trade-updates.v1.sim_2026_03_06_open_hour",
                                    },
                                    {
                                        "name": "TRADING_SIMULATION_RUN_ID",
                                        "value": "sim-2026-03-06-open-hour",
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
                "conditions": [
                    {
                        "type": "Ready",
                        "status": "True",
                    }
                ],
            },
        }
        autonomy_configmap_payload = {
            "data": {
                "TRADING_STRATEGY_RUNTIME_MODE": "scheduler_v3",
            }
        }
        ta_configmap_payload = {
            "data": {
                "TA_TRADES_TOPIC": "torghut.sim.trades.v1.sim_2026_03_06_open_hour",
                "TA_QUOTES_TOPIC": "torghut.sim.quotes.v1.sim_2026_03_06_open_hour",
                "TA_BARS1M_TOPIC": "torghut.sim.bars.1m.v1.sim_2026_03_06_open_hour",
                "TA_MICROBARS_TOPIC": "torghut.sim.ta.bars.1s.v1.sim_2026_03_06_open_hour",
                "TA_SIGNALS_TOPIC": "torghut.sim.ta.signals.v1.sim_2026_03_06_open_hour",
                "TA_CLICKHOUSE_URL": f"jdbc:clickhouse://clickhouse/{resources.clickhouse_db}",
            }
        }

        with (
            patch(
                "scripts.historical_simulation_runtime_verification.runtime_health._kubectl_json",
                side_effect=[
                    kservice_payload,
                    autonomy_configmap_payload,
                    ta_configmap_payload,
                ],
            ),
            patch(
                "scripts.historical_simulation_runtime_verification.runtime_health._deployment_replica_health",
                side_effect=[
                    {
                        "name": "torghut-sim-00001-deployment",
                        "ready_replicas": 1,
                        "available_replicas": 1,
                        "replicas": 1,
                    },
                ],
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

        self.assertEqual(report["runtime_state"], "ready")
        self.assertTrue(
            report["torghut_service"]["trading_config"]["strategy_runtime_active"]
        )

    def test_runtime_verify_uses_scheduler_runtime_without_migration_flag(self) -> None:
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
                                        "name": "TRADING_SIMULATION_ENABLED",
                                        "value": "true",
                                    },
                                    {
                                        "name": "TRADING_STRATEGY_RUNTIME_MODE",
                                        "value": "scheduler_v3",
                                    },
                                    {
                                        "name": "TRADING_SIGNAL_TABLE",
                                        "value": "torghut_sim_sim_2026_03_06_open_hour.ta_signals",
                                    },
                                    {
                                        "name": "TRADING_PRICE_TABLE",
                                        "value": "torghut_sim_sim_2026_03_06_open_hour.ta_microbars",
                                    },
                                    {
                                        "name": "TRADING_ORDER_FEED_ENABLED",
                                        "value": "true",
                                    },
                                    {
                                        "name": "TRADING_ORDER_FEED_TOPIC",
                                        "value": "torghut.sim.trade-updates.v1.sim_2026_03_06_open_hour",
                                    },
                                    {
                                        "name": "TRADING_SIMULATION_ORDER_UPDATES_TOPIC",
                                        "value": "torghut.sim.trade-updates.v1.sim_2026_03_06_open_hour",
                                    },
                                    {
                                        "name": "TRADING_SIMULATION_RUN_ID",
                                        "value": "sim-2026-03-06-open-hour",
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
                "conditions": [
                    {
                        "type": "Ready",
                        "status": "True",
                    }
                ],
            },
        }
        ta_configmap_payload = {
            "data": {
                "TA_TRADES_TOPIC": "torghut.sim.trades.v1.sim_2026_03_06_open_hour",
                "TA_QUOTES_TOPIC": "torghut.sim.quotes.v1.sim_2026_03_06_open_hour",
                "TA_BARS1M_TOPIC": "torghut.sim.bars.1m.v1.sim_2026_03_06_open_hour",
                "TA_MICROBARS_TOPIC": "torghut.sim.ta.bars.1s.v1.sim_2026_03_06_open_hour",
                "TA_SIGNALS_TOPIC": "torghut.sim.ta.signals.v1.sim_2026_03_06_open_hour",
                "TA_CLICKHOUSE_URL": "jdbc:clickhouse://clickhouse/torghut_sim_2026_03_06_open_hour",
            }
        }

        with (
            patch(
                "scripts.historical_simulation_runtime_verification.runtime_health._kubectl_json",
                side_effect=[kservice_payload, ta_configmap_payload],
            ),
            patch(
                "scripts.historical_simulation_runtime_verification.runtime_health._deployment_replica_health",
                side_effect=[
                    {
                        "name": "torghut-sim-00001-deployment",
                        "ready_replicas": 1,
                        "available_replicas": 1,
                        "replicas": 1,
                    },
                ],
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

        self.assertEqual(report["runtime_state"], "not_ready")
        self.assertTrue(
            report["torghut_service"]["trading_config"]["strategy_runtime_active"]
        )

    def test_runtime_verify_rejects_trading_disabled_sim_revision(self) -> None:
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
                                    {"name": "TRADING_ENABLED", "value": "false"},
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
                                        "value": "torghut_sim_sim_2026_03_06_open_hour.ta_signals",
                                    },
                                    {
                                        "name": "TRADING_PRICE_TABLE",
                                        "value": "torghut_sim_sim_2026_03_06_open_hour.ta_microbars",
                                    },
                                    {
                                        "name": "TRADING_ORDER_FEED_ENABLED",
                                        "value": "true",
                                    },
                                    {
                                        "name": "TRADING_ORDER_FEED_TOPIC",
                                        "value": "torghut.sim.trade-updates.v1.sim_2026_03_06_open_hour",
                                    },
                                    {
                                        "name": "TRADING_SIMULATION_ORDER_UPDATES_TOPIC",
                                        "value": "torghut.sim.trade-updates.v1.sim_2026_03_06_open_hour",
                                    },
                                    {
                                        "name": "TRADING_SIMULATION_RUN_ID",
                                        "value": "sim-2026-03-06-open-hour",
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
                "conditions": [
                    {
                        "type": "Ready",
                        "status": "True",
                    }
                ],
            },
        }
        ta_configmap_payload = {
            "data": {
                "TA_TRADES_TOPIC": "torghut.sim.trades.v1.sim_2026_03_06_open_hour",
                "TA_QUOTES_TOPIC": "torghut.sim.quotes.v1.sim_2026_03_06_open_hour",
                "TA_BARS1M_TOPIC": "torghut.sim.bars.1m.v1.sim_2026_03_06_open_hour",
                "TA_MICROBARS_TOPIC": "torghut.sim.ta.bars.1s.v1.sim_2026_03_06_open_hour",
                "TA_SIGNALS_TOPIC": "torghut.sim.ta.signals.v1.sim_2026_03_06_open_hour",
                "TA_CLICKHOUSE_URL": "jdbc:clickhouse://clickhouse/torghut_sim_2026_03_06_open_hour",
            }
        }

        with (
            patch(
                "scripts.historical_simulation_runtime_verification.runtime_health._kubectl_json",
                side_effect=[kservice_payload, ta_configmap_payload],
            ),
            patch(
                "scripts.historical_simulation_runtime_verification.runtime_health._deployment_replica_health",
                side_effect=[
                    {
                        "name": "torghut-sim-00001-deployment",
                        "ready_replicas": 1,
                        "available_replicas": 1,
                        "replicas": 1,
                    },
                ],
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

        self.assertEqual(report["runtime_state"], "not_ready")
        self.assertEqual(report["environment_state"], "environment_incomplete")
        self.assertFalse(report["torghut_service"]["trading_config"]["trading_enabled"])

    def test_runtime_verify_rejects_ta_topic_mismatch(self) -> None:
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
                                        "name": "TRADING_SIMULATION_ENABLED",
                                        "value": "true",
                                    },
                                    {
                                        "name": "TRADING_STRATEGY_RUNTIME_MODE",
                                        "value": "scheduler_v3",
                                    },
                                    {
                                        "name": "TRADING_SIGNAL_TABLE",
                                        "value": "torghut_sim_sim_2026_03_06_open_hour.ta_signals",
                                    },
                                    {
                                        "name": "TRADING_PRICE_TABLE",
                                        "value": "torghut_sim_sim_2026_03_06_open_hour.ta_microbars",
                                    },
                                    {
                                        "name": "TRADING_ORDER_FEED_ENABLED",
                                        "value": "true",
                                    },
                                    {
                                        "name": "TRADING_ORDER_FEED_TOPIC",
                                        "value": "torghut.sim.trade-updates.v1.sim_2026_03_06_open_hour",
                                    },
                                    {
                                        "name": "TRADING_SIMULATION_ORDER_UPDATES_TOPIC",
                                        "value": "torghut.sim.trade-updates.v1.sim_2026_03_06_open_hour",
                                    },
                                    {
                                        "name": "TRADING_SIMULATION_RUN_ID",
                                        "value": "sim-2026-03-06-open-hour",
                                    },
                                    {
                                        "name": "TRADING_SIGNAL_ALLOWED_SOURCES",
                                        "value": "ws",
                                    },
                                ],
                            }
                        ]
                    }
                }
            },
            "status": {
                "latestReadyRevisionName": "torghut-sim-00001",
                "conditions": [
                    {
                        "type": "Ready",
                        "status": "True",
                    }
                ],
            },
        }
        ta_configmap_payload = {
            "data": {
                "TA_TRADES_TOPIC": "torghut.sim.trades.v1.sim_2026_03_06_open_hour_r18",
                "TA_QUOTES_TOPIC": "torghut.sim.quotes.v1.sim_2026_03_06_open_hour_r18",
                "TA_BARS1M_TOPIC": "torghut.sim.bars.1m.v1.sim_2026_03_06_open_hour_r18",
                "TA_MICROBARS_TOPIC": "torghut.sim.ta.bars.1s.v1.sim_2026_03_06_open_hour_r18",
                "TA_SIGNALS_TOPIC": "torghut.sim.ta.signals.v1.sim_2026_03_06_open_hour_r18",
                "TA_CLICKHOUSE_URL": "jdbc:clickhouse://clickhouse/torghut_sim_2026_03_06_open_hour_r18",
            }
        }

        with (
            patch(
                "scripts.historical_simulation_runtime_verification.runtime_health._kubectl_json",
                side_effect=[kservice_payload, ta_configmap_payload],
            ),
            patch(
                "scripts.historical_simulation_runtime_verification.runtime_health._deployment_replica_health",
                side_effect=[
                    {
                        "name": "torghut-sim-00001-deployment",
                        "ready_replicas": 1,
                        "available_replicas": 1,
                        "replicas": 1,
                    },
                ],
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

        self.assertEqual(report["runtime_state"], "not_ready")
        self.assertEqual(report["environment_state"], "environment_incomplete")
        self.assertFalse(report["ta_runtime_config"]["trades_topic"])

    def test_runtime_verify_rejects_missing_ta_signal_source_allowlist(self) -> None:
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
                                        "name": "TRADING_SIMULATION_ENABLED",
                                        "value": "true",
                                    },
                                    {
                                        "name": "TRADING_STRATEGY_RUNTIME_MODE",
                                        "value": "scheduler_v3",
                                    },
                                    {
                                        "name": "TRADING_SIGNAL_TABLE",
                                        "value": "torghut_sim_sim_2026_03_06_open_hour.ta_signals",
                                    },
                                    {
                                        "name": "TRADING_PRICE_TABLE",
                                        "value": "torghut_sim_sim_2026_03_06_open_hour.ta_microbars",
                                    },
                                    {
                                        "name": "TRADING_ORDER_FEED_ENABLED",
                                        "value": "true",
                                    },
                                    {
                                        "name": "TRADING_ORDER_FEED_TOPIC",
                                        "value": "torghut.sim.trade-updates.v1.sim_2026_03_06_open_hour",
                                    },
                                    {
                                        "name": "TRADING_SIMULATION_ORDER_UPDATES_TOPIC",
                                        "value": "torghut.sim.trade-updates.v1.sim_2026_03_06_open_hour",
                                    },
                                    {
                                        "name": "TRADING_SIMULATION_RUN_ID",
                                        "value": "sim-2026-03-06-open-hour",
                                    },
                                    {
                                        "name": "TRADING_SIGNAL_ALLOWED_SOURCES",
                                        "value": "ws",
                                    },
                                ],
                            }
                        ]
                    }
                }
            },
            "status": {
                "latestReadyRevisionName": "torghut-sim-00001",
                "conditions": [
                    {
                        "type": "Ready",
                        "status": "True",
                    }
                ],
            },
        }
        ta_configmap_payload = {
            "data": {
                "TA_TRADES_TOPIC": "torghut.sim.trades.v1.sim_2026_03_06_open_hour",
                "TA_QUOTES_TOPIC": "torghut.sim.quotes.v1.sim_2026_03_06_open_hour",
                "TA_BARS1M_TOPIC": "torghut.sim.bars.1m.v1.sim_2026_03_06_open_hour",
                "TA_MICROBARS_TOPIC": "torghut.sim.ta.bars.1s.v1.sim_2026_03_06_open_hour",
                "TA_SIGNALS_TOPIC": "torghut.sim.ta.signals.v1.sim_2026_03_06_open_hour",
                "TA_CLICKHOUSE_URL": "jdbc:clickhouse://clickhouse/torghut_sim_2026_03_06_open_hour",
            }
        }

        with (
            patch(
                "scripts.historical_simulation_runtime_verification.runtime_health._kubectl_json",
                side_effect=[kservice_payload, ta_configmap_payload],
            ),
            patch(
                "scripts.historical_simulation_runtime_verification.runtime_health._deployment_replica_health",
                side_effect=[
                    {
                        "name": "torghut-sim-00001-deployment",
                        "ready_replicas": 1,
                        "available_replicas": 1,
                        "replicas": 1,
                    },
                ],
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

        self.assertEqual(report["runtime_state"], "not_ready")
        self.assertEqual(report["environment_state"], "environment_incomplete")
        self.assertFalse(
            report["torghut_service"]["trading_config"]["signal_allowed_sources"]
        )
