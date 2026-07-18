from __future__ import annotations

from tests.live_config_manifest_contract.support import (
    Decimal,
    Mapping,
    _TestLiveConfigManifestContractBase,
    _load_cronjob_container,
    _load_knative_env,
    _load_torghut_knative_env,
    _load_torghut_strategy_catalog,
    _load_yaml_mapping,
    _load_yaml_mappings,
    _params,
    _repo_root,
    _strategy_decimal,
    cast,
)


class TestProductApplicationsetRendersTorghutNamespaceSecurityMetadata(
    _TestLiveConfigManifestContractBase
):
    def test_product_applicationset_renders_torghut_namespace_security_metadata(
        self,
    ) -> None:
        manifest = _load_yaml_mapping("argocd/applicationsets/product.yaml")
        elements = (
            manifest.get("spec", {})
            .get("generators", [])[0]
            .get("matrix", {})
            .get("generators", [])[1]
            .get("list", {})
            .get("elements", [])
        )
        torghut = next(
            item
            for item in elements
            if isinstance(item, Mapping) and item.get("name") == "torghut"
        )
        managed_namespace_metadata = cast(
            Mapping[str, object], torghut.get("managedNamespaceMetadata", {})
        )

        self.assertEqual(
            managed_namespace_metadata.get("labels"),
            {
                "external-secrets.proompteng.ai/enabled": "true",
                "pod-security.kubernetes.io/enforce": "privileged",
                "pod-security.kubernetes.io/audit": "privileged",
                "pod-security.kubernetes.io/warn": "privileged",
            },
        )
        self.assertEqual(
            managed_namespace_metadata.get("annotations"),
            {"argocd.argoproj.io/sync-options": "Prune=false"},
        )
        self.assertIn(
            "managedNamespaceMetadata",
            str(manifest.get("spec", {}).get("templatePatch", "")),
        )

    def test_production_ta_clickhouse_sink_uses_batched_inserts(self) -> None:
        manifest = _load_yaml_mapping("argocd/applications/torghut/ta/configmap.yaml")
        data = manifest.get("data")
        self.assertIsInstance(data, Mapping)

        self.assertGreaterEqual(
            int(str(cast(Mapping[str, object], data).get("TA_CLICKHOUSE_BATCH_SIZE"))),
            1000,
        )
        self.assertGreaterEqual(
            int(str(cast(Mapping[str, object], data).get("TA_CLICKHOUSE_FLUSH_MS"))),
            5000,
        )
        self.assertEqual(
            cast(Mapping[str, object], data).get("TA_CLICKHOUSE_SINK_PARALLELISM"),
            "1",
        )

    def test_production_ta_recovers_transient_dependencies_without_losing_state(
        self,
    ) -> None:
        manifest = _load_yaml_mapping(
            "argocd/applications/torghut/ta/flinkdeployment.yaml"
        )
        spec = cast(Mapping[str, object], manifest.get("spec", {}))
        flink_config = cast(Mapping[str, object], spec.get("flinkConfiguration", {}))
        job = cast(Mapping[str, object], spec.get("job", {}))

        self.assertGreaterEqual(int(str(spec.get("restartNonce"))), 33)
        self.assertEqual(job.get("upgradeMode"), "last-state")
        self.assertEqual(flink_config.get("restart-strategy.type"), "exponential-delay")
        self.assertFalse(
            any(
                str(key).startswith("restart-strategy.fixed-delay.")
                for key in flink_config
            )
        )

    def test_options_ta_uses_primary_clickhouse_auth_secret(self) -> None:
        manifest = _load_yaml_mapping(
            "argocd/applications/torghut-options/ta/flinkdeployment.yaml"
        )
        pod_template = cast(Mapping[str, object], manifest.get("spec", {})).get(
            "podTemplate"
        )
        self.assertIsInstance(pod_template, Mapping)
        pod_spec = cast(Mapping[str, object], pod_template).get("spec")
        self.assertIsInstance(pod_spec, Mapping)
        containers = cast(Mapping[str, object], pod_spec).get("containers")
        self.assertIsInstance(containers, list)
        self.assertTrue(containers)

        env = {
            item.get("name"): item
            for item in cast(
                list[Mapping[str, object]],
                cast(Mapping[str, object], containers[0]).get("env", []),
            )
        }
        clickhouse_password = cast(Mapping[str, object], env["TA_CLICKHOUSE_PASSWORD"])
        value_from = cast(
            Mapping[str, object], clickhouse_password.get("valueFrom", {})
        )
        self.assertEqual(
            value_from.get("secretKeyRef"),
            {"name": "torghut-clickhouse-auth", "key": "torghut_password"},
        )

    def test_production_options_ta_clickhouse_sink_uses_batched_inserts(self) -> None:
        config = _load_yaml_mapping(
            "argocd/applications/torghut-options/ta/configmap.yaml"
        )
        data = config.get("data")
        self.assertIsInstance(data, Mapping)
        config_data = cast(Mapping[str, object], data)

        self.assertEqual(config_data.get("OPTIONS_TA_CLICKHOUSE_BATCH_SIZE"), "1000")
        self.assertEqual(config_data.get("OPTIONS_TA_CLICKHOUSE_FLUSH_MS"), "30000")
        self.assertEqual(config_data.get("OPTIONS_TA_CLICKHOUSE_SINK_PARALLELISM"), "1")

        deployment = _load_yaml_mapping(
            "argocd/applications/torghut-options/ta/flinkdeployment.yaml"
        )
        spec = cast(Mapping[str, object], deployment.get("spec", {}))
        self.assertGreaterEqual(int(str(spec.get("restartNonce"))), 33)

    def test_direct_torghut_deployments_bound_replica_set_history(self) -> None:
        deployment_paths = [
            "argocd/applications/torghut/alloy-deployment.yaml",
            "argocd/applications/torghut/clickhouse/clickhouse-guardrails-exporter.yaml",
            "argocd/applications/torghut/llm-guardrails-exporter.yaml",
            "argocd/applications/torghut/ws/deployment.yaml",
            "argocd/applications/torghut-options/catalog/deployment.yaml",
            "argocd/applications/torghut-options/enricher/deployment.yaml",
            "argocd/applications/torghut-options/ws/deployment.yaml",
        ]

        for path in deployment_paths:
            with self.subTest(path=path):
                deployment = next(
                    item
                    for item in _load_yaml_mappings(path)
                    if item.get("kind") == "Deployment"
                )
                spec = cast(Mapping[str, object], deployment.get("spec", {}))
                self.assertEqual(spec.get("revisionHistoryLimit"), 2)

    def test_stale_backfill_hooks_are_removed_from_gitops(self) -> None:
        removed_paths = [
            "argocd/applications/torghut/empirical-jobs-backfill-job.yaml",
            "argocd/applications/torghut/whitepaper-semantic-backfill-job.yaml",
        ]
        kustomization = _load_yaml_mapping(
            "argocd/applications/torghut/kustomization.yaml"
        )
        resources = kustomization.get("resources")
        self.assertIsInstance(resources, list)

        for relative_path in removed_paths:
            with self.subTest(relative_path=relative_path):
                self.assertFalse((_repo_root() / relative_path).exists())
                self.assertNotIn(relative_path.rsplit("/", 1)[-1], resources)

    def test_execution_tca_refresh_cronjob_is_removed_from_gitops(
        self,
    ) -> None:
        relative_path = "argocd/applications/torghut/execution-tca-refresh-cronjob.yaml"
        self.assertFalse((_repo_root() / relative_path).exists())
        kustomization = _load_yaml_mapping(
            "argocd/applications/torghut/kustomization.yaml"
        )
        resources = kustomization.get("resources")
        self.assertIsInstance(resources, list)
        self.assertNotIn("execution-tca-refresh-cronjob.yaml", resources)

    def test_whitepaper_replay_materialization_cronworkflow_is_removed_from_gitops(
        self,
    ) -> None:
        relative_path = (
            "argocd/applications/torghut/"
            "whitepaper-autoresearch-replay-materialization-cronworkflow.yaml"
        )
        self.assertFalse((_repo_root() / relative_path).exists())
        kustomization = _load_yaml_mapping(
            "argocd/applications/torghut/kustomization.yaml"
        )
        resources = kustomization.get("resources")
        self.assertIsInstance(resources, list)
        self.assertNotIn(
            "whitepaper-autoresearch-replay-materialization-cronworkflow.yaml",
            resources,
        )

    def test_generated_resource_retention_cronjob_prunes_only_stale_residue(
        self,
    ) -> None:
        spec, container = _load_cronjob_container(
            "argocd/applications/torghut/generated-resource-retention-cronjob.yaml"
        )

        self.assertEqual(spec.get("schedule"), "43 3 * * *")
        self.assertEqual(spec.get("timeZone"), "America/New_York")
        self.assertEqual(spec.get("concurrencyPolicy"), "Forbid")
        self.assertEqual(spec.get("failedJobsHistoryLimit"), 2)
        job_spec = cast(
            Mapping[str, object],
            cast(Mapping[str, object], spec.get("jobTemplate", {})).get("spec", {}),
        )
        template = cast(
            Mapping[str, object],
            cast(Mapping[str, object], job_spec.get("template", {})),
        )
        pod_spec = cast(Mapping[str, object], template.get("spec", {}))
        self.assertEqual(job_spec.get("ttlSecondsAfterFinished"), 86400)
        self.assertEqual(job_spec.get("backoffLimit"), 0)
        self.assertEqual(job_spec.get("activeDeadlineSeconds"), 300)
        self.assertEqual(
            pod_spec.get("serviceAccountName"), "torghut-generated-resource-retention"
        )
        args = "\n".join(str(item) for item in container.get("args", []))
        self.assertIn("scripts/prune_kubernetes_residue.py", args)
        self.assertIn("--analysis-run-prefix torghut-sim-", args)
        self.assertIn("--ownerless-job-prefix torghut-tigerbeetle-journal-", args)
        self.assertIn("--analysis-run-max-age-hours 168", args)
        self.assertIn("--ownerless-job-max-age-hours 168", args)
        self.assertIn("--apply", args)

    def test_zero_notional_drift_repair_cronjob_is_removed(self) -> None:
        relative_path = (
            "argocd/applications/torghut/zero-notional-drift-repair-cronjob.yaml"
        )
        self.assertFalse((_repo_root() / relative_path).exists())
        resources = _load_yaml_mapping(
            "argocd/applications/torghut/kustomization.yaml"
        ).get("resources")
        self.assertIsInstance(resources, list)
        self.assertNotIn("zero-notional-drift-repair-cronjob.yaml", resources)

    def test_paper_account_flatten_cronjob_is_removed(
        self,
    ) -> None:
        relative_path = "argocd/applications/torghut/paper-account-flatten-cronjob.yaml"
        self.assertFalse((_repo_root() / relative_path).exists())
        resources = _load_yaml_mapping(
            "argocd/applications/torghut/kustomization.yaml"
        ).get("resources")
        self.assertIsInstance(resources, list)
        self.assertNotIn("paper-account-flatten-cronjob.yaml", resources)

    def test_order_feed_source_window_repair_cronjob_is_removed_from_gitops(
        self,
    ) -> None:
        relative_path = (
            "argocd/applications/torghut/order-feed-source-window-repair-cronjob.yaml"
        )
        self.assertFalse((_repo_root() / relative_path).exists())
        kustomization = _load_yaml_mapping(
            "argocd/applications/torghut/kustomization.yaml"
        )
        resources = kustomization.get("resources")
        self.assertIsInstance(resources, list)
        self.assertNotIn("order-feed-source-window-repair-cronjob.yaml", resources)

    def test_bounded_paper_route_target_materialization_is_removed(
        self,
    ) -> None:
        repo_root = _repo_root()
        kustomization = _load_yaml_mapping(
            "argocd/applications/torghut/kustomization.yaml"
        )
        resources = kustomization.get("resources")
        self.assertIsInstance(resources, list)
        self.assertNotIn(
            "bounded-paper-route-target-materialization-cronjob.yaml",
            resources,
        )
        deleted_manifest_path = (
            repo_root
            / "argocd/applications/torghut"
            / "bounded-paper-route-target-materialization-cronjob.yaml"
        )
        self.assertFalse(deleted_manifest_path.exists())

        cli_path = (
            repo_root
            / "services/torghut/scripts"
            / "materialize_bounded_paper_route_targets.py"
        )
        core_path = (
            repo_root
            / "services/torghut/scripts/paper_route_target_materialization"
            / "target_materialization_core.py"
        )
        self.assertFalse(cli_path.exists())
        self.assertFalse(core_path.exists())

    def test_hpairs_bounded_paper_collection_notional_contract_is_aligned(
        self,
    ) -> None:
        live_env = _load_torghut_knative_env()
        sim_env = _load_knative_env(
            "argocd/applications/torghut/knative-service-sim.yaml"
        )
        strategies = {
            str(strategy.get("name")): strategy
            for strategy in _load_torghut_strategy_catalog()
        }
        hpairs = strategies["microbar-cross-sectional-pairs-v1"]

        self.assertNotIn("TRADING_SIMPLE_PAPER_ROUTE_PROBE_MAX_NOTIONAL", live_env)
        self.assertNotIn("TRADING_SIMPLE_PAPER_ROUTE_PROBE_MAX_NOTIONAL", sim_env)
        self.assertEqual(live_env.get("TRADING_SIMPLE_MAX_ORDER_PCT_EQUITY"), "0.50")
        self.assertEqual(
            live_env.get("TRADING_SIMPLE_MAX_GROSS_EXPOSURE_PCT_EQUITY"),
            "4.0",
        )
        self.assertEqual(sim_env.get("TRADING_SIMPLE_MAX_ORDER_PCT_EQUITY"), "0.50")
        self.assertEqual(
            sim_env.get("TRADING_SIMPLE_MAX_GROSS_EXPOSURE_PCT_EQUITY"),
            "4.0",
        )
        self.assertNotIn("TRADING_SIMPLE_MAX_NOTIONAL_PER_ORDER", live_env)
        self.assertNotIn("TRADING_SIMPLE_MAX_NOTIONAL_PER_SYMBOL", live_env)
        self.assertNotIn("TRADING_SIMPLE_MAX_NOTIONAL_PER_ORDER", sim_env)
        self.assertNotIn("TRADING_SIMPLE_MAX_NOTIONAL_PER_SYMBOL", sim_env)
        self.assertNotIn("max_notional_per_trade", hpairs)
        self.assertEqual(
            _strategy_decimal(hpairs, "max_position_pct_equity"), Decimal("0.5")
        )
        self.assertEqual(_params(hpairs).get("max_gross_exposure_pct_equity"), "4.0")

    def test_torghut_scheduled_jobs_do_not_leave_failed_children_degrading_argo(
        self,
    ) -> None:
        cronjob_paths = (
            "argocd/applications/torghut/generated-resource-retention-cronjob.yaml",
        )
        checked_cronjobs = 0
        for relative_path in cronjob_paths:
            for manifest in _load_yaml_mappings(relative_path):
                self.assertEqual(manifest.get("kind"), "CronJob")
                spec = cast(Mapping[str, object], manifest.get("spec", {}))
                self.assertEqual(spec.get("failedJobsHistoryLimit"), 2)
                job_spec = cast(
                    Mapping[str, object],
                    cast(Mapping[str, object], spec.get("jobTemplate", {})).get(
                        "spec", {}
                    ),
                )
                self.assertEqual(job_spec.get("ttlSecondsAfterFinished"), 86400)
                checked_cronjobs += 1
        self.assertEqual(checked_cronjobs, 1)
