from __future__ import annotations

import io
import json
import os
import tempfile
import urllib.error
from contextlib import redirect_stdout
from datetime import datetime, timezone
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch

from scripts import prune_kubernetes_residue as prune


class PruneKubernetesResidueTest(TestCase):
    def test_plan_prune_targets_only_terminal_old_sim_analysis_runs_and_ownerless_jobs(
        self,
    ) -> None:
        config = prune.PruneConfig(
            namespace="torghut",
            analysis_run_max_age_hours=168,
            ownerless_job_max_age_hours=168,
            analysis_run_prefixes=("torghut-sim-",),
            ownerless_job_prefixes=("torghut-tigerbeetle-journal-",),
            apply=False,
        )
        now = datetime(2026, 6, 30, 12, 0, tzinfo=timezone.utc)
        analysis_runs = {
            "items": [
                {
                    "metadata": {
                        "name": "torghut-sim-runtime-ready-old",
                        "creationTimestamp": "2026-06-01T00:00:00Z",
                    },
                    "status": {"phase": "Successful"},
                },
                {
                    "metadata": {
                        "name": "torghut-sim-runtime-ready-current",
                        "creationTimestamp": "2026-06-30T10:00:00Z",
                    },
                    "status": {"phase": "Failed"},
                },
                {
                    "metadata": {
                        "name": "torghut-sim-runtime-ready-running",
                        "creationTimestamp": "2026-06-01T00:00:00Z",
                    },
                    "status": {"phase": "Running"},
                },
                {
                    "metadata": {
                        "name": "other-sim-runtime-ready-old",
                        "creationTimestamp": "2026-06-01T00:00:00Z",
                    },
                    "status": {"phase": "Successful"},
                },
            ]
        }
        jobs = {
            "items": [
                {
                    "metadata": {
                        "name": "torghut-tigerbeetle-journal-execution-b1",
                        "creationTimestamp": "2026-06-02T00:00:00Z",
                    },
                    "status": {"succeeded": 1},
                },
                {
                    "metadata": {
                        "name": "torghut-tigerbeetle-journal-owned",
                        "creationTimestamp": "2026-06-02T00:00:00Z",
                        "ownerReferences": [{"kind": "CronJob", "name": "owner"}],
                    },
                    "status": {"succeeded": 1},
                },
                {
                    "metadata": {
                        "name": "torghut-paper-account-flatten-1",
                        "creationTimestamp": "2026-06-02T00:00:00Z",
                    },
                    "status": {"succeeded": 1},
                },
            ]
        }

        candidates = prune.plan_prune(analysis_runs, jobs, config=config, now=now)

        self.assertEqual(
            [(candidate.resource, candidate.name) for candidate in candidates],
            [
                ("analysisrun.argoproj.io", "torghut-sim-runtime-ready-old"),
                ("job.batch", "torghut-tigerbeetle-journal-execution-b1"),
            ],
        )

    def test_run_is_dry_by_default_and_prints_no_secret_values(self) -> None:
        class FakeClient:
            deleted_paths: list[str] = []

            def get_json(self, path: str) -> dict[str, object]:
                if path.endswith("/analysisruns"):
                    return {
                        "items": [
                            {
                                "metadata": {
                                    "name": "torghut-sim-activity-old",
                                    "creationTimestamp": "2026-06-01T00:00:00Z",
                                },
                                "status": {"phase": "Failed"},
                            }
                        ]
                    }
                if path.endswith("/jobs"):
                    return {"items": []}
                raise AssertionError(path)

            def delete(self, path: str) -> None:
                self.deleted_paths.append(path)

        fake_client = FakeClient()
        stdout = io.StringIO()
        with patch.object(
            prune.KubernetesApiClient,
            "from_service_account",
            return_value=fake_client,
        ):
            with redirect_stdout(stdout):
                exit_code = prune.run(
                    [
                        "--namespace",
                        "torghut",
                        "--analysis-run-max-age-hours",
                        "24",
                        "--json",
                    ]
                )

        self.assertEqual(exit_code, 0)
        self.assertEqual(fake_client.deleted_paths, [])
        payload = json.loads(stdout.getvalue())
        self.assertTrue(payload["dry_run"])
        self.assertEqual(payload["candidate_count"], 1)
        self.assertNotIn("token", stdout.getvalue().lower())
        self.assertNotIn("secret", stdout.getvalue().lower())

    def test_run_apply_deletes_candidates_and_reads_service_account_namespace(
        self,
    ) -> None:
        class FakeClient:
            def __init__(self) -> None:
                self.deleted_paths: list[str] = []

            def get_json(self, path: str) -> dict[str, object]:
                if path.endswith("/analysisruns"):
                    return {
                        "items": [
                            {
                                "metadata": {
                                    "name": "torghut-sim-activity-old",
                                    "creationTimestamp": "2026-06-01T00:00:00Z",
                                },
                                "status": {"phase": "Error"},
                            }
                        ]
                    }
                if path.endswith("/jobs"):
                    return {
                        "items": [
                            {
                                "metadata": {
                                    "name": "torghut-tigerbeetle-journal-fill-old",
                                    "creationTimestamp": "2026-06-01T00:00:00Z",
                                },
                                "status": {
                                    "conditions": [
                                        {"type": "Complete", "status": "True"}
                                    ]
                                },
                            }
                        ]
                    }
                raise AssertionError(path)

            def delete(self, path: str) -> None:
                self.deleted_paths.append(path)

        fake_client = FakeClient()
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, "namespace").write_text("torghut\n", encoding="utf-8")
            stdout = io.StringIO()
            with patch.object(prune, "SERVICE_ACCOUNT_ROOT", tmp):
                with patch.object(
                    prune.KubernetesApiClient,
                    "from_service_account",
                    return_value=fake_client,
                ):
                    with redirect_stdout(stdout):
                        exit_code = prune.run(["--apply"])

        self.assertEqual(exit_code, 0)
        self.assertEqual(
            fake_client.deleted_paths,
            [
                "/apis/argoproj.io/v1alpha1/namespaces/torghut/analysisruns/torghut-sim-activity-old",
                "/apis/batch/v1/namespaces/torghut/jobs/torghut-tigerbeetle-journal-fill-old",
            ],
        )
        self.assertIn("dry_run=false", stdout.getvalue())
        self.assertIn("candidate_count=2", stdout.getvalue())

    def test_config_rejects_non_positive_age_and_supports_custom_prefixes(
        self,
    ) -> None:
        args = prune._parse_args(
            [
                "--namespace",
                "torghut-dev",
                "--analysis-run-prefix",
                "custom-ar-",
                "--ownerless-job-prefix",
                "custom-job-",
                "--analysis-run-max-age-hours",
                "12",
                "--ownerless-job-max-age-hours",
                "24",
                "--apply",
            ]
        )

        config = prune._config_from_args(args)

        self.assertEqual(config.namespace, "torghut-dev")
        self.assertEqual(config.analysis_run_prefixes, ("custom-ar-",))
        self.assertEqual(config.ownerless_job_prefixes, ("custom-job-",))
        self.assertEqual(config.analysis_run_max_age_hours, 12)
        self.assertEqual(config.ownerless_job_max_age_hours, 24)
        self.assertTrue(config.apply)

        bad_args = prune._parse_args(["--analysis-run-max-age-hours", "0"])
        with self.assertRaisesRegex(RuntimeError, "positive hours"):
            prune._config_from_args(bad_args)

    def test_helper_guards_reject_malformed_or_unsafe_resources(self) -> None:
        config = prune.PruneConfig(
            namespace="torghut",
            analysis_run_max_age_hours=168,
            ownerless_job_max_age_hours=168,
            analysis_run_prefixes=("torghut-sim-",),
            ownerless_job_prefixes=("torghut-tigerbeetle-journal-",),
            apply=False,
        )
        now = datetime(2026, 6, 30, 12, 0, tzinfo=timezone.utc)

        self.assertIsNone(prune._parse_timestamp("not-a-timestamp"))
        self.assertEqual(
            prune._parse_timestamp("2026-06-30T12:00:00"),
            datetime(2026, 6, 30, 12, 0, tzinfo=timezone.utc),
        )
        self.assertEqual(prune._items({"items": "not-a-list"}), [])
        self.assertFalse(prune._is_older_than("", now=now, max_age_hours=1))
        self.assertEqual(prune._owner_references({"ownerReferences": "bad"}), [])
        self.assertFalse(prune._job_is_finished({}))
        self.assertTrue(
            prune._job_is_finished(
                {"conditions": [{"type": "Failed", "status": "True"}]}
            )
        )
        self.assertFalse(
            prune._job_is_finished({"conditions": [{"not": "a terminal condition"}]})
        )
        self.assertIsNone(
            prune._ownerless_job_candidate(
                {
                    "metadata": {
                        "name": "torghut-tigerbeetle-journal-current",
                        "creationTimestamp": "2026-06-30T11:30:00Z",
                    },
                    "status": {"failed": 1},
                },
                config=config,
                now=now,
            )
        )

    def test_api_client_uses_service_account_and_handles_delete_idempotently(
        self,
    ) -> None:
        class FakeResponse:
            def __init__(self, payload: object = None) -> None:
                self.payload = payload

            def __enter__(self) -> "FakeResponse":
                return self

            def __exit__(self, *args: object) -> None:
                return None

            def read(self) -> bytes:
                return json.dumps(self.payload).encode("utf-8")

        class FakeOpener:
            def __init__(self) -> None:
                self.requests: list[urllib.request.Request] = []
                self.delete_errors: list[urllib.error.HTTPError] = []

            def open(
                self, request: urllib.request.Request, timeout: float
            ) -> FakeResponse:
                self.requests.append(request)
                if request.get_method() == "DELETE":
                    if self.delete_errors:
                        raise self.delete_errors.pop(0)
                    return FakeResponse({})
                return FakeResponse({"items": []})

        fake_opener = FakeOpener()
        with patch.object(prune.ssl, "create_default_context", return_value=object()):
            with patch.object(
                prune.urllib.request,
                "build_opener",
                return_value=fake_opener,
            ):
                client = prune.KubernetesApiClient(
                    api_server="https://kubernetes.default/",
                    token="service-account-token",
                    ca_cert_path="/var/run/ca.crt",
                    timeout_seconds=3,
                )

        self.assertEqual(client.get_json("/apis/example"), {"items": []})
        self.assertEqual(fake_opener.requests[-1].get_method(), "GET")
        self.assertEqual(
            fake_opener.requests[-1].full_url,
            "https://kubernetes.default/apis/example",
        )
        client.delete("/apis/example/name")
        self.assertEqual(fake_opener.requests[-1].get_method(), "DELETE")
        fake_opener.delete_errors.append(
            urllib.error.HTTPError("url", 404, "missing", {}, None)
        )
        client.delete("/apis/example/missing")
        fake_opener.delete_errors.append(
            urllib.error.HTTPError("url", 500, "broken", {}, None)
        )
        with self.assertRaises(urllib.error.HTTPError):
            client.delete("/apis/example/broken")

        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, "token").write_text("token-from-file\n", encoding="utf-8")
            with patch.dict(
                os.environ,
                {
                    "KUBERNETES_SERVICE_HOST": "10.0.0.1",
                    "KUBERNETES_SERVICE_PORT": "6443",
                },
                clear=False,
            ):
                with patch.object(prune, "SERVICE_ACCOUNT_ROOT", tmp):
                    with patch.object(
                        prune.KubernetesApiClient, "__init__", return_value=None
                    ) as init:
                        prune.KubernetesApiClient.from_service_account(
                            timeout_seconds=5
                        )

        init.assert_called_once_with(
            api_server="https://10.0.0.1:6443",
            token="token-from-file",
            ca_cert_path=os.path.join(tmp, "ca.crt"),
            timeout_seconds=5,
        )

        with patch.dict(os.environ, {"KUBERNETES_SERVICE_HOST": ""}, clear=False):
            with self.assertRaisesRegex(RuntimeError, "KUBERNETES_SERVICE_HOST"):
                prune.KubernetesApiClient.from_service_account(timeout_seconds=5)

    def test_get_json_rejects_non_object_response_and_main_reports_errors(
        self,
    ) -> None:
        class FakeResponse:
            def __enter__(self) -> "FakeResponse":
                return self

            def __exit__(self, *args: object) -> None:
                return None

            def read(self) -> bytes:
                return json.dumps(["not", "an", "object"]).encode("utf-8")

        with patch.object(prune.ssl, "create_default_context", return_value=object()):
            with patch.object(
                prune.urllib.request,
                "build_opener",
                return_value=type(
                    "FakeOpener",
                    (),
                    {"open": lambda self, request, timeout: FakeResponse()},
                )(),
            ):
                client = prune.KubernetesApiClient(
                    api_server="https://kubernetes.default",
                    token="token",
                    ca_cert_path="/var/run/ca.crt",
                    timeout_seconds=3,
                )

        with self.assertRaisesRegex(RuntimeError, "kubernetes_response_not_object"):
            client.get_json("/bad")

        stderr = io.StringIO()
        with patch.object(prune, "run", side_effect=RuntimeError("boom")):
            with patch("sys.stderr", stderr):
                with self.assertRaises(SystemExit) as raised:
                    prune.main()

        self.assertEqual(raised.exception.code, 1)
        self.assertIn("torghut_kubernetes_residue_prune_error=boom", stderr.getvalue())
