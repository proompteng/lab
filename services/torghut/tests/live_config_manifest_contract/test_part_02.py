from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.live_config_manifest_contract.support import *


class TestLiveConfigManifestContractPart2(_TestLiveConfigManifestContractBase):
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

    def test_whitepaper_semantic_backfill_runs_on_arm_nodes(self) -> None:
        manifest = _load_yaml_mapping(
            "argocd/applications/torghut/whitepaper-semantic-backfill-job.yaml"
        )
        pod_spec = manifest.get("spec", {}).get("template", {}).get("spec", {})
        self.assertIsInstance(pod_spec, Mapping)
        self.assertEqual(
            cast(Mapping[str, object], pod_spec).get("nodeSelector"),
            {"kubernetes.io/arch": "arm64"},
        )

    def test_execution_tca_refresh_cronjob_keeps_readiness_evidence_fresh(
        self,
    ) -> None:
        manifest = _load_yaml_mapping(
            "argocd/applications/torghut/execution-tca-refresh-cronjob.yaml"
        )
        spec = cast(Mapping[str, object], manifest.get("spec", {}))
        job_template = cast(Mapping[str, object], spec.get("jobTemplate", {}))
        job_spec = cast(Mapping[str, object], job_template.get("spec", {}))
        template = cast(Mapping[str, object], job_spec.get("template", {}))
        pod_spec = cast(Mapping[str, object], template.get("spec", {}))
        containers = cast(list[Mapping[str, object]], pod_spec.get("containers", []))

        self.assertEqual(spec.get("schedule"), "*/5 * * * *")
        self.assertEqual(spec.get("concurrencyPolicy"), "Forbid")
        self.assertEqual(job_spec.get("activeDeadlineSeconds"), 900)
        self.assertEqual(pod_spec.get("serviceAccountName"), "torghut-runtime")
        self.assertEqual(
            pod_spec.get("nodeSelector"),
            {"kubernetes.io/arch": "arm64"},
        )
        self.assertTrue(containers)

        container = containers[0]
        self.assertIn(
            "registry.ide-newton.ts.net/lab/torghut@sha256:",
            str(container.get("image")),
        )
        resources = cast(Mapping[str, object], container.get("resources", {}))
        self.assertEqual(
            resources,
            {
                "requests": {
                    "cpu": "100m",
                    "memory": "256Mi",
                    "ephemeral-storage": "128Mi",
                },
                "limits": {
                    "cpu": "500m",
                    "memory": "1Gi",
                    "ephemeral-storage": "512Mi",
                },
            },
        )
        env = {
            item.get("name"): item
            for item in cast(list[Mapping[str, object]], container.get("env", []))
        }
        db_dsn = cast(Mapping[str, object], env["DB_DSN"])
        value_from = cast(Mapping[str, object], db_dsn.get("valueFrom", {}))
        self.assertEqual(
            value_from.get("secretKeyRef"),
            {"name": "torghut-db-app", "key": "uri"},
        )
        self.assertEqual(
            env["SIM_DB_DSN"].get("value"),
            "postgresql://$(TORGHUT_SIM_DB_USER):$(TORGHUT_SIM_DB_PASSWORD)@"
            "$(TORGHUT_SIM_DB_HOST):$(TORGHUT_SIM_DB_PORT)/torghut_sim_default",
        )
        for name, key in {
            "TORGHUT_SIM_DB_HOST": "host",
            "TORGHUT_SIM_DB_PORT": "port",
            "TORGHUT_SIM_DB_USER": "username",
            "TORGHUT_SIM_DB_PASSWORD": "password",
        }.items():
            value_from = cast(Mapping[str, object], env[name].get("valueFrom", {}))
            self.assertEqual(
                value_from.get("secretKeyRef"),
                {"name": "torghut-db-app", "key": key},
            )

        args = "\n".join(str(item) for item in container.get("args", []))
        self.assertIn("scripts/refresh_execution_tca_metrics.py", args)
        self.assertIn("--dsn-env DB_DSN", args)
        self.assertIn("--dsn-env SIM_DB_DSN", args)
        self.assertIn("--account-label TORGHUT_SIM", args)
        self.assertLess(args.index("dsn_env=SIM_DB_DSN"), args.index("dsn_env=DB_DSN"))
        self.assertLess(
            args.index("--dsn-env SIM_DB_DSN"), args.index("--dsn-env DB_DSN")
        )
        self.assertIn("--older-than-seconds 900", args)
        self.assertIn("--batch-size 1000", args)
        self.assertIn("--max-batches 5", args)
        self.assertIn("--apply", args)
        self.assertEqual(args.count("scripts/refresh_execution_tca_metrics.py"), 2)

    def test_zero_notional_drift_repair_cronjob_runs_capital_safe_repair_endpoint(
        self,
    ) -> None:
        spec, container = _load_cronjob_container(
            "argocd/applications/torghut/zero-notional-drift-repair-cronjob.yaml"
        )

        self.assertEqual(spec.get("schedule"), "*/10 9-16 * * 1-5")
        self.assertEqual(spec.get("timeZone"), "America/New_York")
        self.assertEqual(spec.get("concurrencyPolicy"), "Forbid")
        self.assertEqual(spec.get("failedJobsHistoryLimit"), 0)
        self.assertEqual(spec.get("startingDeadlineSeconds"), 300)
        job_spec = cast(
            Mapping[str, object],
            cast(Mapping[str, object], spec.get("jobTemplate", {})).get("spec", {}),
        )
        template = cast(
            Mapping[str, object],
            cast(Mapping[str, object], job_spec.get("template", {})),
        )
        pod_spec = cast(Mapping[str, object], template.get("spec", {}))
        self.assertEqual(job_spec.get("ttlSecondsAfterFinished"), 1800)
        self.assertEqual(job_spec.get("backoffLimit"), 0)
        self.assertEqual(job_spec.get("activeDeadlineSeconds"), 300)
        self.assertEqual(pod_spec.get("restartPolicy"), "Never")
        self.assertEqual(pod_spec.get("serviceAccountName"), "torghut-runtime")
        self.assertEqual(
            pod_spec.get("nodeSelector"),
            {"kubernetes.io/arch": "arm64"},
        )
        self.assertIn(
            "registry.ide-newton.ts.net/lab/torghut@sha256:",
            str(container.get("image")),
        )
        resources = cast(Mapping[str, object], container.get("resources", {}))
        self.assertEqual(
            resources,
            {
                "requests": {
                    "cpu": "100m",
                    "memory": "256Mi",
                    "ephemeral-storage": "128Mi",
                },
                "limits": {
                    "cpu": "500m",
                    "memory": "512Mi",
                    "ephemeral-storage": "512Mi",
                },
            },
        )
        env = {
            item.get("name"): item
            for item in cast(list[Mapping[str, object]], container.get("env", []))
        }
        self.assertEqual(env["PYTHONUNBUFFERED"].get("value"), "1")

        args = "\n".join(str(item) for item in container.get("args", []))
        self.assertIn("scripts/run_zero_notional_repair.py", args)
        self.assertEqual(args.count("scripts/run_zero_notional_repair.py"), 2)
        self.assertLess(
            args.index("service=torghut-sim"),
            args.index("service=torghut started_at"),
        )
        self.assertIn(
            "--service-url http://torghut-sim.torghut.svc.cluster.local", args
        )
        self.assertIn("--service-url http://torghut.torghut.svc.cluster.local", args)
        self.assertIn("--action rerun_drift_checks_for_blocked_hypotheses", args)
        self.assertEqual(args.count("--execute"), 2)
        self.assertEqual(args.count("--drift-limit 1000"), 2)
        self.assertEqual(args.count("--allow-no-selected-repair"), 2)
        self.assertEqual(args.count("--allow-no-signal-blocked"), 2)
        self.assertNotIn("--max-notional", args)
        self.assertNotIn("--paper-notional", args)
        self.assertNotIn("--live-notional", args)
        self.assertNotIn("alpaca", args.lower())
        self.assertNotIn("DB_DSN", args)

    def test_paper_account_flatten_cronjob_can_clean_dirty_paper_proof_account(
        self,
    ) -> None:
        spec, container = _load_cronjob_container(
            "argocd/applications/torghut/paper-account-flatten-cronjob.yaml"
        )

        self.assertEqual(spec.get("schedule"), "5,15,20,25 9,16 * * 1-5")
        self.assertEqual(spec.get("timeZone"), "America/New_York")
        self.assertEqual(spec.get("concurrencyPolicy"), "Forbid")
        job_spec = cast(
            Mapping[str, object],
            cast(Mapping[str, object], spec.get("jobTemplate", {})).get("spec", {}),
        )
        template = cast(
            Mapping[str, object],
            cast(Mapping[str, object], job_spec.get("template", {})),
        )
        pod_spec = cast(Mapping[str, object], template.get("spec", {}))
        self.assertEqual(job_spec.get("activeDeadlineSeconds"), 300)
        self.assertEqual(pod_spec.get("serviceAccountName"), "torghut-runtime")
        self.assertEqual(
            pod_spec.get("nodeSelector"),
            {"kubernetes.io/arch": "arm64"},
        )
        resources = cast(Mapping[str, object], container.get("resources", {}))
        self.assertEqual(
            resources,
            {
                "requests": {
                    "cpu": "50m",
                    "memory": "128Mi",
                    "ephemeral-storage": "128Mi",
                },
                "limits": {
                    "cpu": "250m",
                    "memory": "256Mi",
                    "ephemeral-storage": "512Mi",
                },
            },
        )

        env = {
            item.get("name"): item
            for item in cast(list[Mapping[str, object]], container.get("env", []))
        }
        db_dsn = cast(Mapping[str, object], env["DB_DSN"])
        value_from = cast(Mapping[str, object], db_dsn.get("valueFrom", {}))
        self.assertEqual(
            value_from.get("secretKeyRef"),
            {"name": "torghut-db-app", "key": "uri"},
        )
        for name, key in (
            ("TORGHUT_SIM_DB_HOST", "host"),
            ("TORGHUT_SIM_DB_PORT", "port"),
            ("TORGHUT_SIM_DB_USER", "username"),
            ("TORGHUT_SIM_DB_PASSWORD", "password"),
        ):
            ref = cast(Mapping[str, object], env[name].get("valueFrom", {}))
            self.assertEqual(
                ref.get("secretKeyRef"),
                {"name": "torghut-db-app", "key": key},
            )
        self.assertEqual(
            env["SIM_DB_DSN"].get("value"),
            "postgresql://$(TORGHUT_SIM_DB_USER):$(TORGHUT_SIM_DB_PASSWORD)@$(TORGHUT_SIM_DB_HOST):$(TORGHUT_SIM_DB_PORT)/torghut_sim_default",
        )
        self.assertEqual(env["TRADING_MODE"].get("value"), "paper")
        self.assertEqual(env["TRADING_ACCOUNT_LABEL"].get("value"), "TORGHUT_SIM")
        self.assertEqual(env["TRADING_KILL_SWITCH_ENABLED"].get("value"), "false")

        args = "\n".join(str(item) for item in container.get("args", []))
        self.assertIn("scripts/flatten_paper_account_positions.py", args)
        self.assertIn("--account-label TORGHUT_SIM", args)
        self.assertIn("--expected-account-label TORGHUT_SIM", args)
        self.assertIn("--trading-mode paper", args)
        self.assertIn("--paper-base-url https://paper-api.alpaca.markets", args)
        self.assertIn("--database-dsn-env SIM_DB_DSN", args)
        self.assertIn(
            "--max-gross-market-value "
            f"{_HPAIRS_PAPER_ACCOUNT_FLATTEN_MAX_GROSS_MARKET_VALUE}",
            args,
        )
        self.assertNotIn("--max-gross-market-value 100000 \\", args)
        self.assertNotIn("--max-gross-market-value 2500", args)
        self.assertIn("--max-position-count 25", args)
        self.assertIn("--extended-hours-limit", args)
        self.assertIn("--limit-away-bps 200", args)
        self.assertIn("--wait-flat-seconds 120", args)
        self.assertIn("--poll-seconds 10", args)
        self.assertIn("--persist-snapshot", args)
        self.assertIn("target_plan_readback_args=()", args)
        self.assertIn("--target-plan-readback-url", args)
        self.assertIn(
            "http://torghut-sim.torghut.svc.cluster.local/trading/"
            "proofs?kind=runtime_window&window=next&limit=20",
            args,
        )
        self.assertIn("--target-plan-readback-timeout-seconds 10", args)
        self.assertIn("--require-target-plan-readback-clean", args)
        self.assertIn("--allow-pending-clean-window-baseline-readback", args)
        self.assertIn('"${target_plan_readback_args[@]}"', args)
        self.assertIn("--persist-lineage", args)
        self.assertIn("--apply", args)
        self.assertIn("--json", args)

    def test_order_feed_source_window_repair_cronjob_is_bounded_live_and_sim(
        self,
    ) -> None:
        spec, container = _load_cronjob_container(
            "argocd/applications/torghut/order-feed-source-window-repair-cronjob.yaml"
        )

        self.assertEqual(spec.get("schedule"), "13,43 * * * *")
        self.assertEqual(spec.get("concurrencyPolicy"), "Forbid")
        self.assertEqual(spec.get("startingDeadlineSeconds"), 300)
        job_spec = cast(
            Mapping[str, object],
            cast(Mapping[str, object], spec.get("jobTemplate", {})).get("spec", {}),
        )
        template = cast(
            Mapping[str, object],
            cast(Mapping[str, object], job_spec.get("template", {})),
        )
        pod_spec = cast(Mapping[str, object], template.get("spec", {}))
        self.assertEqual(job_spec.get("activeDeadlineSeconds"), 900)
        self.assertEqual(pod_spec.get("serviceAccountName"), "torghut-runtime")
        self.assertEqual(
            pod_spec.get("nodeSelector"),
            {"kubernetes.io/arch": "arm64"},
        )
        resources = cast(Mapping[str, object], container.get("resources", {}))
        self.assertEqual(
            resources,
            {
                "requests": {
                    "cpu": "100m",
                    "memory": "256Mi",
                    "ephemeral-storage": "128Mi",
                },
                "limits": {
                    "cpu": "500m",
                    "memory": "1Gi",
                    "ephemeral-storage": "512Mi",
                },
            },
        )
        self.assertIn(
            "registry.ide-newton.ts.net/lab/torghut@sha256:",
            str(container.get("image")),
        )

        env = {
            item.get("name"): item
            for item in cast(list[Mapping[str, object]], container.get("env", []))
        }
        self.assertEqual(
            env["SIM_DB_DSN"].get("value"),
            "postgresql://$(TORGHUT_SIM_DB_USER):$(TORGHUT_SIM_DB_PASSWORD)@"
            "$(TORGHUT_SIM_DB_HOST):$(TORGHUT_SIM_DB_PORT)/torghut_sim_default",
        )
        db_dsn = cast(Mapping[str, object], env["DB_DSN"])
        db_value_from = cast(Mapping[str, object], db_dsn.get("valueFrom", {}))
        self.assertEqual(
            db_value_from.get("secretKeyRef"),
            {"name": "torghut-db-app", "key": "uri"},
        )
        for name, key in {
            "TORGHUT_SIM_DB_HOST": "host",
            "TORGHUT_SIM_DB_PORT": "port",
            "TORGHUT_SIM_DB_USER": "username",
            "TORGHUT_SIM_DB_PASSWORD": "password",
        }.items():
            value_from = cast(Mapping[str, object], env[name].get("valueFrom", {}))
            self.assertEqual(
                value_from.get("secretKeyRef"),
                {"name": "torghut-db-app", "key": key},
            )

        args = "\n".join(str(item) for item in container.get("args", []))
        self.assertIn("scripts/reconcile_cross_dsn_order_feed_links.py", args)
        self.assertIn("--event-dsn-env DB_DSN", args)
        self.assertIn("--canonical-dsn-env SIM_DB_DSN", args)
        self.assertIn("--source-account-label PA3SX7FYNUTF", args)
        self.assertIn("--canonical-account-label TORGHUT_SIM", args)
        self.assertIn('--window-start "${WINDOW_START}"', args)
        self.assertIn('--window-end "${WINDOW_END}"', args)
        self.assertLess(
            args.index("scripts/reconcile_cross_dsn_order_feed_links.py"),
            args.index("scripts/repair_order_feed_source_windows.py"),
        )
        self.assertIn("scripts/repair_order_feed_source_windows.py", args)
        self.assertIn("--dsn-env DB_DSN", args)
        self.assertIn("--account-label PA3SX7FYNUTF", args)
        self.assertIn("--canonical-account-label TORGHUT_SIM", args)
        self.assertIn("--batch-size 1000", args)
        self.assertIn("--max-batches 1", args)
        self.assertIn("--dsn-env SIM_DB_DSN", args)
        self.assertIn("--account-label TORGHUT_SIM", args)
        self.assertIn("--batch-size 100", args)
        self.assertIn("--max-batches 4", args)
        self.assertIn("--account-label TORGHUT_REPLAY", args)
        self.assertEqual(
            args.count("scripts/reconcile_cross_dsn_order_feed_links.py"),
            1,
        )
        self.assertEqual(args.count("scripts/repair_order_feed_source_windows.py"), 3)
        self.assertEqual(args.count("--dsn-env SIM_DB_DSN"), 2)
        self.assertEqual(args.count("--backfill-execution-events"), 2)
        self.assertIn("--apply", args)
        self.assertNotIn("scripts/journal_tigerbeetle_order_events.py", args)
        self.assertNotIn("--reconcile-limit 1000", args)
        self.assertIn("--json", args)
        security_context = cast(
            Mapping[str, object],
            container.get("securityContext", {}),
        )
        seccomp_profile = cast(
            Mapping[str, object],
            security_context.get("seccompProfile", {}),
        )
        self.assertEqual(seccomp_profile.get("type"), "Unconfined")

    def test_bounded_paper_route_target_materialization_cronjob_is_sim_only(
        self,
    ) -> None:
        spec, container = _load_cronjob_container(
            "argocd/applications/torghut/"
            "bounded-paper-route-target-materialization-cronjob.yaml"
        )

        self.assertEqual(spec.get("schedule"), "*/5 9-15 * * 1-5")
        self.assertEqual(spec.get("timeZone"), "America/New_York")
        self.assertEqual(spec.get("concurrencyPolicy"), "Forbid")
        self.assertEqual(spec.get("startingDeadlineSeconds"), 300)
        job_spec = cast(
            Mapping[str, object],
            cast(Mapping[str, object], spec.get("jobTemplate", {})).get("spec", {}),
        )
        template = cast(
            Mapping[str, object],
            cast(Mapping[str, object], job_spec.get("template", {})),
        )
        pod_spec = cast(Mapping[str, object], template.get("spec", {}))
        self.assertEqual(job_spec.get("activeDeadlineSeconds"), 300)
        self.assertEqual(pod_spec.get("serviceAccountName"), "torghut-runtime")
        self.assertEqual(
            pod_spec.get("nodeSelector"),
            {"kubernetes.io/arch": "arm64"},
        )
        resources = cast(Mapping[str, object], container.get("resources", {}))
        self.assertEqual(
            resources,
            {
                "requests": {
                    "cpu": "100m",
                    "memory": "256Mi",
                    "ephemeral-storage": "128Mi",
                },
                "limits": {
                    "cpu": "500m",
                    "memory": "512Mi",
                    "ephemeral-storage": "512Mi",
                },
            },
        )
        self.assertIn(
            "registry.ide-newton.ts.net/lab/torghut@sha256:",
            str(container.get("image")),
        )

        env = {
            item.get("name"): item
            for item in cast(list[Mapping[str, object]], container.get("env", []))
        }
        self.assertEqual(
            env["SIM_DB_DSN"].get("value"),
            "postgresql://$(TORGHUT_SIM_DB_USER):$(TORGHUT_SIM_DB_PASSWORD)@"
            "$(TORGHUT_SIM_DB_HOST):$(TORGHUT_SIM_DB_PORT)/torghut_sim_default",
        )
        self.assertEqual(env["PYTHONUNBUFFERED"].get("value"), "1")
        for name, key in {
            "TORGHUT_SIM_DB_HOST": "host",
            "TORGHUT_SIM_DB_PORT": "port",
            "TORGHUT_SIM_DB_USER": "username",
            "TORGHUT_SIM_DB_PASSWORD": "password",
        }.items():
            value_from = cast(Mapping[str, object], env[name].get("valueFrom", {}))
            self.assertEqual(
                value_from.get("secretKeyRef"),
                {"name": "torghut-db-app", "key": key},
            )

        args = "\n".join(str(item) for item in container.get("args", []))
        self.assertIn("scripts/materialize_bounded_paper_route_targets.py", args)
        self.assertIn("--help | grep -q -- '--allow-dynamic-target-plan'", args)
        self.assertIn(
            "old_image_missing_dynamic_target_plan_guard",
            args,
        )
        self.assertIn(
            "--help | grep -q -- '--skip-unless-active-target-window'",
            args,
        )
        self.assertIn(
            "old_image_missing_target_window_guard",
            args,
        )
        self.assertIn(
            "--plan-url "
            "'http://torghut-sim.torghut.svc.cluster.local/trading/proofs?kind=runtime_window&window=next&limit=20'",
            args,
        )
        self.assertIn("--plan-url-timeout-seconds 45", args)
        self.assertIn("--plan-url-attempts 3", args)
        self.assertIn("--database-dsn-env SIM_DB_DSN", args)
        self.assertIn("--account-label TORGHUT_SIM", args)
        self.assertIn(
            f"--max-notional {_HPAIRS_BOUNDED_PAPER_COLLECTION_MAX_NOTIONAL}", args
        )
        self.assertIn("--commit", args)
        self.assertIn("--allow-dynamic-target-plan", args)
        self.assertIn("--skip-unless-active-target-window", args)
        self.assertIn("--confirm-account-label TORGHUT_SIM", args)
        self.assertIn("--confirm-dsn-env SIM_DB_DSN", args)
        self.assertIn("--confirm-hypothesis-id H-PAIRS-01", args)
        self.assertIn(
            "--confirm-runtime-strategy-name microbar-cross-sectional-pairs-v1",
            args,
        )
        self.assertIn(
            "--confirm-selected-plan-source "
            "trading_proofs,"
            "live_submission_gate.runtime_ledger_paper_probation_import_plan,"
            "runtime_ledger_paper_probation_import_plan,"
            "next_paper_route_runtime_window_targets,"
            "next_clean_paper_route_runtime_window_targets_after_discard",
            args,
        )
        self.assertNotIn(
            "latest_closed_paper_route_runtime_window_targets",
            args,
        )
        self.assertIn("--confirm-target-count-min 1", args)
        self.assertIn(
            f"--confirm-max-notional {_HPAIRS_BOUNDED_PAPER_COLLECTION_MAX_NOTIONAL}",
            args,
        )
        self.assertIn(
            "--operator-confirmation MATERIALIZE_BOUNDED_TORGHUT_SIM_PAPER_ROUTE_TARGETS",
            args,
        )
        self.assertNotIn("--confirm-candidate-id", args)
        self.assertNotIn("--confirm-target-plan-ref", args)
        self.assertNotIn("--promotion-allowed", args)
        self.assertNotIn("--final-promotion-allowed", args)
        self.assertNotIn("--capital-promotion-allowed", args)
        self.assertNotIn("--final-authority-ok", args)
        self.assertNotIn("PA3SX7FYNUTF", args)

    def test_hpairs_bounded_paper_collection_notional_contract_is_aligned(
        self,
    ) -> None:
        live_env = _load_torghut_knative_env()
        sim_env = _load_knative_env(
            "argocd/applications/torghut/knative-service-sim.yaml"
        )
        _, materializer_container = _load_cronjob_container(
            "argocd/applications/torghut/"
            "bounded-paper-route-target-materialization-cronjob.yaml"
        )
        args = "\n".join(str(item) for item in materializer_container.get("args", []))
        strategies = {
            str(strategy.get("name")): strategy
            for strategy in _load_torghut_strategy_catalog()
        }
        hpairs = strategies["microbar-cross-sectional-pairs-v1"]

        self.assertEqual(
            live_env.get("TRADING_SIMPLE_PAPER_ROUTE_PROBE_MAX_NOTIONAL"),
            _SIMPLE_PAPER_ROUTE_PROBE_MAX_NOTIONAL,
        )
        self.assertEqual(
            sim_env.get("TRADING_SIMPLE_PAPER_ROUTE_PROBE_MAX_NOTIONAL"),
            _SIMPLE_PAPER_ROUTE_PROBE_MAX_NOTIONAL,
        )
        self.assertNotEqual(
            live_env.get("TRADING_SIMPLE_PAPER_ROUTE_PROBE_MAX_NOTIONAL"),
            "1000000",
        )
        self.assertEqual(live_env.get("TRADING_SIMPLE_MAX_ORDER_PCT_EQUITY"), "0.25")
        self.assertEqual(
            live_env.get("TRADING_SIMPLE_MAX_GROSS_EXPOSURE_PCT_EQUITY"),
            "1.0",
        )
        self.assertEqual(sim_env.get("TRADING_SIMPLE_MAX_ORDER_PCT_EQUITY"), "0.25")
        self.assertEqual(
            sim_env.get("TRADING_SIMPLE_MAX_GROSS_EXPOSURE_PCT_EQUITY"),
            "1.0",
        )
        self.assertIn(
            f"--max-notional {_HPAIRS_BOUNDED_PAPER_COLLECTION_MAX_NOTIONAL}", args
        )
        self.assertIn(
            f"--confirm-max-notional {_HPAIRS_BOUNDED_PAPER_COLLECTION_MAX_NOTIONAL}",
            args,
        )
        _, flatten_container = _load_cronjob_container(
            "argocd/applications/torghut/paper-account-flatten-cronjob.yaml"
        )
        flatten_args = "\n".join(
            str(item) for item in flatten_container.get("args", [])
        )
        self.assertIn(
            "--max-gross-market-value "
            f"{_HPAIRS_PAPER_ACCOUNT_FLATTEN_MAX_GROSS_MARKET_VALUE}",
            flatten_args,
        )
        self.assertEqual(
            _HPAIRS_PAPER_ACCOUNT_FLATTEN_MAX_GROSS_MARKET_VALUE,
            _HPAIRS_BOUNDED_PAPER_COLLECTION_MAX_NOTIONAL,
        )
        self.assertEqual(
            _strategy_decimal(hpairs, "max_notional_per_trade"),
            Decimal(_HPAIRS_BOUNDED_PAPER_COLLECTION_MAX_NOTIONAL),
        )
        self.assertEqual(
            _strategy_decimal(hpairs, "max_position_pct_equity"), Decimal("10.0")
        )
        self.assertEqual(_params(hpairs).get("max_gross_exposure_pct_equity"), "10.0")

    def test_torghut_scheduled_jobs_do_not_leave_failed_children_degrading_argo(
        self,
    ) -> None:
        cronjob_paths = (
            "argocd/applications/torghut/bounded-paper-route-target-materialization-cronjob.yaml",
            "argocd/applications/torghut/empirical-artifacts-retention-cronjob.yaml",
            "argocd/applications/torghut/empirical-promotion-renewal-cronjob.yaml",
            "argocd/applications/torghut/execution-tca-refresh-cronjob.yaml",
            "argocd/applications/torghut/zero-notional-drift-repair-cronjob.yaml",
            "argocd/applications/torghut/order-feed-source-window-repair-cronjob.yaml",
            "argocd/applications/torghut/paper-account-flatten-cronjob.yaml",
            "argocd/applications/torghut/tigerbeetle-journal-order-events-cronjob.yaml",
        )
        checked_cronjobs = 0
        for relative_path in cronjob_paths:
            for manifest in _load_yaml_mappings(relative_path):
                self.assertEqual(manifest.get("kind"), "CronJob")
                spec = cast(Mapping[str, object], manifest.get("spec", {}))
                self.assertEqual(spec.get("failedJobsHistoryLimit"), 0)
                job_spec = cast(
                    Mapping[str, object],
                    cast(Mapping[str, object], spec.get("jobTemplate", {})).get(
                        "spec", {}
                    ),
                )
                self.assertEqual(job_spec.get("ttlSecondsAfterFinished"), 1800)
                checked_cronjobs += 1
        self.assertEqual(checked_cronjobs, 9)

        replay_cronworkflow = _load_yaml_mapping(
            "argocd/applications/torghut/whitepaper-autoresearch-replay-materialization-cronworkflow.yaml"
        )
        self.assertEqual(replay_cronworkflow.get("kind"), "CronWorkflow")
        replay_spec = cast(Mapping[str, object], replay_cronworkflow.get("spec", {}))
        self.assertEqual(replay_spec.get("failedJobsHistoryLimit"), 0)
