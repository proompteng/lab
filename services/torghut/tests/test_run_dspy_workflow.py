from __future__ import annotations

import json
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Mapping
from unittest import TestCase
from unittest.mock import MagicMock, patch

from scripts import run_dspy_workflow


class _FakeSessionContext:
    def __init__(self) -> None:
        self.session = object()

    def __enter__(self) -> object:
        return self.session

    def __exit__(self, exc_type: object, exc: object, tb: object) -> bool:
        return False


class TestRunDSPyWorkflowScript(TestCase):
    def test_main_passes_priority_id_and_writes_completed_iteration_report(self) -> None:
        with TemporaryDirectory() as tmpdir:
            artifact_root = Path(tmpdir) / "artifacts" / "dspy" / "run-1"
            responses = {
                "dataset-build": {"agentRun": {"id": "record-dataset"}},
                "compile": {"agentRun": {"id": "record-compile"}},
                "eval": {"agentRun": {"id": "record-eval"}},
                "promote": {"agentRun": {"id": "record-promote"}},
            }

            with patch.object(
                sys,
                "argv",
                [
                    "run_dspy_workflow.py",
                    "--repository",
                    "proompteng/lab",
                    "--base",
                    "main",
                    "--head",
                    "codex/dspy-live-1",
                    "--run-prefix",
                    "torghut-dspy-run-1",
                    "--priority-id",
                    " P-1 ",
                    "--artifact-root",
                    str(artifact_root),
                ],
            ):
                with patch.object(run_dspy_workflow, "SessionLocal", return_value=MagicMock()):
                    run_dspy_workflow.SessionLocal.return_value = _FakeSessionContext()
                    with patch(
                        "scripts.run_dspy_workflow.orchestrate_dspy_agentrun_workflow",
                        return_value=responses,
                    ) as orchestrate_mock:
                        with patch("builtins.print") as print_mock:
                            exit_code = run_dspy_workflow.main()

            self.assertEqual(exit_code, 0)
            orchestrate_mock.assert_called_once()
            call_kwargs = orchestrate_mock.call_args.kwargs
            self.assertEqual(call_kwargs["artifact_root"], str(artifact_root.resolve()))
            self.assertEqual(call_kwargs["priority_id"], "P-1")

            output = json.loads((print_mock.call_args.args[0]))
            self.assertEqual(output["artifactRoot"], str(artifact_root.resolve()))
            self.assertEqual(output["artifactPath"], str(artifact_root.resolve()))
            self.assertEqual(output["priorityId"], "P-1")

            iteration_path = artifact_root / "iteration-1.md"
            self.assertTrue(iteration_path.exists())
            iteration_report = iteration_path.read_text(encoding="utf-8")
            self.assertIn("- status: completed", iteration_report)
            self.assertIn(f"- artifact_path: {artifact_root.resolve()}", iteration_report)
            self.assertIn("- priority_id: P-1", iteration_report)
            self.assertIn("- responses: compile, dataset-build, eval, promote", iteration_report)

    def test_main_records_failure_iteration_report_when_orchestration_fails(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            artifact_root = Path(tmpdir) / "artifacts" / "dspy" / "run-2"

            with patch.object(
                sys,
                "argv",
                [
                    "run_dspy_workflow.py",
                    "--repository",
                    "proompteng/lab",
                    "--base",
                    "main",
                    "--head",
                    "codex/dspy-live-2",
                    "--run-prefix",
                    "torghut-dspy-run-2",
                    "--artifact-root",
                    str(artifact_root),
                ],
            ):
                with patch.object(run_dspy_workflow, "SessionLocal", return_value=MagicMock()):
                    run_dspy_workflow.SessionLocal.return_value = _FakeSessionContext()
                    with patch(
                        "scripts.run_dspy_workflow.orchestrate_dspy_agentrun_workflow",
                        side_effect=RuntimeError("promotion_gate_blocked"),
                    ) as orchestrate_mock:
                        with self.assertRaisesRegex(RuntimeError, "promotion_gate_blocked"):
                            run_dspy_workflow.main()
                        orchestrate_mock.assert_called_once()

            iteration_report = artifact_root / "iteration-1.md"
            self.assertTrue(iteration_report.exists())
            report_text = iteration_report.read_text(encoding="utf-8")
            self.assertIn("- status: failed", report_text)
            self.assertIn("- error: promotion_gate_blocked", report_text)
            self.assertNotIn("- responses:", report_text)

    def test_write_iteration_report_uses_incremental_iteration_numbers(self) -> None:
        with TemporaryDirectory() as tmpdir:
            artifact_root = Path(tmpdir) / "artifacts" / "dspy" / "run-3"
            artifact_root.mkdir(parents=True, exist_ok=True)
            (artifact_root / "iteration-1.md").write_text("old", encoding="utf-8")
            (artifact_root / "iteration-3.md").write_text("old", encoding="utf-8")

            report_path = run_dspy_workflow._write_iteration_report(
                artifact_root=artifact_root,
                repository="proompteng/lab",
                base="main",
                head="codex/dspy-live-3",
                run_prefix="torghut-dspy-run-3",
                status="completed",
                responses={"dataset-build": {}},  # type: ignore[arg-type]
            )

            self.assertEqual(report_path.name, "iteration-4.md")
            report = report_path.read_text(encoding="utf-8")
            self.assertIn("- status: completed", report)
            self.assertIn("- run_prefix: torghut-dspy-run-3", report)

    def test_write_iteration_report_records_priority_and_metadata(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            artifact_root = Path(tmpdir) / "artifacts" / "dspy" / "run-4"
            payload: dict[str, Mapping[str, object]] = {
                "dataset-build": {"agentRun": {"id": "record-dataset"}},
            }
            report_path = run_dspy_workflow._write_iteration_report(
                artifact_root=artifact_root,
                repository="proompteng/lab",
                base="main",
                head="codex/dspy-live-4",
                run_prefix="torghut-dspy-run-4",
                status="completed",
                responses=payload,
                priority_id="urgent-9",
            )

            self.assertEqual(report_path.name, "iteration-1.md")
            report = report_path.read_text(encoding="utf-8")
            self.assertIn("- priority_id: urgent-9", report)
            self.assertIn("- responses: dataset-build", report)
