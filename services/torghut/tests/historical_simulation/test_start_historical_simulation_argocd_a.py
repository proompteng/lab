from __future__ import annotations

from tests.historical_simulation.start_historical_simulation_base import (
    ArgocdAutomationConfig,
    ClickHouseRuntimeConfig,
    Path,
    PostgresRuntimeConfig,
    RolloutsAnalysisConfig,
    StartHistoricalSimulationTestCaseBase,
    TemporaryDirectory,
    _build_argocd_automation_config,
    _build_autonomy_lane_config,
    _build_resources,
    _build_rollouts_analysis_config,
    _discover_applicationset_entry,
    _run_rollouts_analysis,
    _set_argocd_application_sync_policy,
    _set_argocd_automation_mode,
    patch,
    start_historical_simulation,
    yaml,
)


class TestStartHistoricalSimulationArgocdA(StartHistoricalSimulationTestCaseBase):
    def test_build_argocd_automation_config_defaults(self) -> None:
        config = _build_argocd_automation_config({})
        self.assertFalse(config.manage_automation)
        self.assertEqual(config.applicationset_name, "product")
        self.assertEqual(config.applicationset_namespace, "argocd")
        self.assertEqual(config.app_name, "torghut")

    def test_build_argocd_automation_config_preserves_dedicated_service_opt_in(
        self,
    ) -> None:
        config = _build_argocd_automation_config(
            {
                "runtime": {"target_mode": "dedicated_service"},
                "argocd": {"manage_automation": True},
            }
        )

        self.assertTrue(config.manage_automation)

    def test_build_rollouts_analysis_config_defaults(self) -> None:
        config = _build_rollouts_analysis_config({})
        self.assertFalse(config.enabled)
        self.assertEqual(config.namespace, "torghut")
        self.assertEqual(config.runtime_template, "torghut-simulation-runtime-ready")
        self.assertEqual(config.activity_template, "torghut-simulation-activity")
        self.assertEqual(config.teardown_template, "torghut-simulation-teardown-clean")
        self.assertEqual(config.verify_poll_seconds, 5)

    def test_build_autonomy_lane_config_resolves_manifest_relative_paths(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            manifest_path = root / "config" / "dataset.yaml"
            manifest_path.parent.mkdir(parents=True, exist_ok=True)
            signals_path = root / "fixtures" / "signals.json"
            strategy_config_path = root / "configs" / "strategy.yaml"
            gate_policy_path = root / "configs" / "gate-policy.json"
            alpha_train_path = root / "alpha" / "train.csv"
            alpha_test_path = root / "alpha" / "test.csv"
            alpha_gate_policy_path = root / "alpha" / "gate-policy.json"
            for path in (
                signals_path,
                strategy_config_path,
                gate_policy_path,
                alpha_train_path,
                alpha_test_path,
                alpha_gate_policy_path,
            ):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("stub", encoding="utf-8")
            resources = _build_resources("sim-1", {"dataset_id": "dataset-a"})

            config = _build_autonomy_lane_config(
                {
                    "autonomy": {
                        "enabled": True,
                        "signals": "../fixtures/signals.json",
                        "strategy_config": "../configs/strategy.yaml",
                        "gate_policy": "../configs/gate-policy.json",
                        "repository": "proompteng/lab",
                        "base": "main",
                        "head": "codex/strategy-factory",
                        "priority_id": "ARC-2000",
                        "promotion_target": "shadow",
                        "alpha_train_prices": "../alpha/train.csv",
                        "alpha_test_prices": "../alpha/test.csv",
                        "alpha_gate_policy": "../alpha/gate-policy.json",
                        "no_persist_results": True,
                    }
                },
                manifest_path=manifest_path,
                resources=resources,
            )

        self.assertTrue(config.enabled)
        self.assertEqual(config.signals_path, signals_path.resolve())
        self.assertEqual(config.strategy_config_path, strategy_config_path.resolve())
        self.assertEqual(config.gate_policy_path, gate_policy_path.resolve())
        self.assertEqual(config.alpha_train_prices_path, alpha_train_path.resolve())
        self.assertEqual(config.alpha_test_prices_path, alpha_test_path.resolve())
        self.assertEqual(
            config.alpha_gate_policy_path, alpha_gate_policy_path.resolve()
        )
        self.assertEqual(config.repository, "proompteng/lab")
        self.assertEqual(config.promotion_target, "shadow")
        self.assertFalse(config.persist_results)
        self.assertEqual(
            config.output_dir, resources.output_root / resources.run_token / "autonomy"
        )

    def test_build_autonomy_lane_config_defaults_to_disabled(self) -> None:
        resources = _build_resources("sim-1", {"dataset_id": "dataset-a"})

        config = _build_autonomy_lane_config(
            {},
            manifest_path=Path("/tmp/dataset.yaml"),
            resources=resources,
        )

        self.assertFalse(config.enabled)

    def test_build_autonomy_lane_config_rejects_invalid_promotion_target(self) -> None:
        resources = _build_resources("sim-1", {"dataset_id": "dataset-a"})

        with self.assertRaisesRegex(
            RuntimeError,
            "autonomy.promotion_target must be one of: shadow,paper,live",
        ):
            _build_autonomy_lane_config(
                {
                    "autonomy": {
                        "enabled": True,
                        "promotion_target": "invalid",
                    }
                },
                manifest_path=Path("/tmp/dataset.yaml"),
                resources=resources,
            )

    def test_run_simulation_autonomy_lane_requires_required_inputs(self) -> None:
        resources = _build_resources("sim-1", {"dataset_id": "dataset-a"})

        self.assertIsNone(
            start_historical_simulation._run_simulation_autonomy_lane(
                resources=resources,
                autonomy_config=start_historical_simulation.AutonomyLaneConfig(
                    enabled=False
                ),
            )
        )

        with self.assertRaisesRegex(RuntimeError, "autonomy.signals is required"):
            start_historical_simulation._run_simulation_autonomy_lane(
                resources=resources,
                autonomy_config=start_historical_simulation.AutonomyLaneConfig(
                    enabled=True
                ),
            )

    def test_resolve_manifest_relative_path_rejects_missing_file(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "autonomy.signals not found"):
            start_historical_simulation._resolve_manifest_relative_path(
                "../missing/signals.json",
                manifest_path=Path("/tmp/config/dataset.yaml"),
                label="autonomy.signals",
            )

    def test_run_rollouts_analysis_materializes_analysisrun_from_template(self) -> None:
        resources = _build_resources(
            "sim-2026-03-06-open-hour", {"dataset_id": "dataset-a"}
        )
        manifest = {
            "window": {
                "start": "2026-03-06T14:30:00Z",
                "end": "2026-03-06T15:30:00Z",
            },
            "monitor": {
                "timeout_seconds": 60,
                "poll_seconds": 5,
                "min_trade_decisions": 1,
                "min_executions": 1,
                "min_execution_tca_metrics": 1,
                "min_execution_order_events": 1,
                "cursor_grace_seconds": 10,
            },
        }
        postgres_config = PostgresRuntimeConfig(
            admin_dsn="postgresql://torghut:secret@localhost:5432/postgres",
            simulation_dsn="postgresql://torghut:secret@localhost:5432/torghut_sim_sim_1",
            simulation_db="torghut_sim_sim_1",
            migrations_command="true",
        )
        clickhouse_config = ClickHouseRuntimeConfig(
            http_url="http://clickhouse:8123",
            username="torghut",
            password=None,
        )
        rollouts_config = RolloutsAnalysisConfig(
            enabled=True,
            namespace="torghut",
            runtime_template="torghut-simulation-runtime-ready",
            activity_template="torghut-simulation-activity",
            teardown_template="torghut-simulation-teardown-clean",
            artifact_template="torghut-simulation-artifact-bundle",
            verify_timeout_seconds=60,
            verify_poll_seconds=5,
        )
        captured_apply: dict[str, object] = {}

        def _fake_kubectl_json(namespace: str, args: list[str]) -> dict[str, object]:
            self.assertEqual(namespace, "torghut")
            if args[:3] == [
                "get",
                "analysistemplate",
                "torghut-simulation-runtime-ready",
            ]:
                return {
                    "spec": {
                        "args": [
                            {"name": "runId"},
                            {"name": "datasetId"},
                            {"name": "namespace"},
                            {"name": "torghutService"},
                            {"name": "taDeployment"},
                            {"name": "windowStart"},
                            {"name": "windowEnd"},
                            {"name": "signalTable"},
                            {"name": "priceTable"},
                            {"name": "runtimeVerifyTimeoutSeconds"},
                            {"name": "runtimeVerifyPollSeconds"},
                        ],
                        "metrics": [{"name": "runtime-ready"}],
                    }
                }
            if args[:3] == [
                "get",
                "analysisrun",
                "torghut-sim-runtime-ready-sim-2026-03-06-open-hour",
            ]:
                return {"status": {"phase": "Successful"}}
            raise AssertionError(f"unexpected kubectl args: {args}")

        with (
            patch(
                "scripts.start_historical_simulation_modules.argocd_rollouts._kubectl_delete_if_exists",
                return_value=None,
            ),
            patch(
                "scripts.start_historical_simulation_modules.argocd_rollouts._kubectl_apply",
                side_effect=lambda namespace, payload: captured_apply.update(
                    {"namespace": namespace, "payload": payload}
                ),
            ),
            patch(
                "scripts.start_historical_simulation_modules.argocd_rollouts._kubectl_json",
                side_effect=_fake_kubectl_json,
            ),
        ):
            report = _run_rollouts_analysis(
                resources=resources,
                manifest=manifest,
                postgres_config=postgres_config,
                clickhouse_config=clickhouse_config,
                rollouts_config=rollouts_config,
                phase="runtime-ready",
                template_name="torghut-simulation-runtime-ready",
            )

        self.assertEqual(report["phase"], "Successful")
        payload = captured_apply["payload"]
        self.assertIsInstance(payload, dict)
        assert isinstance(payload, dict)
        self.assertEqual(payload["kind"], "AnalysisRun")
        self.assertEqual(
            payload["metadata"]["name"],
            "torghut-sim-runtime-ready-sim-2026-03-06-open-hour",
        )
        args_by_name = {
            entry["name"]: entry["value"] for entry in payload["spec"]["args"]
        }
        self.assertEqual(
            args_by_name["signalTable"],
            "torghut_sim_sim_2026_03_06_open_hour.ta_signals",
        )
        self.assertEqual(
            args_by_name["priceTable"],
            "torghut_sim_sim_2026_03_06_open_hour.ta_microbars",
        )
        self.assertEqual(args_by_name["runtimeVerifyTimeoutSeconds"], "60")
        self.assertEqual(args_by_name["runtimeVerifyPollSeconds"], "5")

    def test_runtime_ready_template_declares_signal_and_price_tables(self) -> None:
        template_path = (
            Path(__file__).resolve().parents[4]
            / "argocd"
            / "applications"
            / "torghut"
            / "analysis-template-runtime-ready.yaml"
        )
        template = yaml.safe_load(template_path.read_text(encoding="utf-8"))
        spec = template["spec"]
        arg_names = [entry["name"] for entry in spec["args"]]
        self.assertIn("signalTable", arg_names)
        self.assertIn("priceTable", arg_names)
        args_text = spec["metrics"][0]["provider"]["job"]["spec"]["template"]["spec"][
            "containers"
        ][0]["args"][0]
        self.assertIn('--signal-table "{{args.signalTable}}"', args_text)
        self.assertIn('--price-table "{{args.priceTable}}"', args_text)

    def test_simulation_analysis_templates_do_not_pass_unsupported_forecast_service_arg(
        self,
    ) -> None:
        templates_dir = (
            Path(__file__).resolve().parents[4] / "argocd" / "applications" / "torghut"
        )
        template_names = [
            "analysis-template-runtime-ready.yaml",
            "analysis-template-activity.yaml",
            "analysis-template-teardown-clean.yaml",
        ]
        for template_name in template_names:
            with self.subTest(template_name=template_name):
                template = yaml.safe_load(
                    (templates_dir / template_name).read_text(encoding="utf-8")
                )
                spec = template["spec"]
                arg_names = [entry["name"] for entry in spec["args"]]
                args_text = spec["metrics"][0]["provider"]["job"]["spec"]["template"][
                    "spec"
                ]["containers"][0]["args"][0]
                self.assertNotIn("forecastService", arg_names)
                self.assertNotIn("--forecast-service", args_text)

    def test_discover_applicationset_entry_finds_nested_element(self) -> None:
        payload = {
            "spec": {
                "generators": [
                    {
                        "matrix": {
                            "generators": [
                                {"git": {"repoURL": "https://example.invalid"}},
                                {
                                    "list": {
                                        "elements": [
                                            {"name": "other", "automation": "auto"},
                                            {"name": "torghut", "automation": "manual"},
                                        ]
                                    }
                                },
                            ]
                        }
                    }
                ]
            }
        }
        discovered = _discover_applicationset_entry(payload, app_name="torghut")
        self.assertIsNotNone(discovered)
        assert discovered is not None
        pointer, entry = discovered
        self.assertIn("/spec/", pointer)
        self.assertEqual(entry["automation"], "manual")

    def test_set_argocd_automation_mode_patches_and_verifies(self) -> None:
        payload_auto = {
            "spec": {
                "generators": [
                    {
                        "list": {
                            "elements": [
                                {"name": "torghut", "automation": "auto"},
                            ]
                        }
                    }
                ]
            }
        }
        payload_manual = {
            "spec": {
                "generators": [
                    {
                        "list": {
                            "elements": [
                                {"name": "torghut", "automation": "manual"},
                            ]
                        }
                    }
                ]
            }
        }
        with (
            patch(
                "scripts.start_historical_simulation_modules.kubernetes_argocd._kubectl_json_global",
                side_effect=[payload_auto, payload_manual],
            ),
            patch(
                "scripts.start_historical_simulation_modules.kubernetes_argocd._kubectl_patch_json"
            ) as patch_mock,
        ):
            report = _set_argocd_automation_mode(
                config=ArgocdAutomationConfig(
                    manage_automation=True,
                    applicationset_name="product",
                    applicationset_namespace="argocd",
                    app_name="torghut",
                    root_app_name="root",
                    desired_mode_during_run="manual",
                    restore_mode_after_run="previous",
                    verify_timeout_seconds=30,
                ),
                desired_mode="manual",
            )
        self.assertTrue(report["changed"])
        patch_mock.assert_called_once()
        self.assertEqual(report["current_mode"], "manual")

    def test_set_argocd_application_sync_policy_patches_and_verifies(self) -> None:
        payload_auto = {
            "spec": {
                "syncPolicy": {
                    "automated": {
                        "enabled": True,
                        "prune": True,
                        "selfHeal": True,
                    },
                    "syncOptions": ["CreateNamespace=true"],
                }
            }
        }
        payload_manual = {
            "spec": {
                "syncPolicy": {
                    "automated": {
                        "enabled": False,
                        "prune": False,
                        "selfHeal": False,
                    },
                    "syncOptions": ["CreateNamespace=true"],
                }
            }
        }
        with (
            patch(
                "scripts.start_historical_simulation_modules.kubernetes_argocd._kubectl_json_global",
                side_effect=[payload_auto, payload_manual],
            ),
            patch(
                "scripts.start_historical_simulation_modules.kubernetes_argocd._kubectl_patch"
            ) as patch_mock,
        ):
            report = _set_argocd_application_sync_policy(
                config=ArgocdAutomationConfig(
                    manage_automation=True,
                    applicationset_name="product",
                    applicationset_namespace="argocd",
                    app_name="torghut",
                    root_app_name="root",
                    desired_mode_during_run="manual",
                    restore_mode_after_run="previous",
                    verify_timeout_seconds=30,
                ),
                desired_sync_policy=payload_manual["spec"]["syncPolicy"],
            )
        self.assertTrue(report["changed"])
        patch_mock.assert_called_once()
        self.assertEqual(
            report["current_sync_policy"]["automated"],
            {"enabled": False, "prune": False, "selfHeal": False},
        )

    def test_set_argocd_application_ignore_differences_patches_and_verifies(
        self,
    ) -> None:
        runtime_ignore_differences = [
            {
                "group": "serving.knative.dev",
                "kind": "Service",
                "namespace": "torghut",
                "name": "torghut-sim",
                "jqPathExpressions": [
                    start_historical_simulation.SIMULATION_TORGHUT_RUNTIME_ENV_IGNORE_JQ
                ],
            }
        ]
        ignore_jq = runtime_ignore_differences[0]["jqPathExpressions"][0]
        self.assertIn("DB_DSN", ignore_jq)
        self.assertIn("TRADING_ORDER_FEED_AUTO_OFFSET_RESET", ignore_jq)
        self.assertNotIn("TRADING_SIMPLE_ORDER_FEED_TELEMETRY_ENABLED", ignore_jq)
        self.assertNotIn("TRADING_ORDER_FEED_ASSIGNMENT_MODE", ignore_jq)
        self.assertIn("TRADING_SIMULATION_ORDER_UPDATES_TOPIC", ignore_jq)
        self.assertNotIn("TRADING_UNIVERSE_STATIC_FALLBACK_SYMBOLS", ignore_jq)
        with (
            patch(
                "scripts.start_historical_simulation_modules.service_environment._read_argocd_applicationset_entry",
                side_effect=[
                    {
                        "pointer": "/spec/generators/0/list/elements/0",
                        "automation_pointer": "/spec/generators/0/list/elements/0/automation",
                        "mode": "manual",
                        "ignore_differences": [],
                    },
                    {
                        "pointer": "/spec/generators/0/list/elements/0",
                        "automation_pointer": "/spec/generators/0/list/elements/0/automation",
                        "mode": "manual",
                        "ignore_differences": runtime_ignore_differences,
                    },
                ],
            ),
            patch(
                "scripts.start_historical_simulation_modules.service_environment._read_named_argocd_application_sync_policy",
                return_value={
                    "sync_policy": None,
                    "automation_mode": "manual",
                    "ignore_differences": runtime_ignore_differences,
                },
            ),
            patch(
                "scripts.start_historical_simulation_modules.service_environment._kubectl_patch_json"
            ) as patch_mock,
        ):
            report = (
                start_historical_simulation._set_argocd_application_ignore_differences(
                    config=ArgocdAutomationConfig(
                        manage_automation=True,
                        applicationset_name="product",
                        applicationset_namespace="argocd",
                        app_name="torghut",
                        root_app_name="root",
                        desired_mode_during_run="manual",
                        restore_mode_after_run="previous",
                        verify_timeout_seconds=30,
                    ),
                    required_ignore_differences=runtime_ignore_differences,
                    desired_ignore_differences=runtime_ignore_differences,
                )
            )
        self.assertTrue(report["changed"])
        patch_mock.assert_called_once_with(
            "argocd",
            "applicationset",
            "product",
            [
                {
                    "op": "add",
                    "path": "/spec/generators/0/list/elements/0/ignoreDifferences",
                    "value": runtime_ignore_differences,
                }
            ],
        )
        self.assertEqual(
            report["current_ignore_differences"], runtime_ignore_differences
        )
        self.assertTrue(report["coverage_complete"])
