import contextlib
import io
import json
import os
import pathlib
import socket
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer, ThreadingHTTPServer
from unittest.mock import MagicMock, patch

from collector import (
    Collector,
    GitHub,
    Store,
    cache_evidence,
    exposition,
    job_record,
    labels,
    metrics_handler,
    phase,
    project_ci_audit,
    timestamp,
)


def run(attempt=1):
    return {
        "id": 40192906997,
        "run_attempt": attempt,
        "path": ".github/workflows/temporal-worker-images.yml",
        "status": "completed",
        "conclusion": "success",
        "created_at": "2026-10-25T10:53:56Z",
        "run_started_at": "2026-10-25T12:23:43Z",
        "updated_at": "2026-10-25T12:32:49Z",
        "head_sha": "39016a275bc4bd6f17c59c59b52f8d906b8cb697",
        "event": "push",
        "html_url": "https://github.com/proompteng/lab/actions/runs/40192906997",
    }


def job(attempt=1):
    return {
        "id": 121167538571 + attempt,
        "run_attempt": attempt,
        "name": "Temporal worker build and heartbeat tests (arm64)",
        "labels": ["arc-arm64"],
        "runner_name": "arc-arm64-jxtv5-runner-qk2cn",
        "status": "completed",
        "conclusion": "success",
        "created_at": "2026-10-25T12:23:43Z",
        "started_at": "2026-10-25T12:27:16Z",
        "completed_at": "2026-10-25T12:31:15Z",
        "steps": [
            {
                "name": "Build runtime",
                "started_at": "2026-10-25T12:28:49Z",
                "completed_at": "2026-10-25T12:29:05Z",
                "conclusion": "success",
            }
        ],
    }


class FakeGitHub:
    remaining = 4900

    def __init__(self, attempts, jobs):
        self.attempts, self.jobs, self.requests = attempts, jobs, []

    def get(self, path, conditional=False):
        self.requests.append(path)
        attempt = int(path.rsplit("/", 1)[-1])
        return self.attempts[attempt]

    def pages(self, path, key, conditional=False):
        self.requests.append(path)
        attempt = int(path.split("/attempts/")[1].split("/")[0])
        return iter(self.jobs[attempt])

    def log(self, job_id):
        return "#0 building with test\n#1 [build 1/1] RUN go build\n#1 CACHED\n"


class CollectorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = pathlib.Path(self.tmp.name) / "ci.sqlite3"
        self.store = Store(self.path)
        self.now = timestamp("2026-10-25T12:35:00Z")

    def tearDown(self):
        self.store.db.close()
        self.tmp.cleanup()

    def test_real_arm_build_timings_use_job_creation(self):
        record = job_record(run(2), job(2))
        self.assertEqual(record["durations"]["queue"], 213)
        self.assertEqual(record["durations"]["execution"], 239)
        self.assertEqual(record["durations"]["build"], 16)
        self.assertEqual(record["architecture"], "arm64")
        self.assertEqual(record["runner_pool"], "arc")
        self.assertTrue(record["run_url"].endswith("/attempts/2"))

    def test_cancelled_unassigned_job_is_queue_time_without_execution(self):
        value = job()
        value.update(
            runner_name=None,
            started_at=None,
            completed_at="2026-10-25T12:25:43Z",
            conclusion="cancelled",
            steps=[],
        )
        record = job_record(run(), value)
        self.assertEqual(record["durations"], {"queue": 120})
        self.assertEqual(record["outcome"], "cancelled")
        self.assertEqual(record["job_role"], "build")

    def test_unknown_architecture_is_not_assumed_amd64(self):
        value = job()
        value.update(labels=["self-hosted"], name="build image", runner_name="custom")
        self.assertEqual(job_record(run(), value)["architecture"], "unknown")

    def test_cached_run_vertices_are_scoped_to_each_build(self):
        log = """#0 building with first
#3 [builder 1/2] RUN go test ./...
#4 [builder 2/2] RUN go build
#4 CACHED
#3 CACHED
#8 exporting to image
#8 DONE 3.9s
#9 exporting to GitHub Actions Cache
#9 DONE 6.7s
#0 building with second
#3 [builder 1/1] RUN echo other
#3 DONE 2.0s
"""
        cache = cache_evidence(log)
        self.assertEqual(
            (cache["hits"], cache["total"], cache["state"]), (2, 3, "mixed")
        )
        self.assertEqual(cache["durations"], {"image_export": 3.9, "cache_export": 6.7})

    def test_missing_cache_evidence_is_unknown(self):
        self.assertEqual(
            cache_evidence(""),
            {"source": "unavailable", "state": "unknown", "durations": {}},
        )

    def test_declared_job_families_separate_targets_without_raw_name_labels(self):
        value = job()
        value["name"] = "bilig / build-platform (linux/arm64, arm64, arc-arm64)"
        record = job_record(
            run(),
            value,
            [
                {"id": "bilig", "pattern": r"bilig /.*"},
                {"id": "tengri", "pattern": r"tengri /.*"},
            ],
        )
        self.assertEqual(record["job_family"], "bilig")
        duplicate = [
            {"id": "first", "pattern": r"bilig /.*"},
            {"id": "second", "pattern": r"bilig /.*"},
        ]
        self.assertEqual(job_record(run(), value, duplicate)["job_family"], "unknown")
        value["name"] = "unknown dynamically named target"
        self.assertEqual(
            job_record(run(), value, [{"id": "bilig", "pattern": r"bilig /.*"}])[
                "job_family"
            ],
            "unknown",
        )

    def test_nix_cache_data_has_bounded_fields_and_state(self):
        cache = cache_evidence(
            "| Attic substitutions | 4 |\n| cache.nixos.org substitutions | 2 |\n| Local derivation builds | 1 |\nstate=unbounded token=secret"
        )
        self.assertEqual(cache["state"], "nix_builds")
        self.assertNotIn("token", cache)
        bad = cache_evidence(
            "| Attic substitutions | -1 |\n| cache.nixos.org substitutions | 2 |\n| Local derivation builds | 1 |"
        )
        self.assertEqual(bad["state"], "unknown")

    def test_nix_upload_and_download_failures_reach_metrics(self):
        cache = cache_evidence(
            "| Attic substitutions | 4 |\n| cache.nixos.org substitutions | 2 |\n"
            "| Local derivation builds | 1 |\n| Attic upload successes | 0 |\n"
            "| Attic upload failures | 1 |\n| Attic download failures | 2 |\n"
            "| cache.nixos.org download failures | 3 |"
        )
        self.assertEqual(cache["attic_upload_failures"], 1)
        self.assertEqual(cache["attic_download_failures"], 2)
        self.store.save_job(job_record(run(), job()), cache)
        metrics = self.store.render(self.now)
        for kind, value in (
            ("attic_upload_failures", 1),
            ("attic_download_failures", 2),
            ("nixos_download_failures", 3),
        ):
            lines = [
                line
                for line in metrics.splitlines()
                if line.startswith("ci_nix_cache_events") and f'kind="{kind}"' in line
            ]
            self.assertTrue(lines)
            self.assertTrue(all(line.endswith(f" {value}") for line in lines))

    def test_real_step_names_separate_setup_build_publication_and_validation(self):
        expected = {
            "Set up job": "runner_setup",
            "Run actions/checkout@v6": "checkout",
            "Run ./.github/actions/setup-buildkit": "toolchain",
            "Build Nix image archive": "build",
            "Build runtime": "build",
            "Build installer": "build",
            "Push platform image without Docker": "publish",
            "Assemble and validate the immutable release index": "publish",
            "Retain SDK heartbeat proof": "verify",
            "Post Build runtime": "cleanup",
        }
        for name, value in expected.items():
            with self.subTest(name=name):
                self.assertEqual(phase(name), value)

    def test_installer_build_collects_cache_and_build_duration(self):
        value = job()
        value["name"] = "Build kata installer"
        value["steps"][0]["name"] = "Build installer"
        api = FakeGitHub({}, {})
        observer = Collector(
            self.store, api, {"temporal-worker-images.yml": []}, "http://unused"
        )
        with patch.object(api, "log", wraps=api.log) as download:
            observer.collect_job(job_record(run(), value), time.monotonic() + 20)
        download.assert_called_once_with(value["id"])
        record = json.loads(
            self.store.db.execute("SELECT record FROM jobs").fetchone()[0]
        )
        self.assertEqual(record["durations"]["build"], 16)
        self.assertEqual(record["cache"]["state"], "warm")

    def test_measured_publishing_phase_overrides_reusable_caller_build_name(self):
        value = job()
        value["name"] = "build-app / publish-index"
        value["steps"][0]["name"] = "Create OCI image index"
        record = job_record(run(), value)
        self.assertEqual(record["job_role"], "publish")
        self.assertEqual(record["durations"]["publish"], 16)
        self.assertNotIn("build", record["durations"])

    def test_idempotency_survives_process_restart_and_keeps_ids_out_of_metrics(self):
        record = job_record(run(), job())
        cache = cache_evidence("#0 building with test\n#1 [a 1/1] RUN true\n#1 CACHED")
        self.assertTrue(self.store.save_job(record, cache))
        before = self.store.render(self.now)
        self.store.db.close()
        self.store = Store(self.path)
        self.assertFalse(self.store.save_job(record, cache))
        self.assertEqual(before, self.store.render(self.now))
        for field in ("run_id=", "job_id=", "head_sha=", "runner_name="):
            self.assertNotIn(field, before)
        self.assertEqual(
            self.store.db.execute("SELECT COUNT(*) FROM outbox").fetchone()[0], 1
        )

    def test_phase_cohorts_fit_the_shared_metric_series_budget(self):
        for index in range(40):
            value = run()
            value["path"] = f".github/workflows/image-{index}.yml"
            record = job_record(value, job())
            record["job_id"] += index
            record["durations"] = {
                phase: 12
                for phase in (
                    "queue",
                    "execution",
                    "build",
                    "runner_setup",
                    "publish",
                    "unattributed",
                )
            }
            self.store.save_job(record, cache_evidence(""))
        metrics = self.store.render(self.now)
        samples = [
            line for line in metrics.splitlines() if line and not line.startswith("#")
        ]
        self.assertLess(len(samples), 2000)
        self.assertIn('phase="build"', metrics)
        self.assertIn('percentile="95"', metrics)
        self.assertIn("ci_jobs_completed", metrics)

    def test_retained_histogram_rows_cannot_reintroduce_unbounded_phase_series(self):
        with self.store.db:
            self.store.db.execute(
                """INSERT INTO aggregates VALUES
                   ('ci_job_phase_duration_seconds', '{"phase":"build"}', 1, 12, '[0,0,0,1]')"""
            )
        metrics = self.store.render(self.now)
        self.assertNotIn("ci_job_phase_duration_seconds", metrics)

    def test_attempt_specific_jobs_exclude_carried_forward_earlier_attempt(self):
        first, second = run(1), run(2)
        first["conclusion"] = "cancelled"
        initial, rerun = job(1), job(2)
        initial["conclusion"] = "cancelled"
        api = FakeGitHub({1: first, 2: second}, {1: [initial], 2: [initial, rerun]})
        observer = Collector(
            self.store, api, {"temporal-worker-images.yml": []}, "http://unused"
        )
        self.store.discover(second, self.now)
        while pending := self.store.pending():
            observer.collect_attempt(pending, time.monotonic() + 20)
        self.assertEqual(
            self.store.db.execute("SELECT COUNT(*) FROM jobs").fetchone()[0], 2
        )
        self.assertEqual(
            self.store.db.execute(
                "SELECT COUNT(*) FROM attempts WHERE state='complete'"
            ).fetchone()[0],
            2,
        )
        self.assertTrue(any("/attempts/1/jobs" in p for p in api.requests))
        self.assertTrue(any("/attempts/2/jobs" in p for p in api.requests))
        stored = json.loads(
            self.store.db.execute(
                "SELECT run FROM attempts WHERE attempt=2"
            ).fetchone()[0]
        )
        self.assertEqual(stored["job_count"], 1)
        self.assertEqual(stored["duration_seconds"], 452)

    def test_job_failure_and_workflow_failure_are_independent(self):
        value = run()
        value["conclusion"] = "failure"
        value["actor"] = {"email": "not-retained@example.com"}
        self.store.discover(value, self.now)
        self.store.save_job(job_record(value, job()), cache_evidence(""))
        self.store.finish(value, [job()])
        self.store.finish(value, [job()])
        text = self.store.render(self.now)
        self.assertIn('outcome="success",phase="execution"', text)
        self.assertRegex(
            text, r'ci_workflows_completed\{[^\n]*outcome="failure"[^\n]*\} 1'
        )
        self.assertNotIn(
            "not-retained",
            self.store.db.execute("SELECT run FROM attempts").fetchone()[0],
        )
        self.assertEqual(
            self.store.db.execute("SELECT COUNT(*) FROM outbox").fetchone()[0], 2
        )

    def test_rolling_comparisons_use_event_time_and_keep_cache_cohorts_separate(self):
        exports = {"cache_import": 1.0, "cache_export": 2.0, "image_export": 3.0}
        phases = {
            "queue": 213.0,
            "execution": 239.0,
            "build": 16.0,
            "unattributed": 223.0,
            **{f"buildkit_{phase}": value for phase, value in exports.items()},
        }
        export_percentiles = [
            (f"buildkit_{phase}", p) for phase in exports for p in (50, 95)
        ]
        recent_success = export_percentiles + [
            ("queue", 50),
            ("queue", 95),
            ("execution", 50),
            ("execution", 95),
        ]
        fixture = [
            ("1h", "warm", "success", recent_success),
            ("1h", "cold", "success", recent_success),
            ("7d_baseline", "warm", "success", [("execution", 50)]),
            ("1h", "mixed", "failure", export_percentiles),
            ("7d_baseline", "mixed", "failure", []),
        ]
        expected_percentiles, expected_totals, expected_samples = [], [], []
        for offset, (window, state, outcome, quantiles) in enumerate(fixture):
            record = job_record(
                run(),
                job() | {"conclusion": outcome},
                [{"id": "build", "pattern": ".*"}],
            )
            record["job_id"] += offset
            if window == "7d_baseline":
                record["completed_at"] = "2026-10-24T12:31:15Z"
            self.store.save_job(
                record, {"state": state, "source": "test", "durations": exports}
            )
            attrs = labels(record, cache_state=state, window=window)
            for phase_name in phases:
                expected_samples.append(
                    exposition(
                        "ci_job_duration_samples", 1, attrs | {"phase": phase_name}
                    ).strip()
                )
            if window == "1h":
                for phase_name in ("build", "unattributed"):
                    expected_totals.append(
                        exposition(
                            "ci_job_phase_total_seconds",
                            phases[phase_name],
                            attrs | {"phase": phase_name},
                        ).strip()
                    )
            for phase_name, percentile in quantiles:
                expected_percentiles.append(
                    exposition(
                        "ci_job_duration_percentile_seconds",
                        phases[phase_name],
                        attrs | {"phase": phase_name, "percentile": percentile},
                    ).strip()
                )
        lines = self.store.render(self.now).splitlines()
        for metric, expected in (
            ("ci_job_duration_percentile_seconds", expected_percentiles),
            ("ci_job_phase_total_seconds", expected_totals),
            ("ci_job_duration_samples", expected_samples),
        ):
            with self.subTest(metric=metric):
                self.assertCountEqual(
                    [line for line in lines if line.startswith(metric + "{")], expected
                )

    def test_loki_failure_retains_outbox_and_retry_uses_same_record_identity(self):
        received = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                received.append(
                    json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                )
                self.send_response(500 if len(received) == 1 else 204)
                self.end_headers()

            def log_message(self, *_args):
                return

        server = HTTPServer(("127.0.0.1", 0), Handler)
        worker = threading.Thread(target=server.serve_forever)
        worker.start()
        try:
            self.store.save_job(job_record(run(), job()), cache_evidence(""))
            observer = Collector(
                self.store,
                FakeGitHub({}, {}),
                [],
                f"http://127.0.0.1:{server.server_port}",
            )
            with self.assertRaises(Exception):
                observer.flush()
            self.assertEqual(
                self.store.db.execute("SELECT COUNT(*) FROM outbox").fetchone()[0], 1
            )
            observer.flush()
            self.assertEqual(received[0], received[1])
            self.assertEqual(
                self.store.db.execute("SELECT COUNT(*) FROM outbox").fetchone()[0], 0
            )
            self.assertNotIn("run_id", received[0]["streams"][0]["stream"])
            another = job_record(run(), job())
            another["job_id"] += 100
            self.store.save_job(another, cache_evidence(""))
            with (
                patch.object(
                    observer, "poll", side_effect=RuntimeError("GitHub unavailable")
                ),
                patch("time.sleep", side_effect=StopIteration),
            ):
                with self.assertRaises(StopIteration):
                    observer.run()
            self.assertEqual(
                self.store.db.execute("SELECT COUNT(*) FROM outbox").fetchone()[0], 0
            )
            self.assertEqual(len(received), 3)
        finally:
            server.shutdown()
            worker.join()
            server.server_close()

    def test_slow_poll_does_not_limit_loki_to_one_batch(self):
        record = job_record(run(), job())
        for offset in range(201):
            self.store.save_job(
                record | {"job_id": record["job_id"] + offset}, cache_evidence("")
            )
        observer = Collector(self.store, FakeGitHub({}, {}), {}, "http://unused")
        clock = [time.time()]
        sizes = []

        def slow_poll(_now):
            clock[0] += 75

        def deliver(request, timeout):
            sizes.append(
                sum(len(s["values"]) for s in json.loads(request.data)["streams"])
            )
            clock[0] += 1.45
            return io.BytesIO()

        with (
            patch.dict(os.environ, {"CI_AUDIT_DATABASE_URL": "example"}),
            patch("collector.subprocess.run") as project,
            patch.object(observer, "poll", side_effect=slow_poll),
            patch.object(observer, "history"),
            patch("time.time", side_effect=lambda: clock[0]),
            patch("time.monotonic", side_effect=lambda: clock[0]),
            patch("urllib.request.urlopen", side_effect=deliver),
            patch("time.sleep", side_effect=StopIteration),
            self.assertRaises(StopIteration),
        ):
            observer.run()
        self.assertEqual(sizes, [100, 100, 1])
        self.assertEqual(
            self.store.db.execute("SELECT COUNT(*) FROM outbox").fetchone()[0], 0
        )
        project.assert_not_called()  # The optional writer cannot overrun the cycle.

    def test_audit_projection_is_a_noop_without_a_url(self):
        observer = Collector(self.store, FakeGitHub({}, {}), {}, "http://unused")
        output = io.StringIO()
        with (
            patch.dict(os.environ),
            patch.dict(sys.modules, {"psycopg": None}),
            patch("collector.subprocess.run") as worker,
            patch.object(observer, "poll"),
            patch.object(observer, "history"),
            patch("time.sleep", side_effect=StopIteration),
            contextlib.redirect_stdout(output),
            self.assertRaises(StopIteration),
        ):
            os.environ.pop("CI_AUDIT_DATABASE_URL", None)
            project_ci_audit(self.path, os.environ.get("CI_AUDIT_DATABASE_URL"))
            observer.run()
        worker.assert_not_called()
        self.assertEqual(output.getvalue(), "")
        self.assertIsNone(
            self.store.db.execute(
                "SELECT 1 FROM sqlite_schema WHERE name='ci_audit_checkpoints'"
            ).fetchone()
        )

    def test_audit_timeout_is_fail_open_after_loki_delivery(self):
        record = job_record(run(), job())
        self.store.save_job(record, cache_evidence(""))
        observer = Collector(self.store, FakeGitHub({}, {}), {}, "http://unused")
        output = io.StringIO()

        def stall(command, *, timeout, **_kwargs):
            self.assertLessEqual(timeout, 5)
            self.assertNotIn("example", command)
            self.assertEqual(
                self.store.db.execute("SELECT COUNT(*) FROM outbox").fetchone()[0], 0
            )
            raise subprocess.TimeoutExpired(command, timeout)

        with (
            patch.dict(os.environ, {"CI_AUDIT_DATABASE_URL": "example"}),
            patch("collector.subprocess.run", side_effect=stall) as worker,
            patch.object(observer, "poll"),
            patch.object(observer, "history"),
            patch("urllib.request.urlopen", return_value=io.BytesIO()),
            patch("time.sleep", side_effect=StopIteration),
            contextlib.redirect_stdout(output),
            self.assertRaises(StopIteration),
        ):
            observer.run()
        worker.assert_called_once()
        self.assertEqual(observer.errors, 0)
        self.assertEqual(
            json.loads(output.getvalue()),
            {
                "event": "ci_audit_projection_failed",
                "error_type": "TimeoutExpired",
            },
        )

    def test_audit_batches_retry_unacknowledged_rows_and_page_large_attempts(self):
        value = run() | {"head_branch": "main"}
        failed, unassigned = job(), job()
        failed["conclusion"] = "failure"
        failed["steps"][0]["conclusion"] = "failure"
        unassigned.update(
            id=failed["id"] + 1,
            runner_name=None,
            started_at="0001-01-01T00:00:00Z",
            conclusion="cancelled",
            steps=[],
        )
        last = job() | {"id": failed["id"] + 2}
        jobs = [failed, unassigned, last]
        self.store.discover(value, self.now)
        for item in jobs:
            self.store.save_job(job_record(value, item), cache_evidence(""))
        self.store.finish(value, jobs)
        self.assertNotIn(
            "head_branch",
            json.loads(
                self.store.db.execute(
                    "SELECT line FROM outbox ORDER BY id DESC LIMIT 1"
                ).fetchone()[0]
            ),
        )

        driver = types.SimpleNamespace(connect=MagicMock())
        db = driver.connect.return_value.__enter__.return_value
        cursor = db.cursor.return_value.__enter__.return_value
        output = io.StringIO()
        url = "postgresql://ci_audit_writer:private@localhost/agents"
        with (
            patch.dict(sys.modules, {"psycopg": driver}),
            patch("collector.CI_AUDIT_ROW_LIMIT", 3),
            patch("time.time", return_value=self.now),
            contextlib.redirect_stdout(output),
        ):
            driver.connect.return_value.__exit__.side_effect = OSError(url)
            project_ci_audit(self.path, url)
            checkpoint = "SELECT job_cursor FROM ci_audit_checkpoints"
            self.assertIsNone(self.store.db.execute(checkpoint).fetchone())
            driver.connect.return_value.__exit__.side_effect = None
            project_ci_audit(self.path, url)
            self.assertEqual(
                self.store.db.execute(checkpoint).fetchone()[0], unassigned["id"]
            )
            project_ci_audit(self.path, url)
            self.assertEqual(self.store.db.execute(checkpoint).fetchone()[0], -1)
            project_ci_audit(self.path, url)

        self.assertNotIn("private", output.getvalue())
        self.assertEqual(json.loads(output.getvalue())["error_type"], "OSError")
        self.assertEqual(driver.connect.call_args.kwargs["user"], "ci_audit_writer")
        self.assertEqual(driver.connect.call_args.kwargs["connect_timeout"], 2)
        self.assertIn(
            "statement_timeout=2000", driver.connect.call_args.kwargs["options"]
        )
        self.assertEqual(len(cursor.executemany.call_args_list), 6)
        for index, expected_jobs in enumerate(
            ([failed, unassigned], [failed, unassigned], [last])
        ):
            workflow_sql, workflows = cursor.executemany.call_args_list[2 * index].args
            self.assertIn("ON CONFLICT (run_id) DO UPDATE", workflow_sql)
            self.assertEqual(
                [(row[0], row[2]) for row in workflows], [(value["id"], "main")]
            )
            job_sql, projected = cursor.executemany.call_args_list[2 * index + 1].args
            self.assertIn("ON CONFLICT (job_id) DO NOTHING", job_sql)
            self.assertEqual(
                [row[0] for row in projected], [item["id"] for item in expected_jobs]
            )
        first_batch = cursor.executemany.call_args_list[1].args[1]
        self.assertEqual(first_batch[0][-1], "build")
        self.assertIsNone(first_batch[1][4])  # Runner.
        self.assertIsNone(first_batch[1][7])  # Start time.
        self.assertIsNone(first_batch[1][-1])  # Failure category.
        self.assertEqual(len(cursor.execute.call_args_list), 4 * 3)
        for statement in cursor.execute.call_args_list:
            sql, params = statement.args
            self.assertIn("LIMIT %s", sql)
            self.assertEqual(params[-1], 3)
        cluster_sql, params = cursor.execute.call_args_list[-3].args
        self.assertIn("interval '24 hours'", cluster_sql)
        self.assertIn("ON CONFLICT (cluster_key) DO UPDATE", cluster_sql)
        self.assertEqual(params, (3, 3))

    def test_audit_backfill_does_not_replace_the_latest_completed_attempt(self):
        first = run() | {"conclusion": "failure"}
        newest = run(2) | {"updated_at": "2026-10-25T12:34:49Z"}
        self.store.discover(newest, self.now)
        self.store.finish(newest, [])
        driver = types.SimpleNamespace(connect=MagicMock())
        cursor = driver.connect.return_value.__enter__.return_value.cursor.return_value.__enter__.return_value
        with (
            patch.dict(sys.modules, {"psycopg": driver}),
            patch("time.time", return_value=self.now),
        ):
            project_ci_audit(self.path, "example")
            self.store.finish(first, [])
            project_ci_audit(self.path, "example")
        self.assertEqual(cursor.executemany.call_count, 2)
        self.assertEqual(
            [list(call.args[1])[0][6] for call in cursor.executemany.call_args_list],
            ["success", "success"],
        )

    def test_failed_active_poll_does_not_advance_success_heartbeat(self):
        api = FakeGitHub({}, {})
        observer = Collector(self.store, api, {}, "http://unused")
        with patch.object(
            api, "pages", side_effect=RuntimeError("GitHub API returned HTTP 403")
        ):
            with self.assertRaises(RuntimeError):
                observer.poll(self.now)
        self.assertEqual(observer.last_poll, 0)

    def test_poll_deadline_interrupts_a_blocking_response_body(self):
        api = GitHub("unused")
        observer = Collector(self.store, api, {}, "http://unused")
        observer.last_poll = self.now - 60
        observer.active_metrics = "last complete snapshot"
        reader, writer = socket.socketpair()
        with reader, writer, reader.makefile("rb") as response:
            reader.settimeout(1)
            writer.sendall(b'{"workflow_runs": [')
            response.headers = {}
            with (
                patch("collector.POLL_BUDGET_SECONDS", 0.1),
                patch.object(api, "pages", return_value=iter([])),
                patch.object(api.opener, "open", return_value=response),
                self.assertRaisesRegex(RuntimeError, "GitHub poll.*budget"),
            ):
                observer.poll(self.now)
        self.assertEqual(observer.last_poll, self.now - 60)
        self.assertEqual(observer.active_metrics, "last complete snapshot")

    def test_blocked_poll_exposes_live_phase_without_refreshing_cached_facts(self):
        observer = Collector(self.store, FakeGitHub({}, {}), {}, "http://unused")
        observer.refresh()
        cached = observer.metrics
        entered, release = threading.Event(), threading.Event()
        errors = []

        def blocked_poll():
            try:
                with observer.phases.track("poll"):
                    entered.set()
                    release.wait(5)
            except BaseException as error:  # noqa: BLE001 - Relay worker failures to the test thread.
                errors.append(error)

        with patch("time.monotonic", return_value=100) as clock:
            worker = threading.Thread(target=blocked_poll)
            worker.start()
            try:
                self.assertTrue(entered.wait(2))
                clock.return_value = 880
                # The HTTP reader must not access SQLite or refresh cached facts.
                with patch.object(self.store, "render", side_effect=AssertionError):
                    metrics = observer.render_metrics().decode()
                self.assertIn(
                    'ci_observability_phase_active{phase="poll"} 1\n', metrics
                )
                self.assertIn(
                    'ci_observability_phase_elapsed_seconds{phase="poll"} 780\n',
                    metrics,
                )
                self.assertIn(
                    "ci_observability_last_poll_timestamp_seconds 0\n", metrics
                )
                self.assertEqual(observer.metrics, cached)
            finally:
                release.set()
                worker.join(2)
            self.assertFalse(worker.is_alive())
        self.assertEqual(errors, [])
        self.assertIn(
            'ci_observability_phase_active{phase="poll"} 0\n',
            observer.render_metrics().decode(),
        )

    def test_phase_outcomes_are_bounded_and_preserve_exceptions(self):
        observer = Collector(self.store, FakeGitHub({}, {}), {}, "http://unused")
        for error, outcome in (
            (None, "success"),
            (RuntimeError("secret-url"), "error"),
            (KeyboardInterrupt(), "interrupted"),
        ):
            with patch("time.monotonic", side_effect=[10, 14]):
                if error is None:
                    with observer.phases.track("poll"):
                        pass
                else:
                    with (
                        self.assertRaises(type(error)) as caught,
                        observer.phases.track("poll"),
                    ):
                        raise error
                    self.assertIs(caught.exception, error)
            metrics = observer.render_metrics().decode()
            self.assertIn(
                f'ci_observability_phase_completions_total{{outcome="{outcome}",phase="poll"}} 1\n',
                metrics,
            )
            self.assertIn(
                'ci_observability_phase_last_duration_seconds{phase="poll"} 4\n',
                metrics,
            )
            self.assertNotIn("secret-url", metrics)
        with self.assertRaises(ValueError), observer.phases.track("run-12345"):
            self.fail("Unbounded phase was accepted")
        self.assertNotIn("run-12345", observer.render_metrics().decode())
        lines = observer.phases.render().splitlines()
        self.assertEqual(len(lines), 48)
        self.assertEqual(len({line.rsplit(" ", 1)[0] for line in lines}), 48)
        with observer.phases.track("poll"):
            with self.assertRaises(RuntimeError), observer.phases.track("history"):
                self.fail("Overlapping phases were accepted")
            self.assertIn(
                'ci_observability_phase_active{phase="poll"} 1\n',
                observer.phases.render(),
            )

    def test_loop_diagnostics_distinguish_failed_poll_from_pending_work(self):
        observer = Collector(self.store, FakeGitHub({}, {}), {}, "http://unused")
        with (
            patch.object(
                observer, "poll", side_effect=RuntimeError("GitHub unavailable")
            ),
            patch.object(observer, "collect_pending") as pending,
            patch.object(observer, "history"),
            patch("time.sleep", side_effect=KeyboardInterrupt),
            self.assertRaises(KeyboardInterrupt),
        ):
            observer.run()
        metrics = observer.render_metrics().decode()
        self.assertEqual(pending.call_count, 1)
        self.assertEqual(observer.errors, 1)
        self.assertEqual(observer.last_poll, 0)
        for phase_name, outcome in (
            ("poll", "error"),
            ("history", "success"),
            ("pending_backfill", "success"),
            ("sleep", "interrupted"),
        ):
            self.assertIn(
                f'ci_observability_phase_completions_total{{outcome="{outcome}",phase="{phase_name}"}} 1\n',
                metrics,
            )
        self.assertIn(
            'ci_observability_phase_completions_total{outcome="success",phase="pending_live"} 0\n',
            metrics,
        )

    def test_successful_loop_preserves_poll_heartbeat_and_phase_order(self):
        api = FakeGitHub({}, {})
        observer = Collector(self.store, api, {}, "http://unused")
        with (
            patch.object(api, "pages", return_value=iter([])),
            patch.object(api, "runs", return_value=iter([]), create=True),
            patch.object(observer, "history"),
            patch("time.sleep", side_effect=KeyboardInterrupt),
            self.assertRaises(KeyboardInterrupt),
        ):
            observer.run()
        self.assertGreater(observer.last_poll, 0)
        self.assertEqual(observer.errors, 0)
        metrics = observer.render_metrics().decode()
        for phase_name in (
            "poll",
            "pending_live",
            "history",
            "pending_backfill",
            "prune",
            "loki",
        ):
            self.assertIn(
                f'ci_observability_phase_completions_total{{outcome="success",phase="{phase_name}"}} 1\n',
                metrics,
            )
        self.assertIn(
            'ci_observability_phase_completions_total{outcome="success",phase="refresh"} 2\n',
            metrics,
        )

    def test_active_queued_jobs_keep_architecture_pool_role_and_event(self):
        active_run, queued = run(), job()
        active_run["status"] = "in_progress"
        queued.update(
            status="queued",
            labels=["arc-arm64-tmpfs-large"],
            runner_name="",
            started_at=None,
            completed_at=None,
            steps=[],
        )
        api = FakeGitHub({}, {})

        def pages(path, key, conditional=False):
            if "/attempts/" in path:
                return iter([queued])
            return iter([active_run] if path.endswith("status=in_progress") else [])

        observer = Collector(
            self.store, api, {"temporal-worker-images.yml": []}, "http://unused"
        )
        with (
            patch.object(api, "pages", side_effect=pages),
            patch.object(api, "runs", return_value=iter([]), create=True),
        ):
            observer.poll(self.now)
        line = next(
            x
            for x in observer.active_metrics.splitlines()
            if x.startswith("ci_jobs_active")
        )
        for value in (
            'architecture="arm64"',
            'runner_pool="arc"',
            'job_role="build"',
            'event="push"',
            'state="queued"',
        ):
            self.assertIn(value, line)
        self.assertTrue(observer.last_poll > 0)

    def test_running_build_age_disappears_after_completion(self):
        active_run, running = run(), job()
        active_run["status"] = "in_progress"
        running.update(status="in_progress", completed_at=None, steps=[])
        api = FakeGitHub({}, {})

        def pages(path, key, conditional=False):
            if "/attempts/" in path:
                return iter([running])
            return iter([active_run] if path.endswith("status=in_progress") else [])

        observer = Collector(
            self.store, api, {"temporal-worker-images.yml": []}, "http://unused"
        )
        with (
            patch.object(api, "pages", side_effect=pages),
            patch.object(api, "runs", return_value=iter([]), create=True),
            patch.object(observer, "collect_job"),
        ):
            observer.poll(self.now)
            expected = self.now - timestamp(running["started_at"])
            self.assertIn("ci_job_oldest_execution_seconds", observer.active_metrics)
            self.assertTrue(
                any(
                    line.endswith(f" {expected}")
                    for line in observer.active_metrics.splitlines()
                    if line.startswith("ci_job_oldest_execution_seconds")
                )
            )
            running["status"] = "completed"
            observer.poll(self.now)
            self.assertNotIn("ci_job_oldest_execution_seconds", observer.active_metrics)
            self.assertNotIn(
                "ci_job_current_phase_age_seconds", observer.active_metrics
            )

    def test_active_phase_distinguishes_artifact_upload_from_github_finalization(self):
        active_run, running = run(), job()
        active_run["status"] = "in_progress"
        running.update(status="in_progress", completed_at=None)
        upload = {
            "name": "Upload Nix OCI log artifact",
            "status": "in_progress",
            "started_at": "2026-10-25T12:29:00Z",
            "completed_at": None,
        }
        running["steps"] = [upload]
        api = FakeGitHub({}, {})

        def pages(path, key, conditional=False):
            if "/attempts/" in path:
                return iter([running])
            return iter([active_run] if path.endswith("status=in_progress") else [])

        observer = Collector(
            self.store, api, {"temporal-worker-images.yml": []}, "http://unused"
        )
        with (
            patch.object(api, "pages", side_effect=pages),
            patch.object(api, "runs", return_value=iter([]), create=True),
        ):
            for expected_phase, age in [("artifacts", 360), ("finalizing", 240)]:
                with self.subTest(phase=expected_phase):
                    observer.poll(self.now)
                    line = next(
                        x
                        for x in observer.active_metrics.splitlines()
                        if x.startswith("ci_job_current_phase_age_seconds")
                    )
                    self.assertIn(f'phase="{expected_phase}"', line)
                    self.assertEqual(float(line.rsplit(" ", 1)[1]), age)
                    self.assertNotIn(upload["name"], line)
                    self.assertIn(
                        "ci_job_oldest_execution_seconds", observer.active_metrics
                    )
                upload.update(status="completed", completed_at="2026-10-25T12:31:00Z")

    def test_missing_steps_keep_whole_job_and_unattributed_phase_visible(self):
        active_run, running = run(), job()
        active_run["status"] = "in_progress"
        running.update(status="in_progress", completed_at=None, steps=[])
        api = FakeGitHub({}, {})

        def pages(path, key, conditional=False):
            if "/attempts/" in path:
                return iter([running])
            return iter([active_run] if path.endswith("status=in_progress") else [])

        observer = Collector(
            self.store, api, {"temporal-worker-images.yml": []}, "http://unused"
        )
        with (
            patch.object(api, "pages", side_effect=pages),
            patch.object(api, "runs", return_value=iter([]), create=True),
        ):
            observer.poll(self.now)
        age = self.now - timestamp(running["started_at"])
        lines = observer.active_metrics.splitlines()
        for metric in (
            "ci_job_oldest_execution_seconds",
            "ci_job_current_phase_age_seconds",
        ):
            line = next(x for x in lines if x.startswith(metric))
            self.assertTrue(line.endswith(f" {age}"), line)
        self.assertIn('phase="unattributed"', observer.active_metrics)

    def test_finished_job_is_collected_before_its_workflow_finishes(self):
        active_run = run()
        active_run["status"] = "in_progress"
        api = FakeGitHub({1: run()}, {1: [job()]})

        def pages(path, key, conditional=False):
            if "/attempts/" in path:
                return iter([job()])
            return iter([active_run] if path.endswith("status=in_progress") else [])

        observer = Collector(
            self.store, api, {"temporal-worker-images.yml": []}, "http://unused"
        )
        with (
            patch.object(api, "pages", side_effect=pages),
            patch.object(api, "runs", return_value=iter([]), create=True),
            patch.object(api, "log", wraps=api.log) as download,
            patch("time.time", return_value=self.now),
        ):
            observer.poll(self.now)
            download.assert_not_called()
            self.assertEqual(observer.last_poll, self.now)
            self.assertEqual(
                self.store.db.execute("SELECT COUNT(*) FROM jobs").fetchone()[0], 0
            )
            self.store.db.close()
            self.store = Store(self.path)
            observer = Collector(self.store, api, observer.families, "http://unused")
            observer.collect_pending(time.monotonic() + 20)
            download.assert_called_once_with(job()["id"])
        record = json.loads(
            self.store.db.execute("SELECT record FROM jobs").fetchone()[0]
        )
        self.assertEqual(record["cache"]["state"], "warm")
        self.assertEqual(
            self.store.db.execute("SELECT COUNT(*) FROM attempts").fetchone()[0], 0
        )
        self.store.discover(run(), self.now)
        observer.collect_pending(time.monotonic() + 20)
        self.assertEqual(
            self.store.db.execute("SELECT COUNT(*) FROM jobs").fetchone()[0], 1
        )
        metrics = self.store.render(self.now)
        completed = [
            line
            for line in metrics.splitlines()
            if line.startswith("ci_jobs_completed{")
        ]
        self.assertTrue(completed)
        self.assertTrue(all(line.endswith(" 1") for line in completed))

    def test_pending_drains_oldest_live_attempts_even_as_new_ones_arrive(self):
        api = FakeGitHub({}, {})
        api.remaining = 1999
        observer = Collector(
            self.store, api, {"temporal-worker-images.yml": []}, "http://unused"
        )
        self.store.installed_at = timestamp("2026-10-24T00:00:00Z")
        attempts = {
            run_id: run() | {"id": run_id, "updated_at": updated}
            for run_id, updated in (
                (1, "2026-10-23T12:00:00Z"),  # Backfill must wait for quota.
                (2, "2026-10-24T12:00:00Z"),
                (3, "2026-10-25T12:00:00Z"),
                (4, "2026-10-25T12:30:00Z"),
            )
        }
        for run_id in (1, 2, 3):
            self.store.discover(attempts[run_id], self.now)
        clock = [self.now]

        def get(path):
            clock[0] += 20  # Only one attempt fits in this slice.
            return attempts[int(path.split("/")[2])]

        with (
            patch.object(api, "get", side_effect=get),
            patch.object(api, "pages", return_value=iter([])),
            patch("time.time", side_effect=lambda: clock[0]),
            patch("time.monotonic", side_effect=lambda: clock[0]),
        ):
            observer.collect_pending(clock[0] + 20)
            self.store.discover(attempts[4], self.now)
            observer.collect_pending(clock[0] + 20)
            states = dict(self.store.db.execute("SELECT run_id, state FROM attempts"))
            self.assertEqual(
                states, {1: "pending", 2: "complete", 3: "complete", 4: "pending"}
            )
            age = self.now - timestamp(attempts[4]["updated_at"])
            self.assertIn(
                f"ci_observability_oldest_live_pending_seconds {age}\n",
                self.store.render(self.now),
            )
            observer.collect_pending(clock[0] + 40)
            self.assertEqual(self.store.pending()["run_id"], 1)
            api.remaining = 2000
            observer.collect_pending(clock[0] + 20)
            self.assertIsNone(self.store.pending())

    def test_pending_retries_a_blocked_attempt_without_holding_up_the_queue(self):
        older = run() | {"id": 1, "updated_at": "2026-10-25T11:00:00Z"}
        newer = run() | {"id": 2}
        for attempt in (older, newer):
            self.store.discover(attempt, self.now)
        api = FakeGitHub({}, {})
        observer = Collector(
            self.store, api, {"temporal-worker-images.yml": []}, "http://unused"
        )
        with (
            patch.object(
                api,
                "get",
                side_effect=[RuntimeError("Attempt not ready"), newer, older],
            ) as request,
            patch.object(api, "pages", return_value=iter([])),
        ):
            with self.assertRaisesRegex(RuntimeError, "Attempt not ready"):
                observer.collect_pending(time.monotonic() + 20)
            observer.collect_pending(time.monotonic() + 20)
        self.assertEqual(
            [call.args[0].split("/")[2] for call in request.call_args_list],
            ["1", "2", "1"],
        )
        self.assertIsNone(self.store.pending())

    def test_slow_historical_discovery_cannot_starve_pending_attempts(self):
        api = FakeGitHub({1: run()}, {1: [job()]})
        observer = Collector(
            self.store, api, {"temporal-worker-images.yml": []}, "http://unused"
        )
        self.store.discover(run(), self.now)
        clock = [self.now]

        def slow_history(_now):
            clock[0] += 46

        with (
            patch("time.time", side_effect=lambda: clock[0]),
            patch("time.sleep", side_effect=StopIteration),
            patch.object(observer, "poll"),
            patch.object(observer, "history", side_effect=slow_history),
            patch.object(
                observer, "flush", side_effect=RuntimeError("Loki unavailable")
            ),
        ):
            with self.assertRaises(StopIteration):
                observer.run()
        self.assertEqual(
            self.store.db.execute("SELECT COUNT(*) FROM jobs").fetchone()[0], 1
        )
        self.assertEqual(
            self.store.db.execute(
                "SELECT COUNT(*) FROM attempts WHERE state='complete'"
            ).fetchone()[0],
            1,
        )

    def test_history_budget_resumes_busy_day_without_restarting_its_search(self):
        api = FakeGitHub({}, {})
        observer = Collector(
            self.store, api, {"temporal-worker-images.yml": []}, "http://unused"
        )
        clock = [self.now]

        def runs(*_args):
            for index in range(3):
                clock[0] += 6
                yield run() | {"id": 100 + index}

        with (
            patch.object(api, "runs", side_effect=runs, create=True) as discovery,
            patch("time.time", side_effect=lambda: clock[0]),
        ):
            observer.history(self.now, days=1, windows=1)
            self.assertEqual(observer.history_day, 0)
            self.assertEqual(observer.last_history_progress, self.now + 12)
            self.assertEqual(
                self.store.db.execute("SELECT COUNT(*) FROM attempts").fetchone()[0],
                2,
            )
            observer.history(self.now, days=1, windows=1)
        discovery.assert_called_once()
        self.assertEqual(observer.history_day, 1)
        self.assertEqual(observer.last_history, self.now + 18)
        self.assertEqual(observer.last_history_progress, self.now + 18)
        self.assertEqual(
            self.store.db.execute("SELECT COUNT(*) FROM attempts").fetchone()[0], 3
        )

    def test_history_reserves_foreground_quota_and_resumes_its_existing_iterator(self):
        api = FakeGitHub({}, {})
        api.remaining = 1999
        observer = Collector(
            self.store, api, {"temporal-worker-images.yml": []}, "http://unused"
        )
        fetched = []

        def runs(*_args):
            for index in range(2):
                fetched.append(index)
                if index == 0:
                    api.remaining = 1999
                yield run() | {"id": 100 + index}

        with (
            patch.object(api, "runs", side_effect=runs, create=True) as discovery,
            patch("time.time", return_value=self.now),
        ):
            observer.history(self.now, days=1, windows=1)
            self.assertEqual(fetched, [])
            self.assertEqual(observer.last_history_progress, 0)
            api.remaining = 2000
            observer.history(self.now, days=1, windows=1)
            self.assertEqual(fetched, [0])
            self.assertEqual(observer.history_day, 0)
            api.remaining = 4999
            observer.history(self.now, days=1, windows=1)
        discovery.assert_called_once()
        self.assertEqual(fetched, [0, 1])
        self.assertEqual(observer.history_day, 1)
        self.assertEqual(observer.last_history, self.now)
        self.assertEqual(
            self.store.db.execute("SELECT COUNT(*) FROM attempts").fetchone()[0], 2
        )

    def test_foreground_poll_keeps_running_inside_the_history_quota_reserve(self):
        api = GitHub("unused")
        api.remaining, api.reset_at = 1500, self.now + 3600
        observer = Collector(self.store, api, {}, "http://unused")

        def response(*_args, **_kwargs):
            value = io.BytesIO(
                json.dumps({"total_count": 0, "workflow_runs": []}).encode()
            )
            value.headers = {
                "X-RateLimit-Remaining": "1499",
                "X-RateLimit-Reset": str(int(self.now + 3600)),
            }
            return value

        with (
            patch.object(api.opener, "open", side_effect=response) as request,
            patch("time.time", return_value=self.now),
        ):
            observer.history(self.now, days=1, windows=1)
            request.assert_not_called()
            observer.poll(self.now)
        self.assertEqual(observer.last_poll, self.now)
        self.assertEqual(request.call_count, 6)
        self.assertEqual(api.remaining, 1499)

    def test_search_over_1000_results_is_split_without_silently_truncating(self):
        api = GitHub("unused")
        requests = []

        def get(path, conditional=False):
            requests.append(path)
            return {
                "total_count": 1001 if len(requests) == 1 else 1,
                "workflow_runs": [run()],
            }

        with patch.object(api, "get", side_effect=get):
            values = list(api.runs("2026-10-25T00:00:00Z", "2026-10-25T23:59:59Z"))
        self.assertEqual(len(values), 2)
        self.assertEqual(len(requests), 3)

    def test_conditional_api_requests_reuse_sanitized_data_on_304(self):
        api = GitHub("secret-token")
        response = io.BytesIO(
            json.dumps(
                {
                    "total_count": 1,
                    "workflow_runs": [run() | {"actor": {"email": "not-retained"}}],
                }
            ).encode()
        )
        response.headers = {"ETag": '"version-one"', "X-RateLimit-Remaining": "4800"}
        unchanged = urllib.error.HTTPError(
            "https://api.github.com/unused", 304, "not modified", {}, io.BytesIO()
        )
        with patch.object(
            api.opener, "open", side_effect=[response, unchanged]
        ) as request:
            first = api.get("actions/runs", True)
            self.assertEqual(api.get("actions/runs", True), first)
        self.assertEqual(
            request.call_args_list[1].args[0].get_header("If-none-match"),
            '"version-one"',
        )
        self.assertNotIn("actor", first["workflow_runs"][0])

    def test_signed_log_redirect_receives_no_api_credentials(self):
        api = GitHub("secret-token")
        redirect = urllib.error.HTTPError(
            "https://api.github.com/unused",
            302,
            "found",
            {"Location": "https://logs.example.invalid/signed"},
            io.BytesIO(),
        )
        with patch.object(api.opener, "open", side_effect=redirect):
            with patch(
                "urllib.request.urlopen", return_value=io.BytesIO(b"build output")
            ) as request:
                self.assertEqual(api.log(123), "build output")
        self.assertEqual(
            request.call_args.args[0], "https://logs.example.invalid/signed"
        )

    def test_shared_api_quota_reserve_prevents_observer_exhausting_arc_auth(self):
        api = GitHub("unused")
        api.remaining, api.reset_at = 999, self.now + 3600
        with patch("time.time", return_value=self.now):
            with patch.object(api.opener, "open") as request:
                with self.assertRaisesRegex(RuntimeError, "quota reserve"):
                    api.get("actions/runs")
                request.assert_not_called()

    def test_collection_latency_excludes_initial_backfill_and_survives_restart(self):
        installed = timestamp("2026-10-25T12:30:00Z")
        self.store.db.close()
        self.path.unlink()
        with patch("time.time", return_value=installed):
            self.store = Store(self.path)
        with patch("time.time", return_value=installed + 120):
            self.store.save_job(job_record(run(), job()), cache_evidence(""))
        record = json.loads(
            self.store.db.execute("SELECT record FROM jobs").fetchone()[0]
        )
        self.assertEqual(record["collection_mode"], "live")
        self.assertEqual(record["collection_delay_seconds"], 45)
        self.assertIn(
            "ci_job_collection_delay_seconds_count", self.store.render(installed + 120)
        )
        self.store.db.close()
        self.store = Store(self.path)
        self.assertEqual(self.store.installed_at, installed)

    def test_metrics_scrape_keeps_collection_delay_totals_without_buckets(self):
        record = job_record(run(), job())
        self.store.installed_at = timestamp("2026-10-25T12:30:00Z")
        with self.store.db:
            self.store.db.execute(
                "INSERT INTO aggregates VALUES (?, ?, ?, ?, ?)",
                (
                    "ci_job_collection_delay_seconds",
                    json.dumps(labels(record), sort_keys=True),
                    2,
                    90,
                    json.dumps([0] * 4 + [2] * 9),
                ),
            )
        observer = Collector(self.store, FakeGitHub({}, {}), {}, "http://unused")
        observer.last_poll = self.now - 30
        with patch("time.time", return_value=self.now):
            self.store.save_job(record, cache_evidence(""))
            backfill_job = job(2) | {"completed_at": "2026-10-25T12:29:59Z"}
            self.store.save_job(job_record(run(2), backfill_job), cache_evidence(""))
            self.store.discover(run(), self.now)
            observer.refresh()

        with ThreadingHTTPServer(("127.0.0.1", 0), metrics_handler(observer)) as server:
            worker = threading.Thread(target=server.serve_forever)
            worker.start()
            try:
                with urllib.request.urlopen(
                    f"http://127.0.0.1:{server.server_port}/metrics", timeout=5
                ) as response:
                    metrics = response.read().decode()
            finally:
                server.shutdown()
                worker.join()

        self.assertIn(
            f"ci_observability_last_poll_timestamp_seconds {self.now - 30}\n", metrics
        )
        self.assertIn("ci_observability_oldest_live_pending_seconds 131.0\n", metrics)
        actual = [
            (line.split("{", 1)[0], float(line.rsplit(" ", 1)[1]))
            for line in metrics.splitlines()
            if line.startswith("ci_job_collection_delay_seconds_")
        ]
        self.assertCountEqual(
            actual,
            [
                ("ci_job_collection_delay_seconds_count", 3),
                ("ci_job_collection_delay_seconds_sum", 315),
            ],
        )

    def test_signed_log_failure_cannot_discard_completed_job_timings(self):
        api = FakeGitHub({}, {})
        observer = Collector(
            self.store, api, {"temporal-worker-images.yml": []}, "http://unused"
        )
        error = urllib.error.HTTPError(
            "https://logs.example.invalid/signed", 404, "expired", {}, io.BytesIO()
        )
        with (
            patch.object(api, "log", side_effect=error),
            patch("time.time", return_value=self.now),
        ):
            observer.collect_job(job_record(run(), job()), time.monotonic() + 10)
        record = json.loads(
            self.store.db.execute("SELECT record FROM jobs").fetchone()[0]
        )
        self.assertEqual(record["durations"]["execution"], 239)
        self.assertEqual(record["cache"]["state"], "unknown")
        self.assertEqual(record["cache"]["reason"], "download_failed")
        self.assertEqual(observer.cache_errors, 1)

    def test_slow_log_cannot_consume_more_than_the_pending_budget(self):
        api = FakeGitHub({}, {})
        observer = Collector(
            self.store, api, {"temporal-worker-images.yml": []}, "http://unused"
        )
        self.store.defer_job(job_record(run(), job()), self.now)

        def slow_log(job_id):
            time.sleep(0.3)
            return "build output"

        with patch.object(api, "log", side_effect=slow_log) as download:
            observer.collect_pending(time.monotonic() + 0.1)
        download.assert_called_once_with(job()["id"])
        record = json.loads(
            self.store.db.execute("SELECT record FROM jobs").fetchone()[0]
        )
        self.assertEqual(record["durations"]["execution"], 239)
        self.assertEqual(record["cache"]["reason"], "collection_budget")
        self.assertEqual(observer.cache_errors, 1)
        self.assertIsNone(self.store.pending_job())

    def test_expired_unacknowledged_records_cannot_block_new_loki_delivery(self):
        first, second = job_record(run(), job()), job_record(run(), job())
        self.store.save_job(first, cache_evidence(""))
        old_stamp = str(int((self.now - 8 * 86400) * 1e9))
        self.store.db.execute("UPDATE outbox SET stamp=?", (old_stamp,))
        self.store.db.commit()
        second["job_id"] += 100
        with (
            patch("time.time", return_value=self.now),
            patch("time.time_ns", return_value=int(self.now * 1e9)),
        ):
            self.store.save_job(second, cache_evidence(""))
        observer = Collector(self.store, FakeGitHub({}, {}), {}, "http://unused")
        with (
            patch("time.time", return_value=self.now),
            patch("urllib.request.urlopen", return_value=io.BytesIO()) as request,
        ):
            observer.flush()
        body = json.loads(request.call_args.args[0].data)
        delivered = [
            json.loads(line)["job_id"]
            for stream in body["streams"]
            for _, line in stream["values"]
        ]
        self.assertEqual(delivered, [second["job_id"]])
        rejected = self.store.db.execute(
            "SELECT stamp, line, reason FROM loki_rejections"
        ).fetchone()
        self.assertEqual(rejected["stamp"], old_stamp)
        self.assertEqual(json.loads(rejected["line"])["job_id"], first["job_id"])
        self.assertEqual(rejected["reason"], "expired_unacknowledged")
        self.assertEqual(
            self.store.db.execute("SELECT COUNT(*) FROM jobs").fetchone()[0], 2
        )
        self.assertEqual(
            self.store.db.execute("SELECT COUNT(*) FROM outbox").fetchone()[0], 0
        )

    def test_permanent_loki_rejection_isolates_only_the_bad_record(self):
        first, second = job_record(run(), job()), job_record(run(), job())
        self.store.save_job(first, cache_evidence(""))
        second["job_id"] += 100
        self.store.save_job(second, cache_evidence(""))
        observer = Collector(self.store, FakeGitHub({}, {}), {}, "http://unused")
        received = []

        def deliver(request, timeout):
            body = json.loads(request.data)
            ids = [
                json.loads(line)["job_id"]
                for stream in body["streams"]
                for _, line in stream["values"]
            ]
            received.append(ids)
            if first["job_id"] in ids:
                raise urllib.error.HTTPError(
                    "http://loki.invalid", 400, "out of order", {}, io.BytesIO()
                )
            return io.BytesIO()

        with patch("urllib.request.urlopen", side_effect=deliver):
            observer.flush()
        self.assertEqual(received[-1], [second["job_id"]])
        rejected = self.store.db.execute(
            "SELECT line, reason FROM loki_rejections"
        ).fetchone()
        self.assertEqual(json.loads(rejected["line"])["job_id"], first["job_id"])
        self.assertEqual(rejected["reason"], "loki_http_400")
        self.assertEqual(
            self.store.db.execute("SELECT COUNT(*) FROM outbox").fetchone()[0], 0
        )


if __name__ == "__main__":
    unittest.main()
