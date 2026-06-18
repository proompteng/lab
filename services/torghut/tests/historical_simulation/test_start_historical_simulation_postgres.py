from __future__ import annotations

from tests.historical_simulation.start_historical_simulation_base import (
    Any,
    Path,
    PostgresRuntimeConfig,
    StartHistoricalSimulationTestCaseBase,
    TemporaryDirectory,
    _merge_env_entries,
    _run_migrations,
    _torghut_env_overrides_from_manifest,
    datetime,
    patch,
    start_historical_simulation,
    timezone,
    uuid,
)


class TestStartHistoricalSimulationPostgres(StartHistoricalSimulationTestCaseBase):
    def test_run_migrations_uses_admin_simulation_dsn(self) -> None:
        config = PostgresRuntimeConfig(
            admin_dsn="postgresql://postgres:admin-secret@localhost:5432/postgres",
            simulation_dsn="postgresql://torghut:secret@localhost:5432/torghut_sim_sim_1",
            simulation_db="torghut_sim_sim_1",
            migrations_command="/opt/venv/bin/alembic upgrade heads",
        )
        captured_envs: list[str] = []
        captured_args: list[list[str]] = []

        def _fake_run_command(args, *, cwd=None, env=None, input_text=None) -> None:
            _ = (cwd, input_text)
            if env is None:
                raise AssertionError("expected DB_DSN env to be provided")
            captured_args.append(list(args))
            captured_envs.append(str(env["DB_DSN"]))
            return None

        def _fake_retry(
            *,
            label: str,
            operation: object,
            attempts: int = 8,
            sleep_seconds: float = 0.5,
        ) -> None:
            _ = (label, attempts, sleep_seconds)
            return operation()

        with (
            patch(
                "scripts.historical_simulation_startup.resource_planning._run_command",
                side_effect=_fake_run_command,
            ),
            patch(
                "scripts.historical_simulation_startup.kubernetes_argocd._run_with_transient_postgres_retry",
                side_effect=_fake_retry,
            ),
            patch(
                "scripts.historical_simulation_startup.resource_planning.shutil.which",
                return_value="/usr/bin/alembic",
            ),
            patch(
                "scripts.historical_simulation_startup.runtime_migrations._assert_required_simulation_metadata_tables",
                return_value=None,
            ),
        ):
            _run_migrations(config)

        self.assertEqual(
            captured_args,
            [["/usr/bin/alembic", "upgrade", "heads"]],
        )
        self.assertEqual(
            captured_envs,
            ["postgresql://postgres:admin-secret@localhost:5432/torghut_sim_sim_1"],
        )

    def test_ensure_postgres_runtime_permissions_sets_default_privileges_for_migrated_objects(
        self,
    ) -> None:
        config = PostgresRuntimeConfig(
            admin_dsn="postgresql://postgres:admin-secret@localhost:5432/postgres",
            simulation_dsn="postgresql://torghut_app:secret@localhost:5432/torghut_sim_sim_1",
            simulation_db="torghut_sim_sim_1",
            migrations_command="/opt/venv/bin/alembic upgrade heads",
        )
        admin_statements: list[object] = []
        simulation_statements: list[object] = []

        class _FakeCursor:
            def __init__(self, statements: list[object]) -> None:
                self._statements = statements

            def execute(self, statement: object, params: object | None = None) -> None:
                _ = params
                self._statements.append(statement)

            def __enter__(self) -> _FakeCursor:
                return self

            def __exit__(self, exc_type, exc, tb) -> bool:
                _ = (exc_type, exc, tb)
                return False

        class _FakeConnection:
            def __init__(self, statements: list[object]) -> None:
                self._statements = statements

            def cursor(self) -> _FakeCursor:
                return _FakeCursor(self._statements)

            def __enter__(self) -> _FakeConnection:
                return self

            def __exit__(self, exc_type, exc, tb) -> bool:
                _ = (exc_type, exc, tb)
                return False

        def _fake_connect(dsn: str, autocommit: bool = False) -> _FakeConnection:
            self.assertTrue(autocommit)
            if dsn == config.admin_dsn:
                return _FakeConnection(admin_statements)
            if dsn == config.admin_simulation_dsn:
                return _FakeConnection(simulation_statements)
            raise AssertionError(f"unexpected dsn: {dsn}")

        def _fake_retry(
            *,
            label: str,
            operation: object,
            attempts: int = 8,
            sleep_seconds: float = 0.5,
        ) -> Any:
            _ = (label, attempts, sleep_seconds)
            return operation()

        with (
            patch(
                "scripts.historical_simulation_startup.storage_and_database.psycopg.connect",
                side_effect=_fake_connect,
            ),
            patch(
                "scripts.historical_simulation_startup.kubernetes_argocd._run_with_transient_postgres_retry",
                side_effect=_fake_retry,
            ),
            patch(
                "scripts.historical_simulation_startup.storage_and_database._postgres_extension_exists",
                return_value=True,
            ),
        ):
            report = start_historical_simulation._ensure_postgres_runtime_permissions(
                config
            )

        rendered_admin = [repr(statement) for statement in admin_statements]
        rendered_simulation = [repr(statement) for statement in simulation_statements]

        self.assertEqual(report["simulation_role"], "torghut_app")
        self.assertTrue(report["grants_applied"])
        self.assertTrue(report["default_privileges_applied"])
        self.assertTrue(
            any(
                "GRANT ALL PRIVILEGES ON DATABASE " in statement
                and "Identifier('torghut_sim_sim_1')" in statement
                and "Identifier('torghut_app')" in statement
                for statement in rendered_admin
            ),
            rendered_admin,
        )
        self.assertTrue(
            any(
                "GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO " in statement
                for statement in rendered_simulation
            ),
            rendered_simulation,
        )
        self.assertTrue(
            any(
                "ALTER DEFAULT PRIVILEGES FOR ROLE " in statement
                and "GRANT ALL PRIVILEGES ON TABLES TO " in statement
                and "Identifier('postgres')" in statement
                and "Identifier('torghut_app')" in statement
                for statement in rendered_simulation
            ),
            rendered_simulation,
        )

    def test_assert_required_simulation_metadata_tables_raises_when_missing(
        self,
    ) -> None:
        config = PostgresRuntimeConfig(
            admin_dsn="postgresql://postgres:admin-secret@localhost:5432/postgres",
            simulation_dsn="postgresql://torghut:secret@localhost:5432/torghut_sim_sim_1",
            simulation_db="torghut_sim_sim_1",
            migrations_command="/opt/venv/bin/alembic upgrade heads",
        )

        class _FakeCursor:
            def __init__(self) -> None:
                self._table = ""

            def execute(self, statement: str, params: tuple[str, ...]) -> None:
                _ = statement
                self._table = params[0]

            def fetchone(self) -> tuple[str | None]:
                if self._table.endswith("vnext_completion_gate_results"):
                    return (None,)
                return (self._table.split(".", 1)[1],)

            def __enter__(self) -> _FakeCursor:
                return self

            def __exit__(self, exc_type, exc, tb) -> bool:
                return False

        class _FakeConnection:
            def cursor(self) -> _FakeCursor:
                return _FakeCursor()

            def __enter__(self) -> _FakeConnection:
                return self

            def __exit__(self, exc_type, exc, tb) -> bool:
                return False

        def _fake_retry(
            *,
            label: str,
            operation: object,
            attempts: int = 8,
            sleep_seconds: float = 0.5,
        ) -> None:
            _ = (label, attempts, sleep_seconds)
            return operation()

        with (
            patch(
                "scripts.historical_simulation_startup.storage_and_database.psycopg.connect",
                return_value=_FakeConnection(),
            ),
            patch(
                "scripts.historical_simulation_startup.kubernetes_argocd._run_with_transient_postgres_retry",
                side_effect=_fake_retry,
            ),
        ):
            with self.assertRaisesRegex(
                RuntimeError,
                "required_simulation_metadata_tables_missing:vnext_completion_gate_results",
            ):
                start_historical_simulation._assert_required_simulation_metadata_tables(
                    config
                )

    def test_remove_appledouble_sidecars_deletes_only_sidecar_python_files(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            versions_dir = Path(tmpdir)
            sidecar = versions_dir / "._0021_strategy_hypothesis_governance.py"
            migration = versions_dir / "0021_strategy_hypothesis_governance.py"
            sidecar.write_bytes(b"\x00" * 8)
            migration.write_text("# real migration\n")

            start_historical_simulation._remove_appledouble_sidecars(versions_dir)

            self.assertFalse(sidecar.exists())
            self.assertTrue(migration.exists())

    def test_reset_postgres_runtime_state_truncates_runtime_tables(self) -> None:
        config = PostgresRuntimeConfig(
            admin_dsn="postgresql://torghut:secret@localhost:5432/postgres",
            simulation_dsn="postgresql://torghut:secret@localhost:5432/torghut_sim_sim_1",
            simulation_db="torghut_sim_sim_1",
            migrations_command="/opt/venv/bin/alembic upgrade heads",
        )
        statements: list[object] = []

        class _FakeCursor:
            def __init__(self) -> None:
                self._results: list[tuple[str | None]] = []

            def __enter__(self) -> _FakeCursor:
                return self

            def __exit__(self, exc_type, exc, tb) -> bool:
                _ = (exc_type, exc, tb)
                return False

            def execute(self, statement: object, params: object | None = None) -> None:
                statements.append((statement, params))
                if statement == "SELECT to_regclass(%s)":
                    table_name = str((params or ("",))[0])
                    self._results.append((table_name,))

            def fetchone(self) -> tuple[str | None]:
                return self._results.pop(0)

        class _FakeConnection:
            def __enter__(self) -> _FakeConnection:
                return self

            def __exit__(self, exc_type, exc, tb) -> bool:
                _ = (exc_type, exc, tb)
                return False

            def cursor(self) -> _FakeCursor:
                return _FakeCursor()

        def _fake_retry(
            *,
            label: str,
            operation: object,
            attempts: int = 8,
            sleep_seconds: float = 0.5,
        ) -> None:
            _ = (label, attempts, sleep_seconds)
            return operation()

        with (
            patch(
                "scripts.historical_simulation_startup.storage_and_database.psycopg.connect",
                return_value=_FakeConnection(),
            ),
            patch(
                "scripts.historical_simulation_startup.kubernetes_argocd._run_with_transient_postgres_retry",
                side_effect=_fake_retry,
            ),
        ):
            start_historical_simulation._reset_postgres_runtime_state(config)

        rendered = [(str(statement), params) for statement, params in statements]
        self.assertIn("UPDATE simulation_run_progress", rendered[0][0])
        self.assertEqual(
            rendered[1:],
            [
                ("SELECT to_regclass(%s)", ("trade_cursor",)),
                (
                    "Composed([SQL('TRUNCATE TABLE '), Identifier('trade_cursor'), SQL(' RESTART IDENTITY CASCADE')])",
                    None,
                ),
                ("SELECT to_regclass(%s)", ("trade_decisions",)),
                (
                    "Composed([SQL('TRUNCATE TABLE '), Identifier('trade_decisions'), SQL(' RESTART IDENTITY CASCADE')])",
                    None,
                ),
                ("SELECT to_regclass(%s)", ("executions",)),
                (
                    "Composed([SQL('TRUNCATE TABLE '), Identifier('executions'), SQL(' RESTART IDENTITY CASCADE')])",
                    None,
                ),
                ("SELECT to_regclass(%s)", ("execution_tca_metrics",)),
                (
                    "Composed([SQL('TRUNCATE TABLE '), Identifier('execution_tca_metrics'), SQL(' RESTART IDENTITY CASCADE')])",
                    None,
                ),
                ("SELECT to_regclass(%s)", ("execution_order_events",)),
                (
                    "Composed([SQL('TRUNCATE TABLE '), Identifier('execution_order_events'), SQL(' RESTART IDENTITY CASCADE')])",
                    None,
                ),
            ],
        )

    def test_seed_simulation_trade_cursor_includes_primary_key(self) -> None:
        config = PostgresRuntimeConfig(
            admin_dsn="postgresql://torghut:secret@localhost:5432/postgres",
            simulation_dsn="postgresql://torghut:secret@localhost:5432/torghut_sim_default",
            simulation_db="torghut_sim_default",
            migrations_command="/opt/venv/bin/alembic upgrade heads",
        )
        manifest = {
            "window": {
                "start": "2026-03-11T13:30:00Z",
                "end": "2026-03-11T13:45:00Z",
            }
        }
        statements: list[tuple[object, object | None]] = []

        class _FakeCursor:
            def __enter__(self) -> _FakeCursor:
                return self

            def __exit__(self, exc_type, exc, tb) -> bool:
                _ = (exc_type, exc, tb)
                return False

            def execute(self, statement: object, params: object | None = None) -> None:
                statements.append((statement, params))

        class _FakeConnection:
            def __enter__(self) -> _FakeConnection:
                return self

            def __exit__(self, exc_type, exc, tb) -> bool:
                _ = (exc_type, exc, tb)
                return False

            def cursor(self) -> _FakeCursor:
                return _FakeCursor()

        def _fake_retry(
            *,
            label: str,
            operation: object,
            attempts: int = 8,
            sleep_seconds: float = 0.5,
        ) -> None:
            _ = (label, attempts, sleep_seconds)
            return operation()

        with (
            patch(
                "scripts.historical_simulation_startup.storage_and_database.psycopg.connect",
                return_value=_FakeConnection(),
            ),
            patch(
                "scripts.historical_simulation_startup.kubernetes_argocd._run_with_transient_postgres_retry",
                side_effect=_fake_retry,
            ),
        ):
            seeded_at = start_historical_simulation._seed_simulation_trade_cursor(
                config=config,
                manifest=manifest,
                account_label="TORGHUT_SIM",
            )

        self.assertEqual(seeded_at, datetime(2026, 3, 11, 13, 30, tzinfo=timezone.utc))
        rendered = [(str(statement), params) for statement, params in statements]
        self.assertEqual(len(rendered), 1)
        statement, params = rendered[0]
        self.assertIn("INSERT INTO trade_cursor", statement)
        self.assertIsInstance(params, dict)
        assert isinstance(params, dict)
        self.assertIsInstance(params["id"], uuid.UUID)
        self.assertEqual(params["account_label"], "TORGHUT_SIM")
        self.assertEqual(
            params["cursor_at"], datetime(2026, 3, 11, 13, 30, tzinfo=timezone.utc)
        )

    def test_merge_env_entries_updates_and_removes(self) -> None:
        current = [
            {"name": "A", "value": "1"},
            {"name": "B", "value": "2"},
            {
                "name": "C",
                "valueFrom": {
                    "secretKeyRef": {
                        "name": "secret",
                        "key": "token",
                    }
                },
            },
        ]
        merged = _merge_env_entries(
            current,
            {
                "A": "10",
                "B": None,
                "C": {
                    "valueFrom": {
                        "secretKeyRef": {
                            "name": "new-secret",
                            "key": "token",
                        }
                    }
                },
                "D": "4",
            },
        )
        by_name = {item["name"]: item for item in merged}
        self.assertEqual(by_name["A"]["value"], "10")
        self.assertNotIn("B", by_name)
        self.assertEqual(
            by_name["C"]["valueFrom"]["secretKeyRef"]["name"], "new-secret"
        )
        self.assertEqual(by_name["D"]["value"], "4")

    def test_torghut_env_overrides_accept_allowlisted_keys(self) -> None:
        overrides = _torghut_env_overrides_from_manifest(
            {
                "torghut_env_overrides": {
                    "TRADING_FEATURE_MAX_STALENESS_MS": 43200000,
                    "TRADING_FEATURE_QUALITY_ENABLED": "true",
                    "TRADING_SIGNAL_ALLOWED_SOURCES": "rest,ws,ta",
                    "TRADING_SIMULATION_FETCH_WINDOW_SECONDS": 20,
                }
            }
        )
        self.assertEqual(
            overrides,
            {
                "TRADING_FEATURE_MAX_STALENESS_MS": "43200000",
                "TRADING_FEATURE_QUALITY_ENABLED": "true",
                "TRADING_SIGNAL_ALLOWED_SOURCES": "rest,ws,ta",
                "TRADING_SIMULATION_FETCH_WINDOW_SECONDS": "20",
            },
        )

    def test_torghut_env_overrides_reject_disallowed_keys(self) -> None:
        with self.assertRaisesRegex(
            RuntimeError, "disallowed_torghut_env_override:TRADING_MODE"
        ):
            _torghut_env_overrides_from_manifest(
                {
                    "torghut_env_overrides": {
                        "TRADING_MODE": "paper",
                    }
                }
            )

    def test_torghut_env_overrides_auto_derives_staleness_for_historical_window(
        self,
    ) -> None:
        overrides = _torghut_env_overrides_from_manifest(
            {
                "window": {
                    "start": "2026-02-27T20:52:32Z",
                }
            },
            now=datetime(2026, 2, 28, 1, 9, 22, tzinfo=timezone.utc),
        )
        self.assertEqual(
            overrides,
            {
                "TRADING_FEATURE_MAX_STALENESS_MS": "15710000",
            },
        )

    def test_torghut_env_overrides_prefers_explicit_staleness(self) -> None:
        overrides = _torghut_env_overrides_from_manifest(
            {
                "window": {
                    "start": "2026-02-27T20:52:32Z",
                },
                "torghut_env_overrides": {
                    "TRADING_FEATURE_MAX_STALENESS_MS": "43200000",
                },
            },
            now=datetime(2026, 2, 28, 1, 9, 22, tzinfo=timezone.utc),
        )
        self.assertEqual(
            overrides,
            {
                "TRADING_FEATURE_MAX_STALENESS_MS": "43200000",
            },
        )
