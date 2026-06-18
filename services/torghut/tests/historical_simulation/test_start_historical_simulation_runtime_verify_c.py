from __future__ import annotations

from tests.historical_simulation.start_historical_simulation_base import (
    SimpleNamespace,
    StartHistoricalSimulationTestCaseBase,
    _build_resources,
    _runtime_verify,
    historical_simulation_verification,
    patch,
)


class TestStartHistoricalSimulationRuntimeVerifyC(
    StartHistoricalSimulationTestCaseBase
):
    def test_runtime_verify_rejects_schema_registry_subject_failure(self) -> None:
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
                                        "name": "TRADING_STRATEGY_SCHEDULER_ENABLED",
                                        "value": "true",
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
                "TA_SCHEMA_REGISTRY_URL": "http://karapace.kafka:8081",
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
                "scripts.historical_simulation_verification_modules.runtime_health._kubectl_json",
                side_effect=[kservice_payload, ta_configmap_payload],
            ),
            patch(
                "scripts.historical_simulation_verification_modules.runtime_health._deployment_replica_health",
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
                "scripts.historical_simulation_verification_modules.runtime_health._flink_runtime_health",
                return_value={
                    "name": "torghut-ta-sim",
                    "desired_state": "running",
                    "lifecycle_state": "RUNNING",
                    "job_manager_status": "DEPLOYED",
                },
            ),
            patch(
                "scripts.historical_simulation_verification_modules.artifact_verification._http_json_get",
                side_effect=[(200, "[]"), (404, "{}"), (200, "{}")],
            ),
        ):
            report = _runtime_verify(resources=resources, manifest=manifest)

        self.assertEqual(report["runtime_state"], "not_ready")
        self.assertEqual(report["schema_registry"]["reason"], "schema_subject_missing")
        self.assertEqual(
            report["schema_registry"]["subjects_checked"],
            [
                f"{resources.simulation_topic_by_role['ta_microbars']}-value",
                f"{resources.simulation_topic_by_role['ta_signals']}-value",
            ],
        )
        self.assertEqual(
            report["schema_registry"]["subjects_missing"],
            [f"{resources.simulation_topic_by_role['ta_microbars']}-value"],
        )

    def test_flink_runtime_health_classifies_missing_restore_state(self) -> None:
        deployment = {
            "spec": {
                "job": {
                    "state": "running",
                    "upgradeMode": "last-state",
                }
            },
            "status": {
                "jobManagerDeploymentStatus": "MISSING",
                "jobStatus": {
                    "state": "FAILED",
                    "error": "Checkpoint path not found while restoring last-state",
                },
            },
        }

        with patch(
            "scripts.historical_simulation_verification_modules.shared_runtime._kubectl_json",
            return_value=deployment,
        ):
            health = historical_simulation_verification._flink_runtime_health(
                "torghut",
                "torghut-ta-sim",
            )

        self.assertEqual(health["restore_state_reason"], "restore_state_missing")
        self.assertEqual(health["upgrade_mode"], "last-state")

    def test_runtime_verify_rejects_stale_analysis_template_images(self) -> None:
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
                                "image": "registry.ide-newton.ts.net/lab/torghut@sha256:service",
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
                                        "name": "TRADING_STRATEGY_SCHEDULER_ENABLED",
                                        "value": "true",
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
        runtime_template_payload = {
            "spec": {
                "metrics": [
                    {
                        "provider": {
                            "job": {
                                "spec": {
                                    "template": {
                                        "spec": {
                                            "containers": [
                                                {
                                                    "image": "registry.ide-newton.ts.net/lab/torghut@sha256:stale"
                                                }
                                            ]
                                        }
                                    }
                                }
                            }
                        }
                    }
                ]
            }
        }
        activity_template_payload = {
            "spec": {
                "metrics": [
                    {
                        "provider": {
                            "job": {
                                "spec": {
                                    "template": {
                                        "spec": {
                                            "containers": [
                                                {
                                                    "image": "registry.ide-newton.ts.net/lab/torghut@sha256:service"
                                                }
                                            ]
                                        }
                                    }
                                }
                            }
                        }
                    }
                ]
            }
        }

        with (
            patch(
                "scripts.historical_simulation_verification_modules.runtime_health._kubectl_json",
                side_effect=[
                    kservice_payload,
                    ta_configmap_payload,
                ],
            ),
            patch(
                "scripts.historical_simulation_verification_modules.artifact_verification._kubectl_json",
                side_effect=[
                    runtime_template_payload,
                    activity_template_payload,
                ],
            ),
            patch(
                "scripts.historical_simulation_verification_modules.runtime_health._deployment_replica_health",
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
                "scripts.historical_simulation_verification_modules.runtime_health._flink_runtime_health",
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
        self.assertEqual(report["analysis_images"]["reason"], "analysis_image_stale")
        self.assertIn(
            "torghut-simulation-runtime-ready",
            report["analysis_images"]["mismatched_templates"],
        )

    def test_runtime_verify_uses_manifest_override_for_analysis_templates(self) -> None:
        manifest = {
            "window": {
                "start": "2026-03-06T14:30:00Z",
                "end": "2026-03-06T15:30:00Z",
            },
            "rollouts": {
                "runtime_template": "torghut-runtime-ready-v1",
                "activity_template": "torghut-sim-activity-v1",
            },
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
                                "image": "registry.ide-newton.ts.net/lab/torghut@sha256:service",
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
                                        "name": "TRADING_STRATEGY_SCHEDULER_ENABLED",
                                        "value": "true",
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
        runtime_template_payload = {
            "spec": {
                "metrics": [
                    {
                        "provider": {
                            "job": {
                                "spec": {
                                    "template": {
                                        "spec": {
                                            "containers": [
                                                {
                                                    "image": "registry.ide-newton.ts.net/lab/torghut@sha256:service"
                                                }
                                            ]
                                        }
                                    }
                                }
                            }
                        }
                    }
                ]
            }
        }
        activity_template_payload = runtime_template_payload

        with (
            patch(
                "scripts.historical_simulation_verification_modules.runtime_health._kubectl_json",
                side_effect=[
                    kservice_payload,
                    ta_configmap_payload,
                ],
            ),
            patch(
                "scripts.historical_simulation_verification_modules.artifact_verification._kubectl_json",
                side_effect=[
                    runtime_template_payload,
                    activity_template_payload,
                ],
            ) as analysis_kubectl_json,
            patch(
                "scripts.historical_simulation_verification_modules.runtime_health._deployment_replica_health",
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
                "scripts.historical_simulation_verification_modules.runtime_health._flink_runtime_health",
                return_value={
                    "name": "torghut-ta-sim",
                    "desired_state": "running",
                    "lifecycle_state": "RUNNING",
                    "job_manager_status": "DEPLOYED",
                },
            ),
        ):
            report = _runtime_verify(resources=resources, manifest=manifest)

        self.assertEqual(report["analysis_images"]["reason"], "ok")
        kubectl_calls = [
            call.args[1][2] for call in analysis_kubectl_json.call_args_list
        ]
        self.assertEqual(
            kubectl_calls, ["torghut-runtime-ready-v1", "torghut-sim-activity-v1"]
        )

    def test_teardown_clean_accepts_restored_warm_lane_baseline(self) -> None:
        resources = _build_resources(
            "sim-teardown-clean-warm-lane",
            {
                "dataset_id": "dataset-a",
                "runtime": {"use_warm_lane": True},
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
                                    {
                                        "name": "TRADING_SIMULATION_ENABLED",
                                        "value": "true",
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
                                        "name": "TRADING_ORDER_FEED_TOPIC",
                                        "value": "torghut.sim.trade-updates.v1",
                                    },
                                    {
                                        "name": "TRADING_ORDER_FEED_GROUP_ID",
                                        "value": resources.order_feed_group_id,
                                    },
                                    {
                                        "name": "TRADING_SIMULATION_ORDER_UPDATES_TOPIC",
                                        "value": "torghut.sim.trade-updates.v1",
                                    },
                                ],
                            }
                        ]
                    }
                }
            }
        }
        ta_configmap_payload = {
            "data": {
                "TA_GROUP_ID": resources.ta_group_id,
                "TA_CLICKHOUSE_URL": f"jdbc:clickhouse://clickhouse/{resources.clickhouse_db}",
            }
        }

        with (
            patch(
                "scripts.historical_simulation_verification_modules.artifact_verification._kubectl_json",
                side_effect=[kservice_payload, ta_configmap_payload],
            ),
            patch(
                "scripts.historical_simulation_verification_modules.artifact_verification._flink_runtime_health",
                return_value={
                    "name": "torghut-ta-sim",
                    "desired_state": "running",
                    "lifecycle_state": "RUNNING",
                    "job_manager_status": "DEPLOYED",
                },
            ),
        ):
            report = historical_simulation_verification._teardown_clean(
                resources=resources,
                postgres_config=SimpleNamespace(
                    torghut_runtime_dsn="postgresql://torghut@db/torghut_sim_default"
                ),
            )

        self.assertEqual(report["status"], "ok")
        self.assertEqual(report["activity_classification"], "success")
        self.assertTrue(report["restored"])
        self.assertTrue(report["warm_lane_enabled"])
        self.assertFalse(any(report["run_scoped_markers_present"].values()))
        self.assertTrue(all(report["warm_lane_baseline"].values()))

    def test_teardown_clean_accepts_restored_dedicated_service_baseline(self) -> None:
        resources = _build_resources(
            "sim-teardown-clean-dedicated-service",
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
                                    {
                                        "name": "DB_DSN",
                                        "value": (
                                            "postgresql://$(TORGHUT_SIM_DB_USER):$(TORGHUT_SIM_DB_PASSWORD)"
                                            "@$(TORGHUT_SIM_DB_HOST):$(TORGHUT_SIM_DB_PORT)/torghut_sim_default"
                                        ),
                                    },
                                    {
                                        "name": "TRADING_SIMULATION_ENABLED",
                                        "value": "true",
                                    },
                                    {
                                        "name": "TRADING_SIGNAL_TABLE",
                                        "value": "torghut_sim_default.ta_signals",
                                    },
                                    {
                                        "name": "TRADING_PRICE_TABLE",
                                        "value": "torghut_sim_default.ta_microbars",
                                    },
                                    {
                                        "name": "TRADING_ORDER_FEED_TOPIC",
                                        "value": "torghut.sim.trade-updates.v1",
                                    },
                                    {
                                        "name": "TRADING_ORDER_FEED_GROUP_ID",
                                        "value": "torghut-order-feed-sim-default",
                                    },
                                    {
                                        "name": "TRADING_SIMULATION_ORDER_UPDATES_TOPIC",
                                        "value": "torghut.sim.trade-updates.v1",
                                    },
                                ],
                            }
                        ]
                    }
                }
            }
        }
        ta_configmap_payload = {
            "data": {
                "TA_GROUP_ID": "torghut-ta-sim-default",
                "TA_CLICKHOUSE_URL": "jdbc:clickhouse://clickhouse/torghut_sim_default",
            }
        }

        with (
            patch(
                "scripts.historical_simulation_verification_modules.artifact_verification._kubectl_json",
                side_effect=[kservice_payload, ta_configmap_payload],
            ),
            patch(
                "scripts.historical_simulation_verification_modules.artifact_verification._flink_runtime_health",
                return_value={
                    "name": "torghut-ta-sim",
                    "desired_state": "suspended",
                    "lifecycle_state": "FINISHED",
                    "job_manager_status": "READY",
                },
            ),
        ):
            report = historical_simulation_verification._teardown_clean(
                resources=resources,
                postgres_config=SimpleNamespace(
                    torghut_runtime_dsn="postgresql://torghut@db/torghut_sim_2026_03_13_full_day_c981f25b"
                ),
            )

        self.assertEqual(report["status"], "ok")
        self.assertEqual(report["activity_classification"], "success")
        self.assertTrue(report["restored"])
        self.assertFalse(report["warm_lane_enabled"])
        self.assertFalse(any(report["run_scoped_markers_present"].values()))
        self.assertTrue(all(report["dedicated_service_baseline"].values()))

    def test_teardown_clean_accepts_disabled_dedicated_service_baseline(self) -> None:
        resources = _build_resources(
            "sim-teardown-clean-dedicated-service-disabled",
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
                                    {
                                        "name": "DB_DSN",
                                        "value": (
                                            "postgresql://$(TORGHUT_SIM_DB_USER):$(TORGHUT_SIM_DB_PASSWORD)"
                                            "@$(TORGHUT_SIM_DB_HOST):$(TORGHUT_SIM_DB_PORT)/torghut_sim_default"
                                        ),
                                    },
                                    {
                                        "name": "TRADING_SIMULATION_ENABLED",
                                        "value": "false",
                                    },
                                    {
                                        "name": "TRADING_ORDER_FEED_TOPIC",
                                        "value": "torghut.sim.trade-updates.v1",
                                    },
                                    {
                                        "name": "TRADING_ORDER_FEED_GROUP_ID",
                                        "value": "torghut-order-feed-sim-default",
                                    },
                                    {
                                        "name": "TRADING_SIMULATION_ORDER_UPDATES_TOPIC",
                                        "value": "torghut.sim.trade-updates.v1",
                                    },
                                ],
                            }
                        ]
                    }
                }
            }
        }
        ta_configmap_payload = {
            "data": {
                "TA_GROUP_ID": "torghut-ta-sim-default",
                "TA_CLICKHOUSE_URL": "jdbc:clickhouse://clickhouse/torghut_sim_default",
            }
        }

        with (
            patch(
                "scripts.historical_simulation_verification_modules.artifact_verification._kubectl_json",
                side_effect=[kservice_payload, ta_configmap_payload],
            ),
            patch(
                "scripts.historical_simulation_verification_modules.artifact_verification._flink_runtime_health",
                return_value={
                    "name": "torghut-ta-sim",
                    "desired_state": "running",
                    "lifecycle_state": "RUNNING",
                    "job_manager_status": "READY",
                },
            ),
        ):
            report = historical_simulation_verification._teardown_clean(
                resources=resources,
                postgres_config=SimpleNamespace(
                    torghut_runtime_dsn="postgresql://torghut@db/torghut_sim_2026_03_18_full_day_884bec35"
                ),
            )

        self.assertEqual(report["status"], "ok")
        self.assertEqual(report["activity_classification"], "success")
        self.assertTrue(report["restored"])
        self.assertFalse(report["warm_lane_enabled"])
        self.assertFalse(any(report["run_scoped_markers_present"].values()))
        self.assertFalse(any(report["simulation_markers_present"].values()))
        self.assertTrue(all(report["dedicated_service_disabled_baseline"].values()))

    def test_teardown_clean_rejects_run_scoped_markers_on_warm_lane(self) -> None:
        resources = _build_resources(
            "sim-teardown-clean-warm-lane-dirty",
            {
                "dataset_id": "dataset-a",
                "runtime": {"use_warm_lane": True},
            },
        )
        dirty_order_updates_topic = (
            f"torghut.sim.trade-updates.v1.{resources.run_token}"
        )
        kservice_payload = {
            "spec": {
                "template": {
                    "spec": {
                        "containers": [
                            {
                                "name": "user-container",
                                "env": [
                                    {
                                        "name": "TRADING_SIMULATION_ENABLED",
                                        "value": "true",
                                    },
                                    {
                                        "name": "TRADING_SIMULATION_RUN_ID",
                                        "value": resources.run_id,
                                    },
                                    {
                                        "name": "TRADING_SIMULATION_DATASET_ID",
                                        "value": resources.dataset_id,
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
                                        "name": "TRADING_ORDER_FEED_TOPIC",
                                        "value": dirty_order_updates_topic,
                                    },
                                    {
                                        "name": "TRADING_ORDER_FEED_GROUP_ID",
                                        "value": resources.order_feed_group_id,
                                    },
                                    {
                                        "name": "TRADING_SIMULATION_ORDER_UPDATES_TOPIC",
                                        "value": dirty_order_updates_topic,
                                    },
                                ],
                            }
                        ]
                    }
                }
            }
        }
        ta_configmap_payload = {
            "data": {
                "TA_GROUP_ID": resources.ta_group_id,
                "TA_CLICKHOUSE_URL": f"jdbc:clickhouse://clickhouse/{resources.clickhouse_db}",
            }
        }

        with (
            patch(
                "scripts.historical_simulation_verification_modules.artifact_verification._kubectl_json",
                side_effect=[kservice_payload, ta_configmap_payload],
            ),
            patch(
                "scripts.historical_simulation_verification_modules.artifact_verification._flink_runtime_health",
                return_value={
                    "name": "torghut-ta-sim",
                    "desired_state": "running",
                    "lifecycle_state": "RUNNING",
                    "job_manager_status": "DEPLOYED",
                },
            ),
        ):
            report = historical_simulation_verification._teardown_clean(
                resources=resources,
                postgres_config=SimpleNamespace(
                    torghut_runtime_dsn="postgresql://torghut@db/torghut_sim_default"
                ),
            )

        self.assertEqual(report["status"], "degraded")
        self.assertEqual(report["activity_classification"], "environment_incomplete")
        self.assertFalse(report["restored"])
        self.assertTrue(report["warm_lane_enabled"])
        self.assertTrue(
            report["run_scoped_markers_present"]["trading_simulation_run_id"]
        )
        self.assertTrue(
            report["run_scoped_markers_present"]["trading_simulation_dataset_id"]
        )
        self.assertTrue(report["run_scoped_markers_present"]["order_feed_topic"])
        self.assertTrue(
            report["run_scoped_markers_present"]["simulation_order_updates_topic"]
        )
