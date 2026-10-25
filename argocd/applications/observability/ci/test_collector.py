import json
import io
import pathlib
import tempfile
import threading
import unittest
import urllib.error
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest.mock import patch

from collector import (
    Collector,
    GitHub,
    Store,
    cache_evidence,
    job_record,
    phase,
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

    def test_real_step_names_separate_setup_build_publication_and_validation(self):
        expected = {
            "Set up job": "runner_setup",
            "Run actions/checkout@v6": "checkout",
            "Run ./.github/actions/setup-buildkit": "toolchain",
            "Build Nix image archive": "build",
            "Build runtime": "build",
            "Push platform image without Docker": "publish",
            "Assemble and validate the immutable release index": "publish",
            "Retain SDK heartbeat proof": "verify",
            "Post Build runtime": "cleanup",
        }
        for name, value in expected.items():
            with self.subTest(name=name):
                self.assertEqual(phase(name), value)

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
            observer.collect_attempt(pending)
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
        self.assertIn('outcome="failure",workflow=', text)
        self.assertNotIn(
            "not-retained",
            self.store.db.execute("SELECT run FROM attempts").fetchone()[0],
        )
        self.assertEqual(
            self.store.db.execute("SELECT COUNT(*) FROM outbox").fetchone()[0], 2
        )

    def test_rolling_comparisons_use_event_time_and_keep_cache_cohorts_separate(self):
        for offset, state in [(0, "warm"), (1, "cold"), (2, "warm")]:
            record = job_record(run(), job())
            record["job_id"] += offset
            if offset == 2:
                record["completed_at"] = "2026-10-24T12:31:15Z"
            self.store.save_job(
                record, {"state": state, "source": "test", "durations": {}}
            )
        text = self.store.render(self.now)
        self.assertIn('cache_state="warm"', text)
        self.assertIn('cache_state="cold"', text)
        self.assertIn('window="7d_baseline"', text)
        self.assertIn('window="1h"', text)

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

    def test_failed_active_poll_does_not_advance_success_heartbeat(self):
        api = FakeGitHub({}, {})
        observer = Collector(self.store, api, {}, "http://unused")
        with patch.object(
            api, "pages", side_effect=RuntimeError("GitHub API returned HTTP 403")
        ):
            with self.assertRaises(RuntimeError):
                observer.poll(self.now)
        self.assertEqual(observer.last_poll, 0)

    def test_active_queued_jobs_keep_architecture_pool_role_and_event(self):
        active_run, queued = run(), job()
        active_run["status"] = "in_progress"
        queued.update(
            status="queued",
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
            patch("time.time", return_value=self.now),
        ):
            observer.poll(self.now)
        self.assertEqual(
            self.store.db.execute("SELECT COUNT(*) FROM jobs").fetchone()[0], 1
        )
        self.assertEqual(
            self.store.db.execute("SELECT COUNT(*) FROM attempts").fetchone()[0], 0
        )
        self.store.discover(run(), self.now)
        observer.collect_attempt(self.store.pending())
        self.assertEqual(
            self.store.db.execute("SELECT COUNT(*) FROM jobs").fetchone()[0], 1
        )
        counts = self.store.db.execute(
            "SELECT count FROM aggregates WHERE metric='ci_job_phase_duration_seconds'"
        ).fetchall()
        self.assertTrue(all(row[0] == 1 for row in counts))

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


if __name__ == "__main__":
    unittest.main()
