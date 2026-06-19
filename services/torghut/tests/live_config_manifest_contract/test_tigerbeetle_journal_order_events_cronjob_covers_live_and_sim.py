from __future__ import annotations

from tests.live_config_manifest_contract.support import (
    Decimal,
    Mapping,
    SOURCE_TYPE_EXECUTION_ORDER_EVENT,
    _SIMPLE_PAPER_ROUTE_PROBE_MAX_NOTIONAL,
    _TestLiveConfigManifestContractBase,
    _assert_exact_live_execution_chip_universe,
    _assert_exact_quote_covered_paper_strategy_universe,
    _load_cronjob_container,
    _load_torghut_feature_flags,
    _load_torghut_knative_env,
    _load_torghut_knative_manifest,
    _load_yaml_mapping,
    _manifest_bool,
    _repo_root,
    cast,
    json,
    safe_load,
    tigerbeetle_journal_runner,
)


class TestTigerbeetleJournalOrderEventsCronjobCoversLiveAndSim(
    _TestLiveConfigManifestContractBase
):
    def test_tigerbeetle_journal_order_events_is_manual_operator_tool_only(
        self,
    ) -> None:
        relative_path = (
            "argocd/applications/torghut/tigerbeetle-journal-order-events-cronjob.yaml"
        )
        self.assertFalse((_repo_root() / relative_path).exists())
        kustomization = _load_yaml_mapping(
            "argocd/applications/torghut/kustomization.yaml"
        )
        resources = kustomization.get("resources")
        self.assertIsInstance(resources, list)
        self.assertNotIn("tigerbeetle-journal-order-events-cronjob.yaml", resources)
        self.assertTrue(
            (
                _repo_root()
                / "services/torghut/scripts/run_tigerbeetle_journal_cron.py"
            ).is_file()
        )

        live_execution_commands = [
            command
            for command in tigerbeetle_journal_runner._live_commands(
                execution_batch_size=5
            )
            if command.source == tigerbeetle_journal_runner.SOURCE_TYPE_EXECUTION
        ]
        self.assertEqual(len(live_execution_commands), 1)
        live_execution_command = live_execution_commands[0]
        self.assertEqual(live_execution_command.batch_size, 5)
        self.assertEqual(
            live_execution_command.repeat_count,
            tigerbeetle_journal_runner.LIVE_EXECUTION_SLICE_COUNT,
        )
        self.assertTrue(live_execution_command.commit_each_row)
        self.assertEqual(
            live_execution_command.progress_interval,
            tigerbeetle_journal_runner.LIVE_EXECUTION_PROGRESS_INTERVAL,
        )
        live_order_event_commands = [
            command
            for command in tigerbeetle_journal_runner._live_commands(
                execution_batch_size=5
            )
            if command.source == SOURCE_TYPE_EXECUTION_ORDER_EVENT
        ]
        self.assertEqual(len(live_order_event_commands), 1)
        live_order_event_command = live_order_event_commands[0]
        self.assertEqual(
            live_order_event_command.batch_size,
            tigerbeetle_journal_runner.LIVE_ORDER_EVENT_BATCH_SIZE,
        )
        self.assertEqual(live_order_event_command.batch_size, 50)
        self.assertEqual(
            live_order_event_command.event_scan_limit,
            tigerbeetle_journal_runner.LIVE_ORDER_EVENT_SCAN_LIMIT,
        )
        self.assertEqual(
            live_order_event_command.max_batches,
            tigerbeetle_journal_runner.LIVE_ORDER_EVENT_MAX_BATCHES,
        )
        self.assertEqual(live_order_event_command.max_batches, 1)
        self.assertLessEqual(
            live_order_event_command.max_batches,
            2,
            "live order-event slices must not run PR #9799's unsafe 3-batch shape under the bounded watchdog",
        )
        self.assertLessEqual(
            live_order_event_command.batch_size * live_order_event_command.max_batches,
            tigerbeetle_journal_runner.LIVE_ORDER_EVENT_BATCH_SIZE,
            "live order-event slices must stay to one bounded batch under the bounded watchdog",
        )
        self.assertTrue(live_order_event_command.skip_reconcile)
        self.assertTrue(live_order_event_command.allow_data_quality_degraded)
        live_runtime_commands = [
            command
            for command in tigerbeetle_journal_runner._live_commands(
                execution_batch_size=5
            )
            if command.source
            == tigerbeetle_journal_runner.SOURCE_TYPE_RUNTIME_LEDGER_BUCKET
        ]
        self.assertEqual(len(live_runtime_commands), 1)
        live_runtime_command = live_runtime_commands[0]
        self.assertFalse(live_runtime_command.skip_reconcile)
        self.assertTrue(live_runtime_command.reconcile_empty_selection)
        self.assertEqual(
            live_runtime_command.reconcile_limit,
            tigerbeetle_journal_runner.LIVE_RECONCILE_LIMIT,
        )

        sim_runtime_commands = [
            command
            for command in tigerbeetle_journal_runner._sim_commands()
            if command.source
            == tigerbeetle_journal_runner.SOURCE_TYPE_RUNTIME_LEDGER_BUCKET
        ]
        self.assertEqual(len(sim_runtime_commands), 1)
        sim_runtime_command = sim_runtime_commands[0]
        self.assertFalse(sim_runtime_command.skip_reconcile)
        self.assertTrue(sim_runtime_command.reconcile_empty_selection)

    def test_empirical_promotion_renewal_imports_authoritative_live_paper_plan_and_sim_db(
        self,
    ) -> None:
        spec, container = _load_cronjob_container(
            "argocd/applications/torghut/empirical-promotion-renewal-cronjob.yaml"
        )

        self.assertEqual(spec.get("schedule"), "23 8,21 * * *")
        self.assertEqual(spec.get("concurrencyPolicy"), "Forbid")
        self.assertEqual(spec.get("startingDeadlineSeconds"), 900)
        job_spec = cast(
            Mapping[str, object],
            cast(Mapping[str, object], spec.get("jobTemplate", {})).get("spec", {}),
        )
        self.assertEqual(job_spec.get("activeDeadlineSeconds"), 900)
        resources = cast(Mapping[str, object], container.get("resources", {}))
        self.assertEqual(
            resources,
            {
                "requests": {
                    "cpu": "100m",
                    "memory": "512Mi",
                    "ephemeral-storage": "256Mi",
                },
                "limits": {
                    "cpu": "1",
                    "memory": "2Gi",
                    "ephemeral-storage": "2Gi",
                },
            },
        )
        env = {
            item.get("name"): item
            for item in cast(list[Mapping[str, object]], container.get("env", []))
        }
        self.assertRegex(str(env["TORGHUT_COMMIT"].get("value")), r"^[0-9a-f]{40}$")
        self.assertRegex(
            str(env["TORGHUT_IMAGE_DIGEST"].get("value")),
            r"^sha256:[0-9a-f]{64}$",
        )
        db_dsn = cast(Mapping[str, object], env["DB_DSN"])
        db_value_from = cast(Mapping[str, object], db_dsn.get("valueFrom", {}))
        self.assertEqual(
            db_value_from.get("secretKeyRef"),
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
        self.assertIn("scripts/reconcile_cross_dsn_order_feed_links.py", args)
        self.assertIn("--event-dsn-env DB_DSN", args)
        self.assertIn("--canonical-dsn-env SIM_DB_DSN", args)
        self.assertIn("--source-account-label PA3SX7FYNUTF", args)
        self.assertIn("--canonical-account-label TORGHUT_SIM", args)
        self.assertIn('--window-start "${WINDOW_START}"', args)
        self.assertIn('--window-end "${WINDOW_END}"', args)
        self.assertIn("scripts/repair_order_feed_source_windows.py", args)
        self.assertIn("--dsn-env SIM_DB_DSN", args)
        self.assertIn("--account-label TORGHUT_SIM", args)
        self.assertIn("--batch-size 1000", args)
        self.assertIn("--max-batches 2", args)
        self.assertIn("--account-label TORGHUT_REPLAY", args)
        self.assertIn("--backfill-execution-events", args)
        self.assertEqual(args.count("--backfill-execution-events"), 2)
        self.assertEqual(
            args.count("scripts/reconcile_cross_dsn_order_feed_links.py"),
            1,
        )
        self.assertEqual(args.count("scripts/repair_order_feed_source_windows.py"), 2)
        self.assertIn("scripts/refresh_execution_tca_metrics.py", args)
        self.assertIn("--older-than-seconds 0", args)
        self.assertIn("--max-batches 5", args)
        self.assertEqual(args.count("scripts/refresh_execution_tca_metrics.py"), 1)
        self.assertEqual(args.count("--dsn-env SIM_DB_DSN"), 3)
        self.assertLess(
            args.index("scripts/reconcile_cross_dsn_order_feed_links.py"),
            args.index("scripts/repair_order_feed_source_windows.py"),
        )
        self.assertLess(
            args.index("scripts/refresh_execution_tca_metrics.py"),
            args.index("scripts/renew_latest_empirical_promotion_jobs.py"),
        )
        self.assertIn("scripts/renew_latest_empirical_promotion_jobs.py", args)
        self.assertIn(
            "--runtime-window-target-plan-url "
            "'http://torghut-sim.torghut.svc.cluster.local/trading/proofs?kind=runtime_window&window=latest_closed&full_audit=true&limit=5'",
            args,
        )
        self.assertNotIn(
            "--runtime-window-target-plan-url "
            "'http://torghut.torghut.svc.cluster.local/trading/paper-route-evidence?target_limit=5'",
            args,
        )
        self.assertIn(
            "--runtime-window-target-plan-url "
            "'http://torghut.torghut.svc.cluster.local/trading/status'",
            args,
        )
        self.assertIn("--runtime-window-target-plan-url-timeout-seconds 45", args)
        self.assertIn("--runtime-window-target-plan-url-attempts 3", args)
        self.assertIn(
            "--runtime-window-target-plan-url-retry-backoff-seconds 5",
            args,
        )
        self.assertNotIn(
            "--runtime-window-target-plan-url "
            "http://torghut.torghut.svc.cluster.local/trading/paper-route-target-plan",
            args,
        )
        self.assertNotIn(
            "--runtime-window-target-plan-url "
            "http://torghut-sim.torghut.svc.cluster.local/trading/paper-route-target-plan",
            args,
        )
        self.assertNotIn(
            "--runtime-window-target-plan-url "
            "http://torghut.torghut.svc.cluster.local/trading/paper-route-evidence",
            args,
        )
        self.assertIn("--runtime-window-target-plan-exclusive", args)
        self.assertNotIn("--runtime-window-target-plan-required", args)
        self.assertIn("--runtime-window-target-plan-settlement-seconds 3600", args)
        self.assertNotIn("--runtime-window-targets-from-latest-autoresearch", args)
        self.assertNotIn("--runtime-window-targets-from-registry", args)
        self.assertIn(
            "--strategy-spec-ref microbar_cross_sectional_pairs_v1@research", args
        )
        self.assertIn("--runtime-window-hypothesis-id H-PAIRS-01", args)
        self.assertIn("--runtime-window-candidate-id c88421d619759b2cfaa6f4d0", args)
        self.assertIn(
            "--runtime-window-strategy-family microbar_cross_sectional_pairs", args
        )
        self.assertIn(
            "--runtime-window-strategy-name microbar-cross-sectional-pairs-v1", args
        )
        self.assertIn(
            "--runtime-window-source-manifest-ref config/trading/hypotheses/h-pairs-01.json",
            args,
        )
        self.assertNotIn("--runtime-window-hypothesis-id H-TSMOM-01", args)
        self.assertNotIn('--runtime-window-target \'{"hypothesis_id"', args)
        renewal_args = args[
            args.index("scripts/renew_latest_empirical_promotion_jobs.py") :
        ]
        self.assertNotIn("PA3SX7FYNUTF", renewal_args)
        self.assertIn("--runtime-window-account-label TORGHUT_SIM", args)
        self.assertIn("--runtime-window-observed-stage paper", args)
        self.assertIn("--runtime-window-source-dsn-env SIM_DB_DSN", args)
        self.assertIn("--runtime-window-target-dsn-env SIM_DB_DSN", args)
        self.assertNotIn(
            '"source_kind":"live_runtime_observed"',
            args,
        )
        self.assertNotIn('"evidence_collection_stage":"live"', args)
        self.assertNotIn(
            '"runtime_window_import_promotion_blockers":["drift_checks_not_ok"]',
            args,
        )
        self.assertIn(
            "RENEWAL_OUTPUT=/tmp/torghut-empirical-renewal/runtime-window-renewal.json",
            args,
        )
        self.assertIn(
            "PROOF_PACKET_OUTPUT=/tmp/torghut-empirical-renewal/runtime-ledger-proof-packet.json",
            args,
        )
        self.assertIn(
            "HPAIRS_SOURCE_PROOF_CENSUS_OUTPUT=/tmp/torghut-empirical-renewal/hpairs-source-proof-census.json",
            args,
        )
        self.assertIn(
            'mkdir -p "$(dirname "${RENEWAL_OUTPUT}")" "$(dirname "${PROOF_PACKET_OUTPUT}")" "$(dirname "${HPAIRS_SOURCE_PROOF_CENSUS_OUTPUT}")"',
            args,
        )
        self.assertIn("scripts/audit_hpairs_source_proof_census.py", args)
        self.assertIn('--dsn "${SIM_DB_DSN}"', args)
        self.assertIn("--source-account-label TORGHUT_SIM", args)
        self.assertIn('> "${HPAIRS_SOURCE_PROOF_CENSUS_OUTPUT}"', args)
        self.assertIn(
            '--hpairs-source-proof-census-file "${HPAIRS_SOURCE_PROOF_CENSUS_OUTPUT}"',
            args,
        )
        self.assertIn("scripts/assemble_runtime_ledger_proof_packet.py", args)
        self.assertIn(
            "--status-service-base-url http://torghut.torghut.svc.cluster.local",
            args,
        )
        self.assertIn(
            "--paper-route-service-base-url http://torghut-sim.torghut.svc.cluster.local",
            args,
        )
        self.assertNotIn(
            "--paper-route-service-base-url http://torghut.torghut.svc.cluster.local",
            args,
        )
        self.assertIn(
            "--completion-service-base-url http://torghut.torghut.svc.cluster.local",
            args,
        )
        self.assertIn("--timeout-seconds 30", args)
        self.assertIn("--proof-mode authority", args)
        self.assertIn('--runtime-window-import-file "${RENEWAL_OUTPUT}"', args)
        self.assertIn("--min-runtime-ledger-net-pnl 10000", args)
        self.assertIn("--min-runtime-ledger-daily-net-pnl 500", args)
        self.assertIn("--min-runtime-ledger-trading-days 20", args)
        self.assertIn("--max-runtime-ledger-drawdown-pct-equity 0.03", args)
        self.assertIn("--max-runtime-ledger-best-day-share 0.25", args)
        self.assertIn("--max-runtime-ledger-symbol-concentration-share 0.35", args)
        self.assertIn('--output-file "${PROOF_PACKET_OUTPUT}"', args)
        self.assertIn(
            "--artifact-prefix 'runtime-ledger-proof-packets/{run_id}'",
            args,
        )
        self.assertIn("--require-artifact-upload", args)
        self.assertIn("--allow-blocked-exit-zero", args)

    def test_migration_job_prepares_sim_database_before_sim_upgrade(self) -> None:
        manifest = _load_yaml_mapping(
            "argocd/applications/torghut/db-migrations-job.yaml"
        )
        containers = (
            manifest.get("spec", {})
            .get("template", {})
            .get("spec", {})
            .get("containers", [])
        )
        self.assertTrue(containers)
        container = containers[0]
        args = "\n".join(str(item) for item in container.get("args", []))
        env = [item for item in container.get("env", []) if isinstance(item, Mapping)]
        upgrade_to_research_objects = (
            'DB_DSN="${TORGHUT_SIM_ADMIN_DSN}" /opt/venv/bin/alembic -c /app/alembic.ini '
            "upgrade 0026_strategy_factory_research_objects"
        )
        upgrade_heads = 'DB_DSN="${TORGHUT_SIM_ADMIN_DSN}" /opt/venv/bin/alembic -c /app/alembic.ini upgrade heads'
        env_names = {item.get("name") for item in env}
        env_by_name = {item.get("name"): item for item in env}
        env_order = [item.get("name") for item in env]

        self.assertIn("TORGHUT_POSTGRES_ADMIN_URI", env_names)
        self.assertIn("TORGHUT_SIM_ADMIN_DSN", env_names)
        self.assertLess(
            env_order.index("TORGHUT_SIM_ADMIN_DB_PASSWORD"),
            env_order.index("TORGHUT_POSTGRES_ADMIN_URI"),
        )
        self.assertEqual(
            env_by_name["TORGHUT_POSTGRES_ADMIN_URI"].get("value"),
            "postgresql://$(TORGHUT_SIM_ADMIN_DB_USER):$(TORGHUT_SIM_ADMIN_DB_PASSWORD)@"
            "$(TORGHUT_SIM_ADMIN_DB_HOST):$(TORGHUT_SIM_ADMIN_DB_PORT)/postgres",
        )
        self.assertNotIn("valueFrom", env_by_name["TORGHUT_POSTGRES_ADMIN_URI"])
        self.assertIn("database_url(admin_uri, 'postgres')", args)
        self.assertIn("CREATE DATABASE", args)
        self.assertIn("GRANT ALL PRIVILEGES ON DATABASE", args)
        self.assertIn("CREATE EXTENSION IF NOT EXISTS vector", args)
        self.assertIn("postgresql+psycopg://", args)
        self.assertIn("select quote_ident(:role_name)", args)
        self.assertIn("c.oid::regclass::text AS object_name", args)
        self.assertIn("pg_get_userbyid(c.relowner) <> :runtime_role", args)
        self.assertIn("FROM pg_depend d", args)
        self.assertIn("d.classid = 'pg_class'::regclass", args)
        self.assertIn("d.objid = c.oid", args)
        self.assertIn("d.deptype = 'a'", args)
        self.assertIn("owner_statement = (", args)
        self.assertIn("ALTER {owned_relation['object_type']}", args)
        self.assertIn("{owned_relation['object_name']} OWNER TO {quoted_role}", args)
        self.assertNotIn("DO $$", args)
        self.assertNotIn("format(", args)
        self.assertIn(upgrade_to_research_objects, args)
        self.assertIn("0028_autoresearch_epoch_ledgers", args)
        self.assertIn("whitepaper_claims", args)
        self.assertIn("autoresearch_portfolio_candidates", args)
        self.assertIn("public_table_exists", args)
        self.assertIn(upgrade_heads, args)
        self.assertIn("missing_relations = connection.execute", args)
        self.assertIn("missing_sequences = connection.execute", args)
        self.assertIn("missing_functions = connection.execute", args)
        self.assertIn("has_table_privilege(:runtime_role, c.oid, 'SELECT')", args)
        self.assertIn("has_sequence_privilege(:runtime_role, c.oid, 'USAGE')", args)
        self.assertIn("has_function_privilege(:runtime_role, p.oid, 'EXECUTE')", args)
        self.assertIn(
            "GRANT ALL PRIVILEGES ON TABLE {object_name} TO {quoted_role}", args
        )
        self.assertIn(
            "GRANT ALL PRIVILEGES ON SEQUENCE {object_name} TO {quoted_role}", args
        )
        self.assertIn("GRANT EXECUTE ON FUNCTION {object_name} TO {quoted_role}", args)
        self.assertIn(
            "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON TABLES",
            args,
        )
        self.assertIn("granted missing simulation runtime privileges", args)
        self.assertNotIn("GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public", args)
        self.assertNotIn("GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public", args)
        self.assertNotIn("GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public", args)
        self.assertLess(
            args.index("CREATE EXTENSION IF NOT EXISTS vector"),
            args.index("c.oid::regclass::text AS object_name"),
        )
        self.assertLess(
            args.index("owner_statement = ("),
            args.index(upgrade_to_research_objects),
        )
        self.assertLess(
            args.index(upgrade_to_research_objects),
            args.index("stamped existing whitepaper/autoresearch ledger objects"),
        )
        self.assertLess(
            args.index("stamped existing whitepaper/autoresearch ledger objects"),
            args.index(upgrade_heads),
        )
        self.assertLess(
            args.index(upgrade_heads),
            args.index("missing_relations = connection.execute"),
        )

    def test_profitability_sweep_universes_are_chip_only(self) -> None:
        trading_config_dir = (
            _repo_root() / "services" / "torghut" / "config" / "trading"
        )
        checked_universe_sets = 0
        for path in sorted(trading_config_dir.glob("profitability-frontier*.yaml")):
            payload = safe_load(path.read_text(encoding="utf-8"))
            self.assertIsInstance(payload, dict, f"{path} did not parse to a mapping")
            overrides = cast(Mapping[str, object], payload).get("strategy_overrides")
            if not isinstance(overrides, Mapping):
                continue
            raw_universe_sets = overrides.get("universe_symbols")
            if raw_universe_sets is None:
                continue
            self.assertIsInstance(
                raw_universe_sets,
                list,
                f"{path} missing strategy_overrides.universe_symbols",
            )
            for index, raw_symbols in enumerate(cast(list[object], raw_universe_sets)):
                self.assertIsInstance(
                    raw_symbols,
                    list,
                    f"{path} universe_symbols[{index}] is not a list",
                )
                _assert_exact_live_execution_chip_universe(
                    self,
                    cast(list[object], raw_symbols),
                    context=f"{path.name} universe_symbols[{index}]",
                )
                checked_universe_sets += 1
        self.assertGreater(checked_universe_sets, 0)

    def test_washout_profitability_frontier_requires_capital_safe_replay(
        self,
    ) -> None:
        payload = _load_yaml_mapping(
            "services/torghut/config/trading/profitability-frontier-consistent-washout.yaml"
        )
        consistency_constraints = payload.get("consistency_constraints")
        self.assertIsInstance(consistency_constraints, Mapping)
        constraints = cast(Mapping[str, object], consistency_constraints)

        self.assertIs(payload.get("disable_other_strategies"), True)
        self.assertLessEqual(
            Decimal(str(constraints.get("max_gross_exposure_pct_equity"))),
            Decimal("1.0"),
        )
        self.assertGreaterEqual(
            Decimal(str(constraints.get("min_cash"))),
            Decimal("0"),
        )

    def test_candidate_records_are_not_left_on_mixed_large_cap_universes(self) -> None:
        candidates_dir = (
            _repo_root() / "services" / "torghut" / "config" / "trading" / "candidates"
        )
        for path in sorted(candidates_dir.glob("*.json")):
            payload = json.loads(path.read_text(encoding="utf-8"))
            self.assertIsInstance(payload, dict, f"{path} did not parse to a mapping")
            candidate_strategy = payload.get("candidate_strategy")
            self.assertIsInstance(
                candidate_strategy,
                Mapping,
                f"{path} missing candidate_strategy",
            )
            raw_symbols = cast(Mapping[str, object], candidate_strategy).get(
                "universe_symbols"
            )
            self.assertIsInstance(
                raw_symbols,
                list,
                f"{path} missing candidate_strategy.universe_symbols",
            )
            _assert_exact_live_execution_chip_universe(
                self,
                cast(list[object], raw_symbols),
                context=f"{path.name} candidate universe",
            )

    def test_live_manifest_does_not_import_autonomy_env_from(self) -> None:
        manifest = _load_torghut_knative_manifest()
        containers = (
            manifest.get("spec", {})
            .get("template", {})
            .get("spec", {})
            .get("containers", [])
        )
        self.assertTrue(containers)
        first_container = containers[0]
        env_from = first_container.get("envFrom", [])
        self.assertEqual(env_from, [])

    def test_manifest_simple_lane_profile_is_enforced(self) -> None:
        env = _load_torghut_knative_env()
        self.assertTrue(_manifest_bool(env, "TRADING_ENABLED"))
        self.assertEqual(env.get("TRADING_MODE"), "live")
        self.assertEqual(env.get("TRADING_PIPELINE_MODE"), "simple")
        self.assertEqual(env.get("TRADING_UNIVERSE_SOURCE"), "static")
        self.assertEqual(env.get("TRADING_UNIVERSE_REQUIRE_NON_EMPTY_JANGAR"), "false")
        self.assertEqual(env.get("TRADING_UNIVERSE_STATIC_FALLBACK_ENABLED"), "false")
        _assert_exact_quote_covered_paper_strategy_universe(
            self,
            str(env.get("TRADING_STATIC_SYMBOLS", "")).split(","),
            context="live static universe",
        )
        self.assertTrue(_manifest_bool(env, "TRADING_SIMPLE_SUBMIT_ENABLED"))
        self.assertEqual(
            env.get("TRADING_LIVE_SUBMIT_ACTIVATION_EXPIRES_AT"),
            "2026-06-22T20:05:00Z",
        )
        self.assertTrue(_manifest_bool(env, "TRADING_SIMPLE_PAPER_ROUTE_PROBE_ENABLED"))
        self.assertTrue(
            _manifest_bool(env, "TRADING_SIMPLE_PAPER_ROUTE_PROBE_ALLOW_LIVE_MODE")
        )
        self.assertEqual(
            env.get("TRADING_SIMPLE_PAPER_ROUTE_PROBE_MAX_NOTIONAL"),
            _SIMPLE_PAPER_ROUTE_PROBE_MAX_NOTIONAL,
        )
        self.assertEqual(
            env.get("TRADING_SIMPLE_PAPER_ROUTE_PROBE_RETRY_BATCH_LIMIT"), "0"
        )
        self.assertEqual(
            env.get("TRADING_SIMPLE_PAPER_ROUTE_PROBE_RETRY_SCAN_LIMIT"), "0"
        )
        self.assertEqual(env.get("TRADING_SIMPLE_MAX_NOTIONAL_PER_ORDER"), "100")
        self.assertEqual(env.get("TRADING_SIMPLE_MAX_NOTIONAL_PER_SYMBOL"), "250")
        self.assertEqual(env.get("TRADING_SIMPLE_MAX_ORDER_PCT_EQUITY"), "0.25")
        self.assertEqual(
            env.get("TRADING_SIMPLE_MAX_GROSS_EXPOSURE_PCT_EQUITY"),
            "0.05",
        )
        self.assertTrue(_manifest_bool(env, "TRADING_ALPACA_QUOTE_FALLBACK_ENABLED"))
        self.assertEqual(env.get("TRADING_ALPACA_QUOTE_FEED"), "iex")
        self.assertEqual(env.get("TRADING_ALPACA_QUOTE_MAX_AGE_SECONDS"), "20")
        self.assertTrue(
            _manifest_bool(env, "TRADING_ALPACA_QUOTE_FALLBACK_MARKET_SESSION_REQUIRED")
        )
        self.assertEqual(env.get("TRADING_ALPACA_QUOTE_FALLBACK_BACKOFF_SECONDS"), "60")
        self.assertEqual(
            env.get("TRADING_OPTIONS_CATALOG_FRESHNESS_CACHE_SECONDS"), "30"
        )
        self.assertFalse(_manifest_bool(env, "TRADING_AUTONOMY_ENABLED"))
        self.assertFalse(_manifest_bool(env, "TRADING_AUTONOMY_ALLOW_LIVE_PROMOTION"))
        self.assertFalse(_manifest_bool(env, "TRADING_KILL_SWITCH_ENABLED"))
        self.assertFalse(_manifest_bool(env, "TRADING_EMERGENCY_STOP_ENABLED"))
        self.assertNotIn("TRADING_EXECUTION_ADAPTER_POLICY", env)
        self.assertNotIn("TRADING_EXECUTION_ADAPTER", env)
        self.assertNotIn("TRADING_EXECUTION_FALLBACK_ADAPTER", env)

    def test_manifest_rollout_toggles_disable_execution_advisor(self) -> None:
        knative_env = _load_torghut_knative_env()
        self.assertEqual(knative_env.get("TRADING_EXECUTION_ADVISOR_ENABLED"), "false")
        self.assertEqual(
            knative_env.get("TRADING_EXECUTION_ADVISOR_LIVE_APPLY_ENABLED"),
            "false",
        )

    def test_feature_flags_defaults_keep_execution_advisor_disabled(self) -> None:
        flags = _load_torghut_feature_flags()

        def _require_flag_enabled_false(key: str) -> None:
            raw_flag = flags.get(key)
            self.assertIsInstance(raw_flag, dict)
            self.assertIn("enabled", raw_flag)
            self.assertIs(raw_flag.get("enabled"), False)

        _require_flag_enabled_false("torghut_trading_execution_advisor_enabled")
        _require_flag_enabled_false(
            "torghut_trading_execution_advisor_live_apply_enabled"
        )
        _require_flag_enabled_false(
            "torghut_trading_db_schema_graph_allow_divergence_roots"
        )
        _require_flag_enabled_false("torghut_llm_fail_open_live_approved")
        _require_flag_enabled_false("torghut_llm_shadow_mode")
