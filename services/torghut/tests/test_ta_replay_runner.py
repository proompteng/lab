import argparse
import io
import json
import os
import sys
from contextlib import redirect_stdout
from subprocess import CompletedProcess
from unittest import TestCase
from unittest.mock import patch
from urllib.error import URLError

from scripts import ta_replay_runner as runner


_TABLE_COVERAGE_TSV = """table_name\tdays\tfirst_day\tlast_day\trows
ta_microbars\t19\t2026-04-27\t2026-05-22\t1281193
ta_signals\t9\t2026-05-12\t2026-05-22\t632380
"""

_DAY_GAP_TSV = """trading_day\tsignal_rows\tmicrobar_rows
2026-05-22\t58446\t58446
2026-05-08\t0\t68396
2026-05-07\t0\t66008
"""

_KAFKA_TOPICS_JSON = {
    "apiVersion": "v1",
    "kind": "List",
    "items": [
        {
            "metadata": {"name": "torghut.trades.v1"},
            "spec": {
                "partitions": 3,
                "replicas": 3,
                "config": {"retention.ms": 604800000},
            },
            "status": {"conditions": [{"type": "Ready", "status": "True"}]},
        },
        {
            "metadata": {"name": "torghut.quotes.v1"},
            "spec": {
                "partitions": 3,
                "replicas": 3,
                "config": {"retention.ms": "604800000"},
            },
            "status": {"conditions": [{"type": "Ready", "status": "True"}]},
        },
        {
            "metadata": {"name": "torghut.bars.1m.v1"},
            "spec": {
                "partitions": 3,
                "replicas": 3,
                "config": {"retention.ms": 2592000000},
            },
            "status": {"conditions": [{"type": "Ready", "status": "True"}]},
        },
        {
            "metadata": {"name": "torghut.ta.bars.1s.v1"},
            "spec": {
                "partitions": 1,
                "replicas": 3,
                "config": {"retention.ms": 1209600000},
            },
            "status": {"conditions": [{"type": "Ready", "status": "True"}]},
        },
        {
            "metadata": {"name": "torghut.ta.signals.v1"},
            "spec": {
                "partitions": 1,
                "replicas": 3,
                "config": {"retention.ms": 1209600000},
            },
            "status": {"conditions": [{"type": "Ready", "status": "True"}]},
        },
    ],
}


class TestTaReplayRunnerCoveragePreflight(TestCase):
    def _args(self, **overrides: object) -> argparse.Namespace:
        values = {
            "namespace": "torghut",
            "verify": False,
            "json": True,
            "check_clickhouse_coverage": True,
            "check_kafka_retention": False,
            "clickhouse_http_url": "http://clickhouse.test:8123",
            "clickhouse_username": "torghut",
            "clickhouse_password": "secret",
            "clickhouse_password_env": "TA_CLICKHOUSE_PASSWORD",
            "clickhouse_timeout_seconds": 5,
            "coverage_day_limit": 40,
            "required_trading_days": 25,
            "required_calendar_days": 0,
            "kafka_topic_namespace": "kafka",
            "kafka_retention_topic": [],
        }
        values.update(overrides)
        return argparse.Namespace(**values)

    def _state(self) -> runner.ReplayState:
        return runner.ReplayState(
            namespace="torghut",
            ta_group_id="torghut-ta-2025-12-23",
            ta_auto_offset_reset="latest",
            flink_job_state="running",
            flink_restart_nonce=7,
            flink_status_state="RUNNING",
        )

    def _plan(self) -> dict[str, str]:
        return {
            "replay_group_id": "torghut-ta-replay-profit-proof",
            "ta_auto_offset_reset": "earliest",
        }

    def _coverage(self) -> dict[str, object]:
        return argparse.Namespace(
            status="insufficient_ta_signal_days",
            summary={
                "required_trading_days": 25,
                "ta_signals_days": 9,
                "ta_microbars_days": 19,
                "missing_signal_days_vs_required": 16,
                "microbar_only_day_count": 2,
            },
        ).__dict__

    def _complete_coverage(self) -> dict[str, object]:
        return {
            "schema_version": "torghut.ta-replay-coverage-preflight.v1",
            "status": "ok",
            "blockers": [],
            "summary": {
                "required_trading_days": 25,
                "ta_signals_days": 25,
                "ta_microbars_days": 25,
                "missing_signal_days_vs_required": 0,
                "microbar_only_day_count": 0,
            },
            "tables": [],
            "day_gaps": [],
        }

    def _kafka_retention(self) -> dict[str, object]:
        return {
            "schema_version": "torghut.kafka-retention-preflight.v1",
            "status": "insufficient_source_retention",
            "blockers": [
                "retention_shortfall:trades:7<35",
                "retention_shortfall:quotes:7<35",
            ],
            "summary": {
                "required_trading_days": 25,
                "required_calendar_days": 35,
            },
            "topics": [
                {
                    "role": "trades",
                    "topic": "torghut.trades.v1",
                    "retention_days": 7.0,
                },
                {
                    "role": "quotes",
                    "topic": "torghut.quotes.v1",
                    "retention_days": 7.0,
                },
            ],
        }

    def _passing_kafka_retention(
        self, *, required_calendar_days: int = 7
    ) -> dict[str, object]:
        topics = []
        for role, topic_name in runner.DEFAULT_KAFKA_RETENTION_TOPICS.items():
            topics.append(
                {
                    "role": role,
                    "topic": topic_name,
                    "retention_days": 30.0,
                    "ready": "True",
                }
            )
        return {
            "schema_version": "torghut.kafka-retention-preflight.v1",
            "status": "ok",
            "blockers": [],
            "summary": {
                "required_trading_days": 5,
                "required_calendar_days": required_calendar_days,
            },
            "topics": topics,
        }

    def test_load_clickhouse_coverage_flags_signal_shortfall_and_microbar_only_days(
        self,
    ) -> None:
        with patch.object(
            runner,
            "_clickhouse_query",
            side_effect=[_TABLE_COVERAGE_TSV, _DAY_GAP_TSV],
        ):
            coverage = runner._load_clickhouse_coverage(self._args())

        assert coverage is not None
        self.assertEqual(coverage["status"], "insufficient_ta_signal_days")
        self.assertIn("insufficient_ta_signal_days:9<25", coverage["blockers"])
        self.assertIn("microbar_only_days:2", coverage["blockers"])
        self.assertEqual(coverage["summary"]["ta_signals_days"], 9)
        self.assertEqual(coverage["summary"]["ta_microbars_days"], 19)
        self.assertEqual(coverage["summary"]["missing_signal_days_vs_required"], 16)
        self.assertEqual(
            coverage["summary"]["microbar_only_days"],
            ["2026-05-08", "2026-05-07"],
        )

    def test_load_kafka_retention_flags_source_shortfall_for_proof_window(
        self,
    ) -> None:
        with patch.object(
            runner,
            "_kubectl_get_kafka_topics_json",
            return_value=_KAFKA_TOPICS_JSON,
        ):
            retention = runner._load_kafka_retention(
                self._args(
                    check_clickhouse_coverage=False,
                    check_kafka_retention=True,
                )
            )

        assert retention is not None
        self.assertEqual(retention["status"], "insufficient_source_retention")
        self.assertEqual(retention["summary"]["required_calendar_days"], 35)
        self.assertIn("retention_shortfall:trades:7<35", retention["blockers"])
        self.assertIn("retention_shortfall:quotes:7<35", retention["blockers"])
        self.assertIn("retention_shortfall:bars1m:30<35", retention["blockers"])
        self.assertIn("retention_shortfall:ta_signals:14<35", retention["blockers"])
        trades = next(
            topic for topic in retention["topics"] if topic["role"] == "trades"
        )
        self.assertEqual(trades["retention_days"], 7.0)

    def test_load_kafka_retention_handles_missing_not_ready_and_overrides(
        self,
    ) -> None:
        payload = {
            "items": [
                {
                    "metadata": {"name": "custom.trades"},
                    "spec": {"config": {"retention.ms": "bad"}},
                    "status": {"conditions": [{"type": "Ready", "status": "False"}]},
                }
            ]
        }
        with patch.object(
            runner,
            "_kubectl_get_kafka_topics_json",
            return_value=payload,
        ):
            retention = runner._load_kafka_retention(
                self._args(
                    check_clickhouse_coverage=False,
                    check_kafka_retention=True,
                    kafka_retention_topic=["trades=custom.trades"],
                    required_calendar_days=7,
                )
            )

        assert retention is not None
        self.assertEqual(retention["status"], "insufficient_source_retention")
        self.assertIn(
            "kafka_topic_not_ready:trades:custom.trades:False", retention["blockers"]
        )
        self.assertIn("retention_missing:trades:custom.trades", retention["blockers"])
        self.assertIn(
            "kafka_topic_missing:quotes:torghut.quotes.v1", retention["blockers"]
        )

        self.assertEqual(runner._required_calendar_days_from_trading_days(25), 35)
        self.assertEqual(
            runner._parse_kafka_retention_topic_overrides(["trades=custom.trades"])[
                "trades"
            ],
            "custom.trades",
        )
        with self.assertRaisesRegex(SystemExit, "role=topic"):
            runner._parse_kafka_retention_topic_overrides(["bad"])
        with self.assertRaisesRegex(SystemExit, "unknown kafka retention topic role"):
            runner._parse_kafka_retention_topic_overrides(["bad=topic"])
        with self.assertRaisesRegex(SystemExit, "cannot be empty"):
            runner._parse_kafka_retention_topic_overrides(["trades="])

    def test_kafka_retention_helpers_cover_kubectl_and_json_edges(self) -> None:
        with patch.object(
            runner,
            "_run_kubectl",
            return_value=CompletedProcess(
                args=[], returncode=0, stdout='{"items": []}'
            ),
        ) as run_kubectl:
            payload = runner._kubectl_get_kafka_topics_json("kafka", ["topic-a"])

        self.assertEqual(payload, {"items": []})
        self.assertEqual(
            run_kubectl.call_args.args[0],
            [
                "-n",
                "kafka",
                "get",
                "kafkatopic",
                "topic-a",
                "-o",
                "json",
                "--ignore-not-found=true",
            ],
        )
        self.assertEqual(
            runner._kafka_topic_items_by_name(
                {"metadata": {"name": "single-topic"}, "spec": {}}
            ),
            {"single-topic": {"metadata": {"name": "single-topic"}, "spec": {}}},
        )
        self.assertEqual(runner._kafka_topic_items_by_name({"items": [None, {}]}), {})
        self.assertEqual(runner._kafka_topic_ready_status({}), "unknown")
        self.assertEqual(
            runner._kafka_topic_ready_status({"status": {"conditions": "bad"}}),
            "unknown",
        )
        self.assertEqual(runner._kafka_topic_config({}), {})
        self.assertTrue(
            runner._topic_role_has_blocker(
                "kafka_topic_not_ready:trades:topic:False", "trades"
            )
        )
        self.assertFalse(
            runner._topic_role_has_blocker(
                "kafka_topic_not_ready:quotes:topic:False", "trades"
            )
        )

    def test_load_kafka_retention_can_pass_when_required_window_is_available(
        self,
    ) -> None:
        with patch.object(
            runner,
            "_kubectl_get_kafka_topics_json",
            return_value=_KAFKA_TOPICS_JSON,
        ):
            retention = runner._load_kafka_retention(
                self._args(
                    check_clickhouse_coverage=False,
                    check_kafka_retention=True,
                    required_trading_days=1,
                    required_calendar_days=1,
                )
            )

        assert retention is not None
        self.assertEqual(retention["status"], "ok")
        self.assertEqual(retention["blockers"], [])

    def test_plan_json_embeds_coverage_preflight(self) -> None:
        output = io.StringIO()
        with patch.object(
            runner,
            "_clickhouse_query",
            side_effect=[_TABLE_COVERAGE_TSV, _DAY_GAP_TSV],
        ):
            with redirect_stdout(output):
                exit_code = runner._handle_plan_mode(
                    args=self._args(),
                    state=self._state(),
                    plan=self._plan(),
                    warnings=[],
                )

        self.assertEqual(exit_code, 0)
        payload = json.loads(output.getvalue())
        self.assertEqual(
            payload["coverage"]["schema_version"],
            "torghut.ta-replay-coverage-preflight.v1",
        )
        self.assertEqual(
            payload["coverage"]["summary"]["missing_signal_days_vs_required"], 16
        )

    def test_plan_json_embeds_kafka_retention_preflight(self) -> None:
        output = io.StringIO()
        with patch.object(
            runner,
            "_kubectl_get_kafka_topics_json",
            return_value=_KAFKA_TOPICS_JSON,
        ):
            with redirect_stdout(output):
                exit_code = runner._handle_plan_mode(
                    args=self._args(
                        check_clickhouse_coverage=False,
                        check_kafka_retention=True,
                    ),
                    state=self._state(),
                    plan=self._plan(),
                    warnings=[],
                )

        self.assertEqual(exit_code, 0)
        payload = json.loads(output.getvalue())
        self.assertEqual(
            payload["kafka_retention"]["schema_version"],
            "torghut.kafka-retention-preflight.v1",
        )
        self.assertEqual(
            payload["kafka_retention"]["status"], "insufficient_source_retention"
        )
        self.assertEqual(
            payload["replay_feasibility"]["status"],
            "blocked_source_retention_or_missing_preflight",
        )
        self.assertFalse(
            payload["replay_feasibility"]["non_destructive_replay_admission"]
        )
        self.assertIn(
            "do_not_start_ta_replay_until_preflight_passes",
            payload["replay_feasibility"]["required_actions"],
        )

    def test_replay_feasibility_allows_current_exact_capture_when_window_complete(
        self,
    ) -> None:
        feasibility = runner._build_replay_feasibility(
            coverage=self._complete_coverage(),
            kafka_retention=self._kafka_retention(),
            required_trading_days=25,
            required_calendar_days=35,
        )

        assert feasibility is not None
        self.assertEqual(feasibility["status"], "current_clickhouse_window_complete")
        self.assertTrue(feasibility["ok"])
        self.assertTrue(feasibility["exact_replay_capture_ready"])
        self.assertFalse(feasibility["non_destructive_replay_admission"])
        self.assertIn(
            "capture_exact_replay_runtime_ledger_artifacts",
            feasibility["required_actions"],
        )

    def test_replay_feasibility_allows_replay_when_sources_and_ttl_pass(self) -> None:
        feasibility = runner._build_replay_feasibility(
            coverage=self._coverage(),
            kafka_retention=self._passing_kafka_retention(required_calendar_days=7),
            required_trading_days=5,
            required_calendar_days=7,
        )

        assert feasibility is not None
        self.assertEqual(feasibility["status"], "source_replay_feasible")
        self.assertTrue(feasibility["ok"])
        self.assertFalse(feasibility["exact_replay_capture_ready"])
        self.assertTrue(feasibility["non_destructive_replay_admission"])
        self.assertIn(
            "run_non_destructive_ta_replay_in_bounded_window",
            feasibility["required_actions"],
        )

    def test_replay_feasibility_blocks_replay_when_clickhouse_ttl_is_short(
        self,
    ) -> None:
        feasibility = runner._build_replay_feasibility(
            coverage=self._coverage(),
            kafka_retention=self._passing_kafka_retention(required_calendar_days=35),
            required_trading_days=25,
            required_calendar_days=35,
        )

        assert feasibility is not None
        self.assertEqual(
            feasibility["status"],
            "source_replay_possible_but_clickhouse_ttl_blocks_durable_window",
        )
        self.assertFalse(feasibility["ok"])
        self.assertFalse(feasibility["non_destructive_replay_admission"])
        self.assertIn(
            "clickhouse_ttl_shortfall:ta_signals:14<35",
            feasibility["blockers"],
        )
        self.assertIn(
            "avoid_using_clickhouse_ttl_window_as_durable_proof",
            feasibility["required_actions"],
        )

    def test_text_plan_renders_coverage_preflight_summary(self) -> None:
        output = io.StringIO()
        with redirect_stdout(output):
            runner._print_plan_text(
                self._state(),
                self._plan(),
                "torghut",
                dry_run=True,
                warnings=["TA_AUTO_OFFSET_RESET already matches the replay target"],
                coverage=self._coverage(),
            )

        text = output.getvalue()
        self.assertIn("Coverage preflight:", text)
        self.assertIn("missing-signal-days-vs-required: 16", text)
        self.assertIn("Use --mode=apply --confirm REPLAY_TA_CANARY", text)

    def test_text_plan_renders_kafka_retention_preflight_summary(self) -> None:
        output = io.StringIO()
        with redirect_stdout(output):
            runner._print_plan_text(
                self._state(),
                self._plan(),
                "torghut",
                dry_run=True,
                warnings=[],
                kafka_retention=self._kafka_retention(),
                replay_feasibility={
                    "status": "blocked_source_retention_or_missing_preflight",
                    "exact_replay_capture_ready": False,
                    "non_destructive_replay_admission": False,
                    "current_window_complete": False,
                    "source_replay_possible": False,
                    "clickhouse_ttl_sufficient": False,
                    "required_actions": [
                        "do_not_start_ta_replay_until_preflight_passes"
                    ],
                },
            )

        text = output.getvalue()
        self.assertIn("Kafka retention preflight:", text)
        self.assertIn("required-calendar-days: 35", text)
        self.assertIn("trades: 7.0d (torghut.trades.v1)", text)
        self.assertIn("retention_shortfall:trades:7<35", text)
        self.assertIn("Replay feasibility:", text)
        self.assertIn("non-destructive-replay-admission: False", text)
        self.assertIn("do_not_start_ta_replay_until_preflight_passes", text)

    def test_replay_state_and_plan_helpers_cover_edge_branches(self) -> None:
        with patch.object(runner.shutil, "which", return_value=None):
            with self.assertRaisesRegex(SystemExit, "kubectl not found"):
                runner._require_kubectl()
            with self.assertRaisesRegex(SystemExit, "kubectl not found"):
                runner._kubectl_binary()

        with patch.object(runner.shutil, "which", return_value="/usr/bin/kubectl"):
            runner._require_kubectl()
            self.assertEqual(runner._kubectl_binary(), "/usr/bin/kubectl")

        with self.assertRaisesRegex(SystemExit, "unsupported namespace"):
            runner._require_supported_namespace("agents")
        with self.assertRaisesRegex(SystemExit, "replay-id must be provided"):
            runner._plan_command("", "prefix", "earliest")
        with self.assertRaisesRegex(SystemExit, "replay-id cannot be empty"):
            runner._validate_plan_args("", "prefix")
        with self.assertRaisesRegex(SystemExit, "group-prefix cannot be empty"):
            runner._validate_plan_args("proof", "")

        self.assertEqual(
            runner._plan_command(" proof__id ", " prefix__ ", ""),
            {
                "replay_group_id": "prefix-proof-id",
                "ta_auto_offset_reset": "earliest",
            },
        )
        replay_state = runner.ReplayState(
            namespace="torghut",
            ta_group_id="torghut-ta-replay-profit-proof",
            ta_auto_offset_reset="earliest",
            flink_job_state=None,
            flink_restart_nonce=7,
            flink_status_state=None,
        )
        self.assertEqual(
            runner._validate_apply_preconditions(
                state=replay_state,
                plan=self._plan(),
                allow_existing_group=False,
            ),
            [
                "planned TA_GROUP_ID already equals current value; pass --allow-existing-group-id to continue",
                "TA_AUTO_OFFSET_RESET already matches the replay target",
            ],
        )

    def test_load_state_parses_kubernetes_payloads_and_error_shapes(self) -> None:
        config = {
            "data": {
                "TA_GROUP_ID": "torghut-ta-2025-12-23",
                "TA_AUTO_OFFSET_RESET": "latest",
            }
        }
        deployment = {
            "spec": {
                "job": {"state": "running"},
                "restartNonce": "8",
            },
            "status": {"jobStatus": {"state": "RUNNING"}},
        }
        with patch.object(runner, "_kubectl_get_ta_config_json", return_value=config):
            with patch.object(
                runner, "_kubectl_get_ta_deployment_json", return_value=deployment
            ):
                state = runner._load_state("torghut")

        self.assertEqual(state.ta_group_id, "torghut-ta-2025-12-23")
        self.assertEqual(state.ta_auto_offset_reset, "latest")
        self.assertEqual(state.flink_job_state, "running")
        self.assertEqual(state.flink_restart_nonce, 8)
        self.assertEqual(state.flink_status_state, "RUNNING")

        with patch.object(runner, "_kubectl_get_ta_config_json", return_value={}):
            with self.assertRaisesRegex(SystemExit, "configmap data"):
                runner._load_state("torghut")
        with patch.object(
            runner, "_kubectl_get_ta_config_json", return_value={"data": {}}
        ):
            with self.assertRaisesRegex(SystemExit, "TA_GROUP_ID missing"):
                runner._load_state("torghut")
        with patch.object(runner, "_kubectl_get_ta_config_json", return_value=config):
            with patch.object(
                runner, "_kubectl_get_ta_deployment_json", return_value={}
            ):
                with self.assertRaisesRegex(SystemExit, "flinkdeployment spec"):
                    runner._load_state("torghut")

    def test_main_dispatches_modes_and_requires_apply_confirmation(self) -> None:
        base_args = self._args(
            replay_id="proof",
            group_prefix="torghut-ta-replay",
            auto_offset_reset="earliest",
            allow_existing_group_id=False,
            mode="plan",
            confirm="",
        )
        with patch.object(runner, "parse_args", return_value=base_args):
            with patch.object(runner, "_require_kubectl"):
                with patch.object(runner, "_load_state", return_value=self._state()):
                    with patch.object(
                        runner, "_handle_plan_mode", return_value=4
                    ) as handle_plan:
                        self.assertEqual(runner.main(), 4)
        handle_plan.assert_called_once()

        verify_args = self._args(
            replay_id="proof",
            group_prefix="torghut-ta-replay",
            auto_offset_reset="earliest",
            allow_existing_group_id=False,
            mode="verify",
            confirm="",
        )
        with patch.object(runner, "parse_args", return_value=verify_args):
            with patch.object(runner, "_require_kubectl"):
                with patch.object(runner, "_load_state", return_value=self._state()):
                    with patch.object(
                        runner, "_handle_verify_mode", return_value=5
                    ) as handle_verify:
                        self.assertEqual(runner.main(), 5)
        handle_verify.assert_called_once()

        apply_args = self._args(
            replay_id="proof",
            group_prefix="torghut-ta-replay",
            auto_offset_reset="earliest",
            allow_existing_group_id=False,
            mode="apply",
            confirm=runner.APPLY_CONFIRMATION_PHRASE,
        )
        with patch.object(runner, "parse_args", return_value=apply_args):
            with patch.object(runner, "_require_kubectl"):
                with patch.object(runner, "_load_state", return_value=self._state()):
                    with patch.object(
                        runner, "_handle_apply_mode", return_value=6
                    ) as handle_apply:
                        self.assertEqual(runner.main(), 6)
        handle_apply.assert_called_once()

        unconfirmed_apply_args = self._args(
            replay_id="proof",
            group_prefix="torghut-ta-replay",
            auto_offset_reset="earliest",
            allow_existing_group_id=False,
            mode="apply",
            confirm="",
        )
        with patch.object(runner, "parse_args", return_value=unconfirmed_apply_args):
            with patch.object(runner, "_require_kubectl"):
                with self.assertRaisesRegex(SystemExit, "requires --confirm"):
                    runner.main()

    def test_verify_text_mode_renders_coverage_and_failed_checks(self) -> None:
        state = runner.ReplayState(
            namespace="torghut",
            ta_group_id="wrong-group",
            ta_auto_offset_reset="latest",
            flink_job_state="suspended",
            flink_restart_nonce=7,
            flink_status_state="FAILED",
        )
        output = io.StringIO()
        with patch.object(
            runner,
            "_clickhouse_query",
            side_effect=[_TABLE_COVERAGE_TSV, _DAY_GAP_TSV],
        ):
            with redirect_stdout(output):
                exit_code = runner._handle_verify_mode(
                    args=self._args(json=False),
                    state=state,
                    plan=self._plan(),
                    warnings=[],
                )

        self.assertEqual(exit_code, 1)
        text = output.getvalue()
        self.assertIn("Verify results:", text)
        self.assertIn("ta_group_id_applied: fail", text)
        self.assertIn("job_state_not_failed: fail", text)

    def test_apply_text_mode_patches_and_renders_verification(self) -> None:
        applied_state = runner.ReplayState(
            namespace="torghut",
            ta_group_id="torghut-ta-replay-profit-proof",
            ta_auto_offset_reset="earliest",
            flink_job_state="running",
            flink_restart_nonce=8,
            flink_status_state="RUNNING",
        )
        output = io.StringIO()
        patches: list[tuple[str, str, dict[str, object]]] = []

        def capture_patch(kind: str, name: str, patch: dict[str, object]) -> None:
            patches.append((kind, name, patch))

        with patch.object(runner, "_kubectl_merge_patch", side_effect=capture_patch):
            with patch.object(runner, "_load_state", return_value=applied_state):
                with redirect_stdout(output):
                    exit_code = runner._handle_apply_mode(
                        args=self._args(
                            json=False,
                            verify=True,
                            check_clickhouse_coverage=False,
                        ),
                        state=self._state(),
                        plan=self._plan(),
                        warnings=["planned warning"],
                    )

        self.assertEqual(exit_code, 0)
        self.assertEqual(
            [patch[0] for patch in patches],
            ["configmap", "flinkdeployment", "flinkdeployment"],
        )
        self.assertIn("Patch complete.", output.getvalue())
        self.assertIn("restart_nonce_advanced: ok", output.getvalue())

    def test_apply_mode_blocks_before_patching_when_feasibility_rejects(self) -> None:
        output = io.StringIO()
        with patch.object(
            runner,
            "_kubectl_get_kafka_topics_json",
            return_value=_KAFKA_TOPICS_JSON,
        ):
            with patch.object(runner, "_kubectl_merge_patch") as merge_patch:
                with redirect_stdout(output):
                    exit_code = runner._handle_apply_mode(
                        args=self._args(
                            json=True,
                            check_clickhouse_coverage=False,
                            check_kafka_retention=True,
                        ),
                        state=self._state(),
                        plan=self._plan(),
                        warnings=[],
                    )

        self.assertEqual(exit_code, 1)
        merge_patch.assert_not_called()
        payload = json.loads(output.getvalue())
        self.assertEqual(payload["status"], "blocked")
        self.assertEqual(payload["mode"], "apply")
        self.assertEqual(
            payload["replay_feasibility"]["status"],
            "blocked_source_retention_or_missing_preflight",
        )
        self.assertIn(
            "apply blocked by replay_feasibility",
            payload["warnings"][0],
        )

    def test_clickhouse_query_builds_request_and_wraps_url_errors(self) -> None:
        class FakeResponse:
            def __enter__(self) -> "FakeResponse":
                return self

            def __exit__(self, *_args: object) -> None:
                return None

            def read(self) -> bytes:
                return b"ok"

        with patch.object(runner, "urlopen", return_value=FakeResponse()) as urlopen:
            result = runner._clickhouse_query(
                http_url="http://clickhouse.test:8123",
                username="torghut",
                password="secret",
                query="SELECT 1",
                timeout_seconds=0,
            )

        self.assertEqual(result, "ok")
        request = urlopen.call_args.args[0]
        self.assertEqual(request.full_url, "http://clickhouse.test:8123")
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(
            request.headers["Authorization"],
            runner._clickhouse_basic_auth("torghut", "secret"),
        )
        self.assertEqual(urlopen.call_args.kwargs["timeout"], 1)

        with patch.object(runner, "urlopen", side_effect=URLError("refused")):
            with self.assertRaisesRegex(
                RuntimeError, "clickhouse_coverage_query_failed"
            ):
                runner._clickhouse_query(
                    http_url="http://clickhouse.test:8123",
                    username="torghut",
                    password="secret",
                    query="SELECT 1",
                    timeout_seconds=5,
                )

    def test_coverage_loader_disabled_password_and_env_branches(self) -> None:
        self.assertIsNone(
            runner._load_clickhouse_coverage(
                self._args(check_clickhouse_coverage=False, clickhouse_password="")
            )
        )

        with self.assertRaisesRegex(SystemExit, "requires --clickhouse-password"):
            runner._load_clickhouse_coverage(
                self._args(
                    clickhouse_password="",
                    clickhouse_password_env="MISSING_TA_PASSWORD",
                )
            )

        with patch.dict(os.environ, {"TA_CLICKHOUSE_PASSWORD": "from-env"}):
            with patch.object(
                runner,
                "_clickhouse_query",
                side_effect=[
                    "table_name\tdays\tfirst_day\tlast_day\trows\nta_signals\tbad\t\t\t0\n",
                    "trading_day\tsignal_rows\tmicrobar_rows\n2026-05-22\t1\t1\n",
                ],
            ):
                coverage = runner._load_clickhouse_coverage(
                    self._args(clickhouse_password="", required_trading_days=0)
                )

        assert coverage is not None
        self.assertEqual(coverage["status"], "ok")
        self.assertEqual(coverage["summary"]["ta_signals_days"], 0)

    def test_parse_helpers_and_cli_defaults(self) -> None:
        self.assertEqual(runner._parse_tsv_with_names(""), [])
        self.assertEqual(
            runner._parse_tsv_with_names("a\tb\n1\n"),
            [{"a": "1", "b": ""}],
        )
        self.assertEqual(runner._parse_int_field(None, "days"), 0)
        self.assertEqual(runner._parse_int_field({"days": "bad"}, "days"), 0)
        self.assertIn("LIMIT 1 FORMAT TSVWithNames", runner._day_gap_query(0))

        argv = [
            "ta_replay_runner.py",
            "--replay-id",
            "proof",
            "--check-clickhouse-coverage",
            "--check-kafka-retention",
            "--required-trading-days",
            "25",
            "--required-calendar-days",
            "35",
            "--coverage-day-limit",
            "12",
            "--kafka-topic-namespace",
            "market-data",
            "--kafka-retention-topic",
            "trades=torghut.trades.replay",
            "--clickhouse-timeout-seconds",
            "3",
        ]
        with patch.object(sys, "argv", argv):
            with patch.dict(
                os.environ,
                {
                    "TA_CLICKHOUSE_HTTP_URL": "http://env-clickhouse:8123",
                    "TA_CLICKHOUSE_USERNAME": "env-user",
                },
            ):
                parsed = runner.parse_args()

        self.assertEqual(parsed.replay_id, "proof")
        self.assertTrue(parsed.check_clickhouse_coverage)
        self.assertEqual(parsed.required_trading_days, 25)
        self.assertEqual(parsed.required_calendar_days, 35)
        self.assertEqual(parsed.coverage_day_limit, 12)
        self.assertTrue(parsed.check_kafka_retention)
        self.assertEqual(parsed.kafka_topic_namespace, "market-data")
        self.assertEqual(parsed.kafka_retention_topic, ["trades=torghut.trades.replay"])
        self.assertEqual(parsed.clickhouse_timeout_seconds, 3)
        self.assertEqual(parsed.clickhouse_http_url, "http://env-clickhouse:8123")
        self.assertEqual(parsed.clickhouse_username, "env-user")
