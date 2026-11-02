from __future__ import annotations

from tests.live_config_manifest_contract.support import (
    Decimal,
    Mapping,
    _TestLiveConfigManifestContractBase,
    _assert_exact_live_execution_chip_universe,
    _assert_exact_quote_covered_paper_strategy_universe,
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


def _migration_job_context() -> tuple[
    Mapping[str, object],
    str,
    set[object],
    dict[object, Mapping[str, object]],
    list[object],
]:
    manifest = _load_yaml_mapping("argocd/applications/torghut/db-migrations-job.yaml")
    containers = (
        manifest.get("spec", {})
        .get("template", {})
        .get("spec", {})
        .get("containers", [])
    )
    if not containers:
        raise AssertionError("migration job is missing containers")
    container = cast(Mapping[str, object], containers[0])
    args = "\n".join(str(item) for item in container.get("args", []))
    env = [item for item in container.get("env", []) if isinstance(item, Mapping)]
    return (
        container,
        args,
        {item.get("name") for item in env},
        {item.get("name"): item for item in env},
        [item.get("name") for item in env],
    )


class TestTorghutScheduledMaintenance(_TestLiveConfigManifestContractBase):
    def test_tigerbeetle_journal_order_events_cronjob_is_removed(self) -> None:
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
            ).is_file(),
            "retain the bounded runner for explicit operator-driven repair",
        )

    def test_empirical_promotion_renewal_cronjob_is_removed_from_gitops(
        self,
    ) -> None:
        relative_path = (
            "argocd/applications/torghut/empirical-promotion-renewal-cronjob.yaml"
        )
        self.assertFalse((_repo_root() / relative_path).exists())
        kustomization = _load_yaml_mapping(
            "argocd/applications/torghut/kustomization.yaml"
        )
        resources = kustomization.get("resources")
        self.assertIsInstance(resources, list)
        self.assertNotIn("empirical-promotion-renewal-cronjob.yaml", resources)

    def test_migration_job_prepares_sim_database_before_sim_upgrade(self) -> None:
        container, args, env_names, env_by_name, env_order = _migration_job_context()
        upgrade_to_research_objects = (
            'DB_DSN="${TORGHUT_SIM_ADMIN_DSN}" alembic -c /app/alembic.ini '
            "upgrade 0026_strategy_factory_research_objects"
        )
        upgrade_heads = 'DB_DSN="${TORGHUT_SIM_ADMIN_DSN}" alembic -c /app/alembic.ini upgrade heads'

        self.assertEqual(container.get("workingDir"), "/app")
        self.assertEqual(env_by_name["PYTHONPATH"].get("value"), "/app")
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
        for forbidden_snippet in ("DO $$", "format(", "/opt/venv/bin/"):
            self.assertNotIn(forbidden_snippet, args)
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

    def test_api_manifest_simple_lane_profile_is_enforced(self) -> None:
        env = _load_torghut_knative_env()
        self.assertFalse(_manifest_bool(env, "TRADING_ENABLED"))
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
        self.assertNotIn("TRADING_SIMPLE_PAPER_ROUTE_PROBE_ENABLED", env)
        self.assertNotIn("TRADING_SIMPLE_PAPER_ROUTE_PROBE_ALLOW_LIVE_MODE", env)
        self.assertNotIn("TRADING_SIMPLE_PAPER_ROUTE_PROBE_MAX_NOTIONAL", env)
        self.assertNotIn("TRADING_SIMPLE_MAX_NOTIONAL_PER_ORDER", env)
        self.assertNotIn("TRADING_SIMPLE_MAX_NOTIONAL_PER_SYMBOL", env)
        self.assertNotIn("TRADING_PAPER_ROUTE_TARGET_PLAN_URL", env)
        self.assertEqual(env.get("TRADING_SIMPLE_MAX_ORDER_PCT_EQUITY"), "0.50")
        self.assertEqual(env.get("TRADING_SIMPLE_MAX_SYMBOL_PCT_EQUITY"), "0.50")
        self.assertEqual(
            env.get("TRADING_SIMPLE_MAX_GROSS_EXPOSURE_PCT_EQUITY"),
            "1.0",
        )
        self.assertEqual(env.get("TRADING_SIMPLE_MAX_NET_EXPOSURE_PCT_EQUITY"), "0.50")
        self.assertEqual(env.get("TRADING_SIMPLE_BUYING_POWER_RESERVE_BPS"), "1000")
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
        self.assertTrue(_manifest_bool(env, "TRADING_EMERGENCY_STOP_ENABLED"))
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


class TestTigerBeetleJournalRuntimeReconcileFreshnessHeadroom(
    _TestLiveConfigManifestContractBase
):
    def test_live_runtime_command_preserves_reconciliation_headroom(self) -> None:
        [command] = [
            item
            for item in tigerbeetle_journal_runner._live_commands(
                execution_batch_size=5
            )
            if item.source
            == tigerbeetle_journal_runner.SOURCE_TYPE_RUNTIME_LEDGER_BUCKET
        ]

        self.assertEqual(
            command.reconcile_empty_selection_freshness_headroom_seconds,
            tigerbeetle_journal_runner.RUNTIME_LEDGER_RECONCILE_FRESHNESS_HEADROOM_SECONDS,
        )

    def test_sim_runtime_command_preserves_reconciliation_headroom(self) -> None:
        [command] = [
            item
            for item in tigerbeetle_journal_runner._sim_commands()
            if item.source
            == tigerbeetle_journal_runner.SOURCE_TYPE_RUNTIME_LEDGER_BUCKET
        ]

        self.assertEqual(
            command.reconcile_empty_selection_freshness_headroom_seconds,
            tigerbeetle_journal_runner.RUNTIME_LEDGER_RECONCILE_FRESHNESS_HEADROOM_SECONDS,
        )
