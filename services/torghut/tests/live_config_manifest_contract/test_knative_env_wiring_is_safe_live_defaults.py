from __future__ import annotations

from hashlib import sha256
import tomllib

from tests.live_config_manifest_contract.support import (
    Decimal,
    Mapping,
    Settings,
    _QUOTE_COVERED_PAPER_STRATEGY_UNIVERSE,
    _TestLiveConfigManifestContractBase,
    _assert_chip_universe,
    _assert_exact_live_execution_chip_universe,
    _assert_exact_quote_covered_paper_strategy_universe,
    _container_env,
    _csv_symbols,
    _csv_values,
    _load_job_container,
    _load_knative_container,
    _load_knative_env,
    _load_torghut_clickhouse_manifest,
    _load_torghut_knative_env,
    _load_torghut_strategy_catalog,
    _load_yaml_mapping,
    _manifest_bool,
    _params,
    _repo_root,
    _strategy_decimal,
    cast,
)


class TestKnativeEnvWiringIsSafeLiveDefaults(_TestLiveConfigManifestContractBase):
    def test_knative_env_wiring_is_safe_live_defaults(self) -> None:
        env = _load_torghut_knative_env()
        settings = Settings(**env)

        self.assertEqual(settings.trading_mode, "live")
        self.assertEqual(settings.trading_pipeline_mode, "simple")
        self.assertEqual(settings.trading_universe_source, "static")
        self.assertEqual(
            _csv_values(env.get("TRADING_SIGNAL_ALLOWED_SOURCES")),
            {"ta"},
            "live runtime must fail closed on accepted TA and must not promote REST backfill into live accepted sources",
        )
        self.assertNotIn("TRADING_STRATEGY_SCHEDULER_ENABLED", env)
        self.assertFalse(settings.trading_autonomy_enabled)
        self.assertFalse(settings.trading_autonomy_allow_live_promotion)
        self.assertFalse(settings.trading_evidence_continuity_enabled)
        self.assertTrue(settings.trading_emergency_stop_enabled)
        self.assertEqual(settings.trading_daily_loss_stop_pct_equity, 0.01)
        self.assertEqual(settings.trading_persistent_drawdown_stop_pct_equity, 0.05)
        self.assertEqual(settings.trading_pair_delta_tolerance_bps, 8.0)
        self.assertFalse(settings.trading_feature_flags_enabled)
        self.assertFalse(settings.trading_execution_advisor_enabled)
        self.assertFalse(settings.trading_execution_advisor_live_apply_enabled)
        self.assertEqual(env.get("LLM_ENABLED"), "false")
        self.assertFalse(settings.llm_enabled)
        self.assertEqual(env.get("LLM_DSPY_RUNTIME_MODE"), "disabled")
        self.assertEqual(settings.llm_dspy_runtime_mode, "disabled")
        self.assertTrue(settings.trading_fractional_equities_enabled)
        self.assertFalse(settings.trading_universe_require_non_empty_jangar)
        self.assertFalse(settings.trading_universe_static_fallback_enabled)
        self.assertEqual(settings.trading_universe_max_stale_seconds, 900)
        self.assertIsNone(settings.trading_jangar_symbols_url)
        self.assertEqual(
            settings.trading_jangar_control_plane_status_url,
            "http://agents.agents.svc.cluster.local/ready",
        )
        self.assertIsNone(settings.trading_jangar_quant_health_url)
        self.assertEqual(
            settings.trading_market_context_url,
            "http://jangar.jangar.svc.cluster.local/api/torghut/market-context",
        )
        self.assertEqual(
            set(settings.trading_static_symbols),
            set(_QUOTE_COVERED_PAPER_STRATEGY_UNIVERSE),
        )
        self.assertFalse(settings.trading_market_context_required)
        self.assertEqual(settings.trading_market_context_fail_mode, "shadow_only")
        self.assertEqual(
            set(settings.trading_universe_static_fallback_symbols),
            set(_QUOTE_COVERED_PAPER_STRATEGY_UNIVERSE),
        )
        self.assertNotIn("TRADING_FEATURE_FLAGS_URL", env)
        self.assertNotIn("TRADING_FORECAST_SERVICE_URL", env)
        self.assertNotIn("TRADING_LEAN_RUNNER_URL", env)
        self.assertNotIn("JANGAR_SYMBOLS_URL", env)
        self.assertEqual(
            env.get("TRADING_JANGAR_CONTROL_PLANE_STATUS_URL"),
            settings.trading_jangar_control_plane_status_url,
        )
        self.assertNotIn("TRADING_JANGAR_CONTROL_PLANE_CACHE_TTL_SECONDS", env)
        self.assertEqual(env.get("TRADING_JANGAR_CONTROL_PLANE_TIMEOUT_SECONDS"), "30")
        self.assertEqual(settings.trading_jangar_control_plane_timeout_seconds, 30)
        self.assertNotIn("TRADING_JANGAR_QUANT_HEALTH_REQUIRED", env)
        self.assertNotIn("TRADING_JANGAR_QUANT_HEALTH_URL", env)
        self.assertEqual(
            env.get("TRADING_MARKET_CONTEXT_URL"), settings.trading_market_context_url
        )
        self.assertEqual(
            env.get("AGENTS_BASE_URL"), "http://agents.agents.svc.cluster.local"
        )
        self.assertEqual(env.get("TRADING_MARKET_CONTEXT_TIMEOUT_SECONDS"), "5")
        self.assertEqual(env.get("TRADING_MARKET_CONTEXT_REQUIRED"), "false")
        self.assertEqual(env.get("TRADING_MARKET_CONTEXT_FAIL_MODE"), "shadow_only")
        self.assertNotIn("JANGAR_BASE_URL", env)

    def test_live_manifest_limits_jangar_trading_loop_urls(self) -> None:
        env = _load_torghut_knative_env()

        blocked_env = {
            "JANGAR_SYMBOLS_URL",
            "TRADING_JANGAR_CONTROL_PLANE_CACHE_TTL_SECONDS",
            "TRADING_JANGAR_QUANT_HEALTH_REQUIRED",
            "TRADING_JANGAR_QUANT_HEALTH_URL",
        }
        self.assertTrue(blocked_env.isdisjoint(env))
        self.assertEqual(
            env.get("TRADING_JANGAR_CONTROL_PLANE_STATUS_URL"),
            "http://agents.agents.svc.cluster.local/ready",
        )
        self.assertEqual(env.get("TRADING_JANGAR_CONTROL_PLANE_TIMEOUT_SECONDS"), "30")
        self.assertEqual(
            env.get("TRADING_MARKET_CONTEXT_URL"),
            "http://jangar.jangar.svc.cluster.local/api/torghut/market-context",
        )

    def test_strategy_catalog_universes_are_chip_only(self) -> None:
        for strategy in _load_torghut_strategy_catalog():
            raw_symbols = strategy.get("universe_symbols")
            self.assertIsInstance(
                raw_symbols,
                list,
                f"{strategy.get('name')} missing explicit universe_symbols",
            )
            _assert_chip_universe(
                self,
                cast(list[object], raw_symbols),
                context=f"strategy {strategy.get('name')}",
            )

    def test_enabled_paper_sleeves_are_chip_universe_with_safe_profiles(self) -> None:
        strategies = _load_torghut_strategy_catalog()
        enabled = {
            str(strategy.get("name")): strategy
            for strategy in strategies
            if _manifest_bool(strategy, "enabled")
        }
        self.assertEqual(
            set(enabled),
            {
                "microbar-volume-continuation-long-top2-chip-v1",
                "microbar-prev-day-open45-reversal-long-top1-chip-v1",
                "intraday-tsmom-profit-v3",
                "breakout-continuation-long-v1",
                "mean-reversion-rebound-long-v1",
                "mean-reversion-exhaustion-short-v1",
                "washout-rebound-long-v1",
                "late-day-continuation-long-v1",
                "microbar-cross-sectional-pairs-v1",
            },
        )

        for name, strategy in enabled.items():
            description = str(strategy.get("description") or "").lower()
            params = _params(strategy)
            raw_symbols = strategy.get("universe_symbols")

            self.assertIn("paper-only", description)
            self.assertIsInstance(raw_symbols, list)
            if name == "intraday-tsmom-profit-v3":
                self.assertIn("$500/day", description)
                _assert_exact_live_execution_chip_universe(
                    self,
                    cast(list[object], raw_symbols),
                    context=f"{name} universe",
                )
            elif name == "microbar-cross-sectional-pairs-v1":
                self.assertIn("h-pairs", description)
                _assert_exact_live_execution_chip_universe(
                    self,
                    cast(list[object], raw_symbols),
                    context=f"{name} source collection universe",
                )
            else:
                self.assertIn("$300/day", description)
                _assert_exact_quote_covered_paper_strategy_universe(
                    self,
                    cast(list[object], raw_symbols),
                    context=f"{name} universe",
                )
            self.assertNotIn("max_notional_per_trade", strategy)
            position_limit = _strategy_decimal(strategy, "max_position_pct_equity")
            self.assertIsNotNone(position_limit)
            self.assertLessEqual(position_limit or Decimal("0"), Decimal("0.5"))
            if str(strategy.get("strategy_type")) == "microbar_cross_sectional_long_v1":
                self.assertEqual(params.get("position_isolation_mode"), "per_strategy")
            elif (
                str(strategy.get("strategy_type"))
                == "microbar_cross_sectional_pairs_v1"
            ):
                self.assertEqual(name, "microbar-cross-sectional-pairs-v1")
                self.assertEqual(params.get("position_isolation_mode"), "per_strategy")
                self.assertEqual(params.get("max_gross_exposure_pct_equity"), "1.0")
                self.assertEqual(params.get("max_pair_legs"), "2")
                self.assertEqual(params.get("top_n"), "1")
                self.assertEqual(
                    params.get("min_cross_section_continuation_rank"), "0.55"
                )
                self.assertEqual(params.get("entry_minute_after_open"), "60")
                self.assertEqual(params.get("exit_minute_after_open"), "120")
                self.assertEqual(params.get("session_flatten_start_minute_utc"), "1170")
                self.assertEqual(params.get("long_stop_loss_bps"), "10")
                self.assertEqual(
                    params.get("long_trailing_stop_activation_profit_bps"), "8"
                )
                self.assertEqual(params.get("long_trailing_stop_drawdown_bps"), "4")
                self.assertEqual(params.get("max_hold_seconds"), "7200")
                self.assertEqual(params.get("max_session_negative_exit_bps"), "10")
                self.assertEqual(params.get("max_stop_loss_exits_per_session"), "1")
                self.assertEqual(params.get("stop_loss_lockout_seconds"), "1800")
            elif str(strategy.get("strategy_type")) == "intraday_tsmom_v1":
                self.assertEqual(name, "intraday-tsmom-profit-v3")
                self.assertEqual(params.get("max_spread_bps"), "20")
                self.assertEqual(params.get("long_stop_loss_bps"), "6")
                self.assertEqual(params.get("short_stop_loss_bps"), "6")
                self.assertEqual(params.get("entry_cooldown_seconds"), "1200")
                self.assertEqual(params.get("position_isolation_mode"), "per_strategy")
            elif str(strategy.get("strategy_type")) == "breakout_continuation_long_v1":
                self.assertEqual(name, "breakout-continuation-long-v1")
                self.assertEqual(params.get("max_spread_bps"), "20")
                self.assertEqual(params.get("position_isolation_mode"), "per_strategy")
            elif str(strategy.get("strategy_type")) in {
                "mean_reversion_rebound_long_v1",
                "mean_reversion_exhaustion_short_v1",
            }:
                self.assertIn(
                    name,
                    {
                        "mean-reversion-rebound-long-v1",
                        "mean-reversion-exhaustion-short-v1",
                    },
                )
                self.assertEqual(params.get("position_isolation_mode"), "per_strategy")
                self.assertLessEqual(
                    Decimal(str(params.get("max_spread_bps") or "0")),
                    Decimal("20"),
                )
            elif str(strategy.get("strategy_type")) == "washout_rebound_long_v1":
                self.assertEqual(name, "washout-rebound-long-v1")
                self.assertEqual(params.get("position_isolation_mode"), "per_strategy")
                self.assertLessEqual(
                    Decimal(str(params.get("max_spread_bps") or "0")),
                    Decimal("20"),
                )
            elif str(strategy.get("strategy_type")) == "late_day_continuation_long_v1":
                self.assertEqual(name, "late-day-continuation-long-v1")
                self.assertEqual(params.get("position_isolation_mode"), "per_strategy")
                self.assertLessEqual(
                    Decimal(str(params.get("max_spread_bps") or "0")),
                    Decimal("22"),
                )
            else:
                self.fail(
                    f"enabled paper strategy {name} has unexpected type {strategy.get('strategy_type')}"
                )

    def test_runtime_symbol_sources_preserve_trading_and_observation_universes(
        self,
    ) -> None:
        live_env = _load_torghut_knative_env()
        sim_env = _load_knative_env(
            "argocd/applications/torghut/knative-service-sim.yaml"
        )
        ws_config = _load_yaml_mapping("argocd/applications/torghut/ws/configmap.yaml")
        ws_container = _load_knative_container(
            "argocd/applications/torghut/ws/deployment.yaml"
        )
        universe_config = _load_yaml_mapping(
            "argocd/applications/torghut/clickhouse/bayn-universe-v2-configmap.yaml"
        )
        ws_data = ws_config.get("data")
        self.assertIsInstance(ws_data, Mapping)
        ws_metadata = ws_config.get("metadata")
        self.assertIsInstance(ws_metadata, Mapping)
        ws_annotations = cast(Mapping[str, object], ws_metadata).get("annotations")
        self.assertIsInstance(ws_annotations, Mapping)
        universe_data = universe_config.get("data")
        self.assertIsInstance(universe_data, Mapping)

        env_entries = cast(list[Mapping[str, object]], ws_container.get("env", []))
        env_by_name = {
            str(entry.get("name")): entry
            for entry in env_entries
            if isinstance(entry.get("name"), str)
        }

        _assert_exact_quote_covered_paper_strategy_universe(
            self,
            _csv_symbols(live_env.get("TRADING_UNIVERSE_STATIC_FALLBACK_SYMBOLS")),
            context="live static fallback symbols",
        )
        _assert_exact_quote_covered_paper_strategy_universe(
            self,
            _csv_symbols(live_env.get("TRADING_UNIVERSE_SYMBOL_ALLOWLIST")),
            context="live runtime universe allowlist",
        )
        _assert_exact_quote_covered_paper_strategy_universe(
            self,
            _csv_symbols(sim_env.get("TRADING_UNIVERSE_STATIC_FALLBACK_SYMBOLS")),
            context="sim static fallback symbols",
        )
        _assert_exact_quote_covered_paper_strategy_universe(
            self,
            _csv_symbols(sim_env.get("TRADING_UNIVERSE_SYMBOL_ALLOWLIST")),
            context="sim runtime universe allowlist",
        )
        ws_symbols = _csv_symbols(cast(Mapping[str, object], ws_data).get("SYMBOLS"))
        _assert_exact_quote_covered_paper_strategy_universe(
            self,
            ws_symbols,
            context="websocket core subscription universe",
        )
        self.assertEqual(
            _csv_symbols(cast(Mapping[str, object], ws_data).get("SYMBOLS_ALLOWLIST")),
            ws_symbols,
        )
        observation_symbols = _csv_symbols(
            cast(Mapping[str, object], universe_data).get("UNIVERSE_SYMBOLS")
        )
        self.assertEqual(observation_symbols, ["DBC", "EFA", "IEF", "SPY", "VNQ"])
        self.assertEqual(observation_symbols, sorted(observation_symbols))
        self.assertEqual(
            cast(Mapping[str, object], universe_data).get("UNIVERSE_ID"),
            "cross-asset-taa-v1",
        )
        self.assertEqual(
            cast(Mapping[str, object], universe_data).get("UNIVERSE_SYMBOL_HASH"),
            sha256(",".join(observation_symbols).encode()).hexdigest(),
        )

        expected_universe_refs = {
            "ALPACA_OBSERVATION_SYMBOLS": "UNIVERSE_SYMBOLS",
            "MARKET_DATA_UNIVERSE_ID": "UNIVERSE_ID",
            "MARKET_DATA_UNIVERSE_SYMBOL_HASH": "UNIVERSE_SYMBOL_HASH",
        }
        for env_name, key in expected_universe_refs.items():
            env_entry = cast(Mapping[str, object], env_by_name.get(env_name, {}))
            value_from = cast(Mapping[str, object], env_entry.get("valueFrom", {}))
            config_map_ref = cast(
                Mapping[str, object], value_from.get("configMapKeyRef", {})
            )
            self.assertEqual(
                config_map_ref,
                {"name": "bayn-universe-v2", "key": key},
                f"{env_name} must come from the authoritative Bayn universe ConfigMap",
            )

        self.assertNotIn("SYMBOLS", env_by_name)
        self.assertNotIn("SYMBOLS_ALLOWLIST", env_by_name)
        self.assertNotIn("JANGAR_SYMBOLS_URL", ws_data)
        self.assertEqual(
            cast(Mapping[str, object], ws_annotations).get(
                "argocd.argoproj.io/sync-options"
            ),
            "Replace=true",
        )

    def test_sim_manifest_contains_paper_live_signal_profile_for_safe_migration(
        self,
    ) -> None:
        sim_env = _load_knative_env(
            "argocd/applications/torghut/knative-service-sim.yaml"
        )
        live_env = _load_torghut_knative_env()

        self.assertFalse(
            _manifest_bool(sim_env, "TRADING_ENABLED"),
            "the old unfenced image must stop before the simulation role is promoted",
        )
        self.assertEqual(
            sim_env.get("SIM_DB_DSN"),
            sim_env.get("DB_DSN"),
            "sim evidence endpoints must expose SIM_DB_DSN because runtime-window import reads the sim paper-route evidence URL",
        )
        self.assertEqual(sim_env.get("TRADING_MODE"), "paper")
        self.assertEqual(sim_env.get("TRADING_PIPELINE_MODE"), "simple")
        self.assertNotIn("TRADING_ORDER_MAX_ATTEMPTS", sim_env)
        self.assertNotIn("TRADING_EXECUTION_MAX_RETRIES", sim_env)
        self.assertTrue(_manifest_bool(sim_env, "TRADING_SIMPLE_SUBMIT_ENABLED"))
        self.assertTrue(_manifest_bool(sim_env, "TRADING_ORDER_FEED_ENABLED"))
        self.assertTrue(
            _manifest_bool(sim_env, "TRADING_SIMPLE_ORDER_FEED_TELEMETRY_ENABLED"),
            "paper-route proof cannot materialize execution_order_events without simple order-feed telemetry",
        )
        self.assertEqual(
            sim_env.get("TRADING_ORDER_FEED_TOPIC"),
            "torghut.trade-updates.v1",
            "live-paper proof must consume the broker trade-update topic, not the simulation topic",
        )
        self.assertEqual(
            sim_env.get("TRADING_ORDER_FEED_ASSIGNMENT_MODE"),
            "manual",
            "sim proof ingestion must avoid unstable Kafka group rebalances and resume from DB offsets",
        )
        self.assertEqual(
            sim_env.get("TRADING_ORDER_FEED_AUTO_OFFSET_RESET"),
            "earliest",
            "first rollout must backfill existing broker order events for proof materialization",
        )
        self.assertEqual(
            sim_env.get("TRADING_ORDER_FEED_TOPIC_V2"),
            "",
            "v2 broker envelopes carry the producer account label and can prevent TORGHUT_SIM linkage",
        )
        self.assertNotIn("TRADING_SIMPLE_PAPER_ROUTE_PROBE_ENABLED", sim_env)
        self.assertNotIn("TRADING_SIMPLE_PAPER_ROUTE_PROBE_ALLOW_LIVE_MODE", sim_env)
        self.assertNotIn("TRADING_SIMPLE_PAPER_ROUTE_PROBE_MAX_NOTIONAL", sim_env)
        self.assertNotIn("TRADING_SIMPLE_MAX_NOTIONAL_PER_ORDER", sim_env)
        self.assertNotIn("TRADING_SIMPLE_MAX_NOTIONAL_PER_SYMBOL", sim_env)
        self.assertEqual(sim_env.get("TRADING_SIMPLE_MAX_ORDER_PCT_EQUITY"), "0.50")
        self.assertEqual(sim_env.get("TRADING_SIMPLE_MAX_SYMBOL_PCT_EQUITY"), "0.50")
        self.assertEqual(
            sim_env.get("TRADING_SIMPLE_MAX_GROSS_EXPOSURE_PCT_EQUITY"),
            "1.0",
        )
        self.assertFalse(_manifest_bool(sim_env, "WHITEPAPER_WORKFLOW_ENABLED"))
        self.assertFalse(_manifest_bool(sim_env, "WHITEPAPER_KAFKA_ENABLED"))
        self.assertFalse(_manifest_bool(sim_env, "WHITEPAPER_AGENTRUN_AUTO_DISPATCH"))
        self.assertFalse(
            _manifest_bool(sim_env, "WHITEPAPER_SEMANTIC_INDEXING_ENABLED")
        )
        self.assertNotIn("TRADING_PAPER_ROUTE_TARGET_PLAN_URL", sim_env)
        self.assertNotIn("TRADING_PAPER_ROUTE_TARGET_PLAN_TIMEOUT_SECONDS", sim_env)
        self.assertFalse(_manifest_bool(sim_env, "TRADING_SIMULATION_ENABLED"))
        self.assertEqual(sim_env.get("TRADING_UNIVERSE_SOURCE"), "static")
        self.assertEqual(
            sim_env.get("TRADING_UNIVERSE_REQUIRE_NON_EMPTY_JANGAR"), "false"
        )
        self.assertEqual(
            sim_env.get("TRADING_UNIVERSE_STATIC_FALLBACK_ENABLED"), "false"
        )
        self.assertEqual(
            sim_env.get("TRADING_STATIC_SYMBOLS"),
            ",".join(_QUOTE_COVERED_PAPER_STRATEGY_UNIVERSE),
        )
        self.assertEqual(sim_env.get("CLICKHOUSE_DATABASE"), "torghut")
        self.assertEqual(sim_env.get("TRADING_SIGNAL_TABLE"), "torghut.ta_signals")
        self.assertEqual(sim_env.get("TRADING_PRICE_TABLE"), "torghut.ta_microbars")
        self.assertEqual(
            sim_env.get("TRADING_EXECUTABLE_QUOTE_LOOKBACK_SECONDS"),
            "60",
        )
        self.assertEqual(
            sim_env.get("TRADING_EXECUTABLE_QUOTE_FORWARD_SECONDS"),
            "0",
        )
        self.assertEqual(
            sim_env.get("TRADING_ALPACA_QUOTE_FALLBACK_ENABLED"),
            "true",
        )
        self.assertEqual(
            sim_env.get("TRADING_ALPACA_QUOTE_FEED"),
            "iex",
        )
        self.assertEqual(
            sim_env.get("TRADING_ALPACA_QUOTE_MAX_AGE_SECONDS"),
            "20",
        )
        self.assertEqual(
            sim_env.get("TRADING_ALPACA_QUOTE_FALLBACK_MARKET_SESSION_REQUIRED"),
            "true",
        )
        self.assertEqual(
            sim_env.get("TRADING_ALPACA_QUOTE_FALLBACK_BACKOFF_SECONDS"),
            "60",
        )
        self.assertEqual(
            sim_env.get("TRADING_OPTIONS_CATALOG_FRESHNESS_CACHE_SECONDS"),
            "30",
        )
        self.assertEqual(
            _load_torghut_knative_env().get(
                "TRADING_EXECUTABLE_QUOTE_LOOKBACK_SECONDS"
            ),
            "60",
        )
        self.assertEqual(
            _load_torghut_knative_env().get("TRADING_EXECUTABLE_QUOTE_FORWARD_SECONDS"),
            "0",
        )
        self.assertEqual(
            _load_torghut_knative_env().get("TRADING_ALPACA_QUOTE_FALLBACK_ENABLED"),
            "true",
        )
        self.assertEqual(
            _load_torghut_knative_env().get("TRADING_ALPACA_QUOTE_FEED"),
            "iex",
        )
        self.assertEqual(
            _load_torghut_knative_env().get("TRADING_ALPACA_QUOTE_MAX_AGE_SECONDS"),
            "20",
        )
        self.assertEqual(
            _load_torghut_knative_env().get(
                "TRADING_ALPACA_QUOTE_FALLBACK_MARKET_SESSION_REQUIRED"
            ),
            "true",
        )
        self.assertEqual(
            _load_torghut_knative_env().get(
                "TRADING_ALPACA_QUOTE_FALLBACK_BACKOFF_SECONDS"
            ),
            "60",
        )
        self.assertEqual(
            _load_torghut_knative_env().get(
                "TRADING_OPTIONS_CATALOG_FRESHNESS_CACHE_SECONDS"
            ),
            "30",
        )
        self.assertEqual(
            sim_env.get("TRADING_UNIVERSE_STATIC_FALLBACK_SYMBOLS"),
            ",".join(_QUOTE_COVERED_PAPER_STRATEGY_UNIVERSE),
        )
        self.assertNotIn("JANGAR_SYMBOLS_URL", sim_env)
        self.assertNotIn("TRADING_JANGAR_CONTROL_PLANE_STATUS_URL", sim_env)
        self.assertNotIn("TRADING_JANGAR_CONTROL_PLANE_CACHE_TTL_SECONDS", sim_env)
        self.assertNotIn("TRADING_JANGAR_QUANT_HEALTH_URL", sim_env)
        self.assertNotIn("TRADING_MARKET_CONTEXT_URL", sim_env)
        self.assertEqual(
            sim_env.get("AGENTS_BASE_URL"), "http://agents.agents.svc.cluster.local"
        )
        self.assertNotIn("JANGAR_BASE_URL", sim_env)
        self.assertNotIn("JANGAR_API_KEY", sim_env)
        self.assertFalse(
            any(key.startswith("TRADING_MARKET_CONTEXT_") for key in sim_env),
            "paper live-signal service must not import external market-context wiring",
        )
        self.assertEqual(
            _csv_values(sim_env.get("TRADING_SIGNAL_STALENESS_ALERT_CRITICAL_REASONS")),
            {"cursor_ahead_of_stream", "universe_source_unavailable"},
        )
        self.assertNotIn(
            "no_signals_in_window",
            _csv_values(sim_env.get("TRADING_SIGNAL_STALENESS_ALERT_CRITICAL_REASONS")),
        )

        self.assertEqual(live_env.get("TRADING_MODE"), "live")
        self.assertTrue(_manifest_bool(live_env, "TRADING_SIMPLE_SUBMIT_ENABLED"))
        self.assertNotIn("TRADING_SIMPLE_PAPER_ROUTE_PROBE_ENABLED", live_env)
        self.assertNotIn("TRADING_SIMPLE_PAPER_ROUTE_PROBE_MAX_NOTIONAL", live_env)
        self.assertNotIn("TRADING_SIMPLE_MAX_NOTIONAL_PER_ORDER", live_env)
        self.assertNotIn("TRADING_SIMPLE_MAX_NOTIONAL_PER_SYMBOL", live_env)
        self.assertNotIn("TRADING_PAPER_ROUTE_TARGET_PLAN_URL", live_env)
        self.assertNotIn("TRADING_LIVE_SUBMIT_ACTIVATION_EXPIRES_AT", live_env)
        self.assertNotIn("TRADING_TESTNET_AFTER_HOURS_ENABLED", live_env)
        self.assertEqual(live_env.get("TRADING_SIMPLE_MAX_ORDER_PCT_EQUITY"), "0.50")
        self.assertEqual(live_env.get("TRADING_SIMPLE_MAX_SYMBOL_PCT_EQUITY"), "0.50")
        self.assertEqual(
            live_env.get("TRADING_SIMPLE_MAX_GROSS_EXPOSURE_PCT_EQUITY"),
            "1.0",
        )
        self.assertEqual(
            live_env.get("TRADING_SIMPLE_MAX_NET_EXPOSURE_PCT_EQUITY"),
            "0.50",
        )
        self.assertEqual(
            live_env.get("TRADING_SIMPLE_BUYING_POWER_RESERVE_BPS"), "1000"
        )
        self.assertEqual(live_env.get("TRADING_ALPACA_QUOTE_FEED"), "iex")
        self.assertTrue(_manifest_bool(live_env, "TRADING_EMERGENCY_STOP_ENABLED"))
        self.assertTrue(
            _manifest_bool(live_env, "TRADING_SIMPLE_ORDER_FEED_TELEMETRY_ENABLED"),
            "live execution requires lifecycle telemetry",
        )
        self.assertTrue(_manifest_bool(live_env, "TRADING_ORDER_FEED_ENABLED"))
        self.assertEqual(
            live_env.get("TRADING_ORDER_FEED_TOPIC"),
            "torghut.trade-updates.v2",
            "live telemetry should make account-labelled v2 envelopes the explicit primary topic",
        )
        self.assertNotIn("TRADING_ORDER_FEED_TOPIC_V2", live_env)
        self.assertEqual(
            live_env.get("TRADING_ORDER_FEED_GROUP_ID"),
            "torghut-order-feed-live-default",
        )
        self.assertEqual(live_env.get("TRADING_ORDER_FEED_ASSIGNMENT_MODE"), "manual")
        self.assertEqual(
            live_env.get("TRADING_ORDER_FEED_AUTO_OFFSET_RESET"), "earliest"
        )
        self.assertFalse(_manifest_bool(live_env, "WHITEPAPER_WORKFLOW_ENABLED"))
        self.assertFalse(_manifest_bool(live_env, "WHITEPAPER_KAFKA_ENABLED"))
        self.assertFalse(_manifest_bool(live_env, "WHITEPAPER_AGENTRUN_AUTO_DISPATCH"))
        self.assertFalse(
            _manifest_bool(live_env, "WHITEPAPER_SEMANTIC_INDEXING_ENABLED")
        )

    def test_autonomy_config_does_not_treat_normal_no_signal_as_critical(self) -> None:
        manifest = _load_yaml_mapping(
            "argocd/applications/torghut/autonomy-configmap.yaml"
        )
        data = manifest.get("data")
        self.assertIsInstance(data, Mapping)

        critical_reasons = _csv_values(
            cast(Mapping[str, object], data).get(
                "TRADING_SIGNAL_STALENESS_ALERT_CRITICAL_REASONS"
            )
        )
        self.assertEqual(
            critical_reasons,
            {"cursor_ahead_of_stream", "universe_source_unavailable"},
        )

    def test_clickhouse_replicas_are_not_pinned_to_single_architecture(self) -> None:
        manifest = _load_torghut_clickhouse_manifest()
        pod_templates = (
            manifest.get("spec", {}).get("templates", {}).get("podTemplates", [])
        )
        self.assertTrue(pod_templates)
        for template in pod_templates:
            self.assertIsInstance(template, Mapping)
            spec = cast(Mapping[str, object], template).get("spec")
            self.assertIsInstance(spec, Mapping)
            node_selector = cast(Mapping[str, object], spec).get("nodeSelector")
            self.assertNotEqual(
                node_selector,
                {"kubernetes.io/arch": "arm64"},
                f"{template.get('name')} pins ClickHouse to one architecture",
            )

    def test_torghut_declares_tigerbeetle_cluster(self) -> None:
        manifest = _load_yaml_mapping(
            "argocd/applications/torghut/tigerbeetle-cluster.yaml"
        )
        pyproject = tomllib.loads(
            (_repo_root() / "services/torghut/pyproject.toml").read_text()
        )
        client_pin = next(
            dependency.split("==", maxsplit=1)[1]
            for dependency in pyproject["project"]["dependencies"]
            if dependency.startswith("tigerbeetle==")
        )

        self.assertEqual(manifest["apiVersion"], "tigerbeetle.proompteng.ai/v1alpha1")
        self.assertEqual(manifest["kind"], "TigerBeetleCluster")
        self.assertEqual(
            manifest["metadata"],
            {
                "name": "torghut-tigerbeetle",
                "namespace": "torghut",
                "labels": {
                    "app.kubernetes.io/name": "torghut-tigerbeetle",
                    "app.kubernetes.io/part-of": "torghut",
                },
            },
        )
        spec = manifest["spec"]
        self.assertIsInstance(spec, Mapping)
        spec_mapping = cast(Mapping[str, object], spec)
        self.assertEqual(spec_mapping["clusterID"], "2001")
        self.assertEqual(spec_mapping["replicas"], 1)
        self.assertEqual(
            spec_mapping["image"],
            {
                "repository": "ghcr.io/tigerbeetle/tigerbeetle",
                "tag": client_pin,
                "pullPolicy": "IfNotPresent",
            },
        )
        self.assertEqual(client_pin, "0.17.9")
        self.assertEqual(
            spec_mapping["storage"], {"className": "rook-ceph-block", "size": "100Gi"}
        )
        self.assertEqual(spec_mapping["nodeSelector"], {"kubernetes.io/arch": "arm64"})
        self.assertEqual(spec_mapping["pdb"], {"enabled": True, "minAvailable": 1})
        self.assertEqual(spec_mapping["health"], {"checkIntervalSeconds": 5})

    def test_torghut_kustomization_includes_tigerbeetle_cluster(self) -> None:
        manifest = _load_yaml_mapping("argocd/applications/torghut/kustomization.yaml")
        resources = manifest.get("resources")

        self.assertIsInstance(resources, list)
        self.assertIn("tigerbeetle-cluster.yaml", resources)
        self.assertIn("tigerbeetle-smoke-job.yaml", resources)
        self.assertNotIn("tigerbeetle-journal-order-events-cronjob.yaml", resources)
        self.assertNotIn(
            "bounded-paper-route-target-materialization-cronjob.yaml", resources
        )
        self.assertNotIn(
            "whitepaper-autoresearch-replay-materialization-cronworkflow.yaml",
            resources,
        )

    def test_whitepaper_autoresearch_replay_materialization_cronworkflow_is_removed(
        self,
    ) -> None:
        self.assertFalse(
            (
                _repo_root() / "argocd/applications/torghut/"
                "whitepaper-autoresearch-replay-materialization-cronworkflow.yaml"
            ).exists()
        )

    def test_torghut_knative_manifests_enable_tigerbeetle_journal(self) -> None:
        common_expected = {
            "TORGHUT_TIGERBEETLE_ENABLED": "true",
            "TORGHUT_TIGERBEETLE_CLUSTER_ID": "2001",
            "TORGHUT_TIGERBEETLE_REPLICA_ADDRESSES": "torghut-tigerbeetle.torghut.svc.cluster.local:3000",
            "TORGHUT_TIGERBEETLE_HEALTH_TIMEOUT_SECONDS": "5",
            "TORGHUT_TIGERBEETLE_RPC_TIMEOUT_SECONDS": "10",
            "TORGHUT_TIGERBEETLE_JOURNAL_ENABLED": "true",
        }
        requirements = {
            "argocd/applications/torghut/knative-service.yaml": (
                "true",
                "false",
                "true",
            ),
            "argocd/applications/torghut/knative-service-sim.yaml": (
                "false",
                "false",
                "false",
            ),
        }
        for relative_path, (
            required,
            reconcile_required,
            economic_parity_required,
        ) in requirements.items():
            env = _load_knative_env(relative_path)
            for key, value in common_expected.items():
                self.assertEqual(env.get(key), value, f"{relative_path} {key}")
            self.assertEqual(env.get("TORGHUT_TIGERBEETLE_REQUIRED"), required)
            self.assertEqual(
                env.get("TORGHUT_TIGERBEETLE_RECONCILE_REQUIRED"),
                reconcile_required,
            )
            self.assertEqual(
                env.get("TORGHUT_TIGERBEETLE_ECONOMIC_PARITY_REQUIRED"),
                economic_parity_required,
            )

    def test_torghut_tigerbeetle_client_pods_allow_io_uring(self) -> None:
        for relative_path in (
            "argocd/applications/torghut/knative-service.yaml",
            "argocd/applications/torghut/knative-service-sim.yaml",
        ):
            container = _load_knative_container(relative_path)
            security_context = cast(
                Mapping[str, object],
                container.get("securityContext", {}),
            )
            seccomp_profile = cast(
                Mapping[str, object],
                security_context.get("seccompProfile", {}),
            )
            self.assertEqual(
                seccomp_profile.get("type"),
                "Unconfined",
                f"{relative_path} official TigerBeetle client requires io_uring",
            )

        _, smoke_container = _load_job_container(
            "argocd/applications/torghut/tigerbeetle-smoke-job.yaml"
        )
        smoke_security_context = cast(
            Mapping[str, object],
            smoke_container.get("securityContext", {}),
        )
        smoke_seccomp_profile = cast(
            Mapping[str, object],
            smoke_security_context.get("seccompProfile", {}),
        )
        self.assertEqual(smoke_seccomp_profile.get("type"), "Unconfined")

    def test_torghut_tigerbeetle_smoke_job_runs_protocol_proof(self) -> None:
        spec, container = _load_job_container(
            "argocd/applications/torghut/tigerbeetle-smoke-job.yaml"
        )
        env = _container_env(container)

        self.assertEqual(spec.get("backoffLimit"), 3)
        self.assertEqual(spec.get("activeDeadlineSeconds"), 300)
        self.assertRegex(
            container.get("image", ""),
            r"^registry\.ide-newton\.ts\.net/lab/torghut@sha256:[0-9a-f]{64}$",
        )
        self.assertEqual(
            container.get("command"),
            ["/bin/bash", "-lc"],
        )
        args = container.get("args")
        self.assertIsInstance(args, list)
        self.assertIn("scripts/verify_tigerbeetle_ledger.py --mode smoke", str(args[0]))
        self.assertEqual(env.get("TORGHUT_TIGERBEETLE_ENABLED"), "true")
        self.assertEqual(env.get("TORGHUT_TIGERBEETLE_REQUIRED"), "true")
        self.assertEqual(env.get("TORGHUT_TIGERBEETLE_CLUSTER_ID"), "2001")
        self.assertEqual(
            env.get("TORGHUT_TIGERBEETLE_REPLICA_ADDRESSES"),
            "torghut-tigerbeetle.torghut.svc.cluster.local:3000",
        )
        self.assertEqual(env.get("TORGHUT_TIGERBEETLE_RPC_TIMEOUT_SECONDS"), "30")

    def test_torghut_whitepaper_bootstrap_only_ensures_bucket(self) -> None:
        spec, container = _load_job_container(
            "argocd/applications/torghut/whitepapers-bucket-bootstrap-job.yaml"
        )
        args = container.get("command")
        rendered_command = "\n".join(str(item) for item in args or [])

        self.assertEqual(spec.get("backoffLimit"), 2)
        self.assertEqual(spec.get("activeDeadlineSeconds"), 120)
        self.assertEqual(spec.get("ttlSecondsAfterFinished"), 300)
        self.assertIn("mc stat", rendered_command)
        self.assertIn("mc mb", rendered_command)
        self.assertNotIn("mc pipe", rendered_command)
        self.assertNotIn(".keep", rendered_command)
