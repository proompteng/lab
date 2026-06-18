from __future__ import annotations

from tests.historical_simulation.start_historical_simulation_base import (
    Any,
    ArgocdAutomationConfig,
    Path,
    SimpleNamespace,
    StartHistoricalSimulationTestCaseBase,
    _prepare_argocd_for_run,
    _restore_argocd_after_run,
    call,
    patch,
    re,
    start_historical_simulation,
    yaml,
)


class TestStartHistoricalSimulationArgocdB(StartHistoricalSimulationTestCaseBase):
    def test_product_applicationset_torghut_sim_env_ignore_is_selective(self) -> None:
        repo_root = Path(__file__).resolve().parents[4]
        appset = yaml.safe_load(
            (repo_root / "argocd" / "applicationsets" / "product.yaml").read_text(
                encoding="utf-8"
            )
        )
        elements = appset["spec"]["generators"][0]["matrix"]["generators"][1]["list"][
            "elements"
        ]
        torghut_entry = next(item for item in elements if item.get("name") == "torghut")
        sim_rule = next(
            rule
            for rule in torghut_entry["ignoreDifferences"]
            if rule.get("kind") == "Service" and rule.get("name") == "torghut-sim"
        )

        self.assertNotIn("jsonPointers", sim_rule)
        ignored_names = set(
            re.findall(r'\.name == "([^"]+)"', sim_rule["jqPathExpressions"][0])
        )
        self.assertEqual(
            ignored_names,
            set(start_historical_simulation.SIMULATION_TORGHUT_RUNTIME_ENV_IGNORE_KEYS),
        )
        self.assertNotIn("TRADING_SIMPLE_ORDER_FEED_TELEMETRY_ENABLED", ignored_names)
        self.assertNotIn("TRADING_ORDER_FEED_ASSIGNMENT_MODE", ignored_names)
        self.assertNotIn(
            "TRADING_UNIVERSE_STATIC_FALLBACK_SYMBOLS",
            sim_rule["jqPathExpressions"][0],
        )
        self.assertFalse(
            any(
                rule.get("kind") == "ConfigMap"
                and rule.get("name") == "torghut-ta-sim-config"
                and rule.get("jsonPointers") == ["/data"]
                for rule in torghut_entry["ignoreDifferences"]
            )
        )

    def test_argocd_application_mode_from_sync_policy_treats_missing_automation_as_manual(
        self,
    ) -> None:
        self.assertEqual(
            start_historical_simulation._argocd_application_mode_from_sync_policy(
                {"syncOptions": ["CreateNamespace=true"]}
            ),
            "manual",
        )
        self.assertEqual(
            start_historical_simulation._argocd_application_mode_from_sync_policy(
                {"automated": {"enabled": True}}
            ),
            "auto",
        )

    def test_manual_argocd_application_sync_policy_preserves_existing_manual_shape(
        self,
    ) -> None:
        policy = {"syncOptions": ["CreateNamespace=true"]}

        manual_policy = (
            start_historical_simulation._manual_argocd_application_sync_policy(policy)
        )

        self.assertEqual(manual_policy, policy)

    def test_manual_argocd_application_sync_policy_strips_auto_only_fields(
        self,
    ) -> None:
        policy = {
            "automated": {"enabled": True, "prune": True, "selfHeal": True},
            "retry": {
                "limit": 5,
                "backoff": {"duration": "5s", "factor": 2, "maxDuration": "3m"},
                "refresh": True,
            },
            "syncOptions": ["CreateNamespace=true"],
        }

        manual_policy = (
            start_historical_simulation._manual_argocd_application_sync_policy(policy)
        )

        self.assertEqual(
            manual_policy,
            {"syncOptions": ["CreateNamespace=true"]},
        )

    def test_prepare_argocd_for_run_pauses_root_and_applicationset(self) -> None:
        config = ArgocdAutomationConfig(
            manage_automation=True,
            applicationset_name="product",
            applicationset_namespace="argocd",
            app_name="torghut",
            root_app_name="root",
            desired_mode_during_run="manual",
            restore_mode_after_run="previous",
            verify_timeout_seconds=30,
        )
        resources = SimpleNamespace(
            namespace="torghut",
            torghut_service="torghut-sim",
            ta_configmap="torghut-ta-sim-config",
            ta_deployment="torghut-ta-sim",
        )
        baseline_ignore_differences = [
            {
                "group": "serving.knative.dev",
                "kind": "Service",
                "jsonPointers": ["/metadata/annotations"],
            }
        ]
        call_order: list[str] = []

        def _set_application_sync_policy(
            *,
            config: ArgocdAutomationConfig,
            desired_sync_policy: dict[str, Any] | None,
            app_name: str | None = None,
        ) -> dict[str, Any]:
            del config
            call_order.append(f"application_sync:{app_name}")
            return {
                "previous_sync_policy": {
                    "automated": {"enabled": True, "prune": True, "selfHeal": True},
                },
                "current_sync_policy": desired_sync_policy,
                "changed": True,
            }

        def _set_applicationset_mode(
            *,
            config: ArgocdAutomationConfig,
            desired_mode: str,
        ) -> dict[str, Any]:
            del config
            call_order.append("applicationset")
            return {
                "pointer": "/spec/generators/0/list/elements/0/automation",
                "previous_mode": "auto",
                "desired_mode": desired_mode,
                "current_mode": desired_mode,
                "changed": True,
            }

        def _set_ignore_differences(**kwargs: Any) -> dict[str, Any]:
            del kwargs
            call_order.append("ignore_differences")
            return {
                "previous_ignore_differences": baseline_ignore_differences,
                "current_ignore_differences": baseline_ignore_differences,
                "required_ignore_differences": [],
                "coverage_complete": True,
                "changed": True,
            }

        def _wait_application_mode(**kwargs: Any) -> dict[str, Any]:
            del kwargs
            call_order.append("wait_application")
            return {
                "app_name": "torghut",
                "current_mode": "manual",
            }

        with (
            patch(
                "scripts.start_historical_simulation_modules.argocd_rollouts._read_argocd_automation_mode",
                return_value={
                    "pointer": "/spec/generators/0/list/elements/0/automation",
                    "mode": "auto",
                },
            ) as automation_read_mock,
            patch(
                "scripts.start_historical_simulation_modules.argocd_rollouts._read_named_argocd_application_sync_policy",
                side_effect=[
                    {
                        "sync_policy": {
                            "automated": {
                                "enabled": True,
                                "prune": True,
                                "selfHeal": True,
                            },
                            "syncOptions": ["CreateNamespace=true"],
                        },
                        "automation_mode": "auto",
                        "ignore_differences": baseline_ignore_differences,
                    },
                    {
                        "sync_policy": {
                            "automated": {
                                "enabled": True,
                                "prune": True,
                                "selfHeal": True,
                            },
                            "syncOptions": ["CreateNamespace=true"],
                        },
                        "automation_mode": "auto",
                        "ignore_differences": None,
                    },
                ],
            ) as application_read_mock,
            patch(
                "scripts.start_historical_simulation_modules.argocd_rollouts._set_argocd_application_sync_policy",
                side_effect=_set_application_sync_policy,
            ) as application_sync_mock,
            patch(
                "scripts.start_historical_simulation_modules.argocd_rollouts._set_argocd_application_ignore_differences",
                side_effect=_set_ignore_differences,
            ) as ignore_differences_mock,
            patch(
                "scripts.start_historical_simulation_modules.argocd_rollouts._set_argocd_automation_mode",
                side_effect=_set_applicationset_mode,
            ) as applicationset_mock,
            patch(
                "scripts.start_historical_simulation_modules.argocd_rollouts._wait_for_argocd_application_mode",
                side_effect=_wait_application_mode,
            ) as application_mode_mock,
        ):
            report = _prepare_argocd_for_run(config=config, resources=resources)
        automation_read_mock.assert_called_once()
        self.assertEqual(
            application_read_mock.call_args_list,
            [
                call(namespace="argocd", app_name="torghut"),
                call(namespace="argocd", app_name="root"),
            ],
        )
        self.assertEqual(
            application_sync_mock.call_args_list,
            [
                call(
                    config=config,
                    app_name="root",
                    desired_sync_policy={"syncOptions": ["CreateNamespace=true"]},
                ),
                call(
                    config=config,
                    app_name="torghut",
                    desired_sync_policy={"syncOptions": ["CreateNamespace=true"]},
                ),
            ],
        )
        self.assertEqual(
            call_order,
            [
                "application_sync:root",
                "applicationset",
                "ignore_differences",
                "application_sync:torghut",
                "wait_application",
            ],
        )
        ignore_differences_mock.assert_called_once_with(
            config=config,
            app_name="torghut",
            required_ignore_differences=start_historical_simulation._simulation_runtime_argocd_ignore_differences(
                resources=resources
            ),
            desired_ignore_differences=start_historical_simulation._merge_argocd_application_ignore_differences(
                current_ignore_differences=baseline_ignore_differences,
                resources=resources,
            ),
        )
        applicationset_mock.assert_called_once()
        application_mode_mock.assert_called_once()
        self.assertTrue(report["changed"])
        self.assertIn("application", report)
        self.assertIn("root_application", report)
        self.assertIn("application_sync_policy", report)
        self.assertIn("application_ignore_differences", report)
        self.assertTrue(report["applicationset_managed"])
        self.assertEqual(report["previous_mode"], "auto")
        self.assertEqual(report["current_mode"], "manual")

    def test_ensure_argocd_manual_before_runtime_mutation_noops_when_everything_is_manual(
        self,
    ) -> None:
        config = ArgocdAutomationConfig(
            manage_automation=True,
            applicationset_name="product",
            applicationset_namespace="argocd",
            app_name="torghut",
            root_app_name="root",
            desired_mode_during_run="manual",
            restore_mode_after_run="previous",
            verify_timeout_seconds=30,
        )
        resources = SimpleNamespace(
            namespace="torghut",
            torghut_service="torghut-sim",
            ta_configmap="torghut-ta-sim-config",
            ta_deployment="torghut-ta-sim",
        )
        runtime_ignore_differences = (
            start_historical_simulation._simulation_runtime_argocd_ignore_differences(
                resources=resources
            )
        )
        with (
            patch(
                "scripts.start_historical_simulation_modules.argocd_rollouts._read_argocd_automation_mode",
                return_value={
                    "pointer": "/spec/generators/0/list/elements/0/automation",
                    "mode": "manual",
                },
            ),
            patch(
                "scripts.start_historical_simulation_modules.argocd_rollouts._read_named_argocd_application_sync_policy",
                side_effect=[
                    {
                        "sync_policy": {
                            "automated": {
                                "enabled": False,
                                "prune": False,
                                "selfHeal": False,
                            },
                            "syncOptions": ["CreateNamespace=true"],
                        },
                        "automation_mode": "manual",
                        "ignore_differences": runtime_ignore_differences,
                    },
                    {
                        "sync_policy": {
                            "automated": {
                                "enabled": False,
                                "prune": False,
                                "selfHeal": False,
                            },
                            "syncOptions": ["CreateNamespace=true"],
                        },
                        "automation_mode": "manual",
                        "ignore_differences": None,
                    },
                ],
            ),
            patch(
                "scripts.start_historical_simulation_modules.argocd_rollouts._prepare_argocd_for_run"
            ) as prepare_mock,
        ):
            report = start_historical_simulation._ensure_argocd_manual_before_runtime_mutation(
                config=config,
                resources=resources,
            )

        prepare_mock.assert_not_called()
        self.assertEqual(report["reason"], "already_manual")
        self.assertFalse(report["changed"])
        self.assertEqual(report["current_mode"], "manual")
        self.assertTrue(report["application_ignore_differences"]["coverage_complete"])

    def test_ensure_argocd_manual_before_runtime_mutation_reasserts_when_child_app_drifted(
        self,
    ) -> None:
        config = ArgocdAutomationConfig(
            manage_automation=True,
            applicationset_name="product",
            applicationset_namespace="argocd",
            app_name="torghut",
            root_app_name="root",
            desired_mode_during_run="manual",
            restore_mode_after_run="previous",
            verify_timeout_seconds=30,
        )
        resources = SimpleNamespace(
            namespace="torghut",
            torghut_service="torghut-sim",
            ta_configmap="torghut-ta-sim-config",
            ta_deployment="torghut-ta-sim",
        )
        with (
            patch(
                "scripts.start_historical_simulation_modules.argocd_rollouts._read_argocd_automation_mode",
                return_value={
                    "pointer": "/spec/generators/0/list/elements/0/automation",
                    "mode": "manual",
                },
            ),
            patch(
                "scripts.start_historical_simulation_modules.argocd_rollouts._read_named_argocd_application_sync_policy",
                side_effect=[
                    {
                        "sync_policy": {
                            "automated": {
                                "enabled": True,
                                "prune": True,
                                "selfHeal": True,
                            },
                            "syncOptions": ["CreateNamespace=true"],
                        },
                        "automation_mode": "auto",
                        "ignore_differences": [],
                    },
                    {
                        "sync_policy": {
                            "automated": {
                                "enabled": False,
                                "prune": False,
                                "selfHeal": False,
                            },
                            "syncOptions": ["CreateNamespace=true"],
                        },
                        "automation_mode": "manual",
                        "ignore_differences": None,
                    },
                ],
            ),
            patch(
                "scripts.start_historical_simulation_modules.argocd_rollouts._prepare_argocd_for_run",
                return_value={
                    "managed": True,
                    "changed": True,
                    "current_mode": "manual",
                },
            ) as prepare_mock,
        ):
            report = start_historical_simulation._ensure_argocd_manual_before_runtime_mutation(
                config=config,
                resources=resources,
            )

        prepare_mock.assert_called_once_with(config=config, resources=resources)
        self.assertEqual(report["reason"], "reasserted_manual_before_runtime_mutation")
        self.assertTrue(report["changed"])

    def test_restore_argocd_after_run_restores_root_and_applicationset(self) -> None:
        config = ArgocdAutomationConfig(
            manage_automation=True,
            applicationset_name="product",
            applicationset_namespace="argocd",
            app_name="torghut",
            root_app_name="root",
            desired_mode_during_run="manual",
            restore_mode_after_run="previous",
            verify_timeout_seconds=30,
        )
        previous_sync_policy = {
            "automated": {"enabled": True, "prune": True, "selfHeal": True},
            "syncOptions": ["CreateNamespace=true"],
        }
        call_order: list[str] = []

        def _set_applicationset_mode(
            *,
            config: ArgocdAutomationConfig,
            desired_mode: str,
        ) -> dict[str, Any]:
            del config
            call_order.append("applicationset")
            return {
                "pointer": "/spec/generators/0/list/elements/0/automation",
                "previous_mode": "manual",
                "desired_mode": desired_mode,
                "current_mode": desired_mode,
                "changed": True,
            }

        def _set_application_sync_policy(
            *,
            config: ArgocdAutomationConfig,
            desired_sync_policy: dict[str, Any] | None,
            app_name: str | None = None,
        ) -> dict[str, Any]:
            del config
            call_order.append(f"application_sync:{app_name}")
            return {
                "previous_sync_policy": {
                    "automated": {"enabled": False, "prune": False, "selfHeal": False},
                },
                "current_sync_policy": desired_sync_policy,
                "changed": True,
            }

        def _set_ignore_differences(**kwargs: Any) -> dict[str, Any]:
            del kwargs
            call_order.append("ignore_differences")
            return {
                "previous_ignore_differences": [
                    {"group": "", "kind": "ConfigMap", "jsonPointers": ["/data"]}
                ],
                "current_ignore_differences": [],
                "required_ignore_differences": [],
                "coverage_complete": True,
                "changed": True,
            }

        def _wait_application_mode(**kwargs: Any) -> dict[str, Any]:
            del kwargs
            call_order.append("wait_application")
            return {
                "app_name": "torghut",
                "current_mode": "auto",
            }

        with (
            patch(
                "scripts.start_historical_simulation_modules.argocd_rollouts._set_argocd_automation_mode",
                side_effect=_set_applicationset_mode,
            ) as applicationset_mock,
            patch(
                "scripts.start_historical_simulation_modules.argocd_rollouts._set_argocd_application_sync_policy",
                side_effect=_set_application_sync_policy,
            ) as application_mock,
            patch(
                "scripts.start_historical_simulation_modules.argocd_rollouts._set_argocd_application_ignore_differences",
                side_effect=_set_ignore_differences,
            ) as ignore_differences_mock,
            patch(
                "scripts.start_historical_simulation_modules.argocd_rollouts._wait_for_argocd_application_mode",
                side_effect=_wait_application_mode,
            ) as application_mode_mock,
        ):
            report = _restore_argocd_after_run(
                config=config,
                previous_mode="auto",
                previous_root_sync_policy=previous_sync_policy,
                previous_child_sync_policy=previous_sync_policy,
                previous_child_ignore_differences=None,
            )
        applicationset_mock.assert_called_once()
        self.assertEqual(
            application_mock.call_args_list,
            [
                call(
                    config=config,
                    app_name="torghut",
                    desired_sync_policy=previous_sync_policy,
                ),
                call(
                    config=config,
                    app_name="root",
                    desired_sync_policy=previous_sync_policy,
                ),
            ],
        )
        self.assertEqual(
            call_order,
            [
                "applicationset",
                "application_sync:torghut",
                "ignore_differences",
                "application_sync:root",
                "wait_application",
            ],
        )
        ignore_differences_mock.assert_called_once_with(
            config=config,
            app_name="torghut",
            desired_ignore_differences=None,
        )
        application_mode_mock.assert_called_once()
        self.assertTrue(report["changed"])
        self.assertEqual(report["restored_mode"], "auto")
        self.assertTrue(report["applicationset_managed"])
        self.assertEqual(report["current_mode"], "auto")
