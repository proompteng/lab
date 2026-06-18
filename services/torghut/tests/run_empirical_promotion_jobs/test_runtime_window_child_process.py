from __future__ import annotations

from contextlib import redirect_stderr, redirect_stdout
import importlib
from io import StringIO
import subprocess

from tests.run_empirical_promotion_jobs.support import (
    MagicMock,
    RunEmpiricalPromotionJobsTestCase,
    SimpleNamespace,
    datetime,
    json,
    patch,
    renewal,
    timezone,
)

renewal_target = importlib.import_module(
    "scripts.empirical_promotion_renewal.run_runtime_window_import_target"
)


class TestRunEmpiricalPromotionJobsRuntimeWindowChildProcess(
    RunEmpiricalPromotionJobsTestCase
):
    def test_runtime_window_import_surfaces_child_process_output(self) -> None:
        manifest_path = self.tmp_dir / "empirical-promotion-manifest.yaml"
        manifest_path.write_text("run_id: renew-1\n", encoding="utf-8")
        hypothesis_path = self.tmp_dir / "h-pairs-01.json"
        hypothesis_path.write_text(
            json.dumps({"candidate_id": "cand-paper-route"}),
            encoding="utf-8",
        )
        target = renewal.RuntimeWindowImportTarget(
            hypothesis_id="H-PAIRS-01",
            candidate_id="cand-paper-route",
            observed_stage="paper",
            strategy_family="microbar_cross_sectional_pairs",
            source_dsn_env="SIM_DB_DSN",
            strategy_name="paper-route-candidate-v1",
            account_label="TORGHUT_SIM",
            dataset_snapshot_ref="",
            source_manifest_ref=str(hypothesis_path),
            source_kind="paper_route_probe_runtime_observed",
            delay_adjusted_depth_stress_report_ref="",
        )
        args = SimpleNamespace(
            runtime_window_bucket_minutes=30,
            runtime_window_sample_minutes=5,
            runtime_window_target_plan_settlement_seconds=0,
        )
        child_error = subprocess.CalledProcessError(
            returncode=7,
            cmd=["python", "scripts/import_hypothesis_runtime_windows.py"],
            output="child stdout detail",
            stderr="child stderr detail",
        )
        stderr = StringIO()

        with (
            patch.object(renewal.subprocess, "run", side_effect=child_error),
            redirect_stderr(stderr),
            self.assertRaisesRegex(
                RuntimeError,
                "runtime_window_import_child_failed: exit_code=7",
            ),
        ):
            renewal._run_runtime_window_import_target(
                args=args,
                target=target,
                manifest={},
                run_id="renew-1",
                manifest_path=manifest_path,
                window_start=datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc),
                window_end=datetime(2026, 5, 26, 20, 0, tzinfo=timezone.utc),
                now=datetime(2026, 5, 26, 21, 23, tzinfo=timezone.utc),
            )

        output = stderr.getvalue()
        self.assertIn("runtime_window_import_child_failed exit_code=7", output)
        self.assertIn("runtime_window_import_child_stdout_begin", output)
        self.assertIn("child stdout detail", output)
        self.assertIn("runtime_window_import_child_stderr_begin", output)
        self.assertIn("child stderr detail", output)

    def test_child_stream_skips_empty_output_and_truncates_large_output(self) -> None:
        stderr = StringIO()
        oversized_output = (
            "dropped-prefix"
            + ("a" * renewal_target._CHILD_OUTPUT_MAX_CHARS)
            + "retained-suffix"
        )

        with redirect_stderr(stderr):
            renewal_target._write_child_stream("child", "stdout", None)
            renewal_target._write_child_stream("child", "stdout", oversized_output)

        output = stderr.getvalue()
        self.assertIn("child_stdout_begin", output)
        self.assertIn("truncated to last 20000 chars", output)
        self.assertNotIn("dropped-prefix", output)
        self.assertIn("retained-suffix", output)

    def test_split_module_main_wraps_empirical_promotion_child_process(self) -> None:
        args = SimpleNamespace(
            output_dir=str(self.tmp_dir),
            run_id_prefix="renew",
            strategy_spec_ref="microbar_cross_sectional_pairs_v1@research",
            hpairs_source_proof_census_file=None,
            json=True,
            runtime_window_import=False,
        )
        session_context = MagicMock()
        session_context.__enter__.return_value = object()
        session_context.__exit__.return_value = None
        child_result = SimpleNamespace(stdout=json.dumps({"status": "ok"}))
        stdout = StringIO()

        with (
            patch.object(renewal_target, "_parse_args", return_value=args),
            patch.object(renewal_target, "SessionLocal", return_value=session_context),
            patch.object(
                renewal_target, "_load_latest_empirical_job_rows", return_value=[]
            ),
            patch.object(renewal_target, "_latest_authoritative_rows", return_value={}),
            patch.object(
                renewal_target, "_runtime_version_ref", return_value="runtime-v1"
            ),
            patch.object(
                renewal_target,
                "build_renewal_manifest",
                return_value={"schema_version": "test", "run_id": "renew-1"},
            ),
            patch.object(
                renewal_target, "run_captured_child", return_value=child_result
            ) as run_mock,
            patch.object(
                renewal_target, "_run_runtime_window_import", return_value=None
            ),
            redirect_stdout(stdout),
        ):
            self.assertEqual(renewal_target.main(), 0)

        run_mock.assert_called_once()
        command = run_mock.call_args.args[0]
        self.assertIn("scripts/run_empirical_promotion_jobs.py", command)
        self.assertEqual(
            run_mock.call_args.kwargs["context"],
            "empirical_promotion_jobs_child",
        )
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["empirical_promotion"], {"status": "ok"})
