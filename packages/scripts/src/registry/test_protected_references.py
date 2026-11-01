import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

import protected_references as protection


class ProtectedReferencesTest(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.fail_resource = None
        self.registry = "registry.ide-newton.ts.net/lab/"
        self.idle = self.registry + "anypi:0123456789@sha256:" + "a" * 64
        self.pending = self.registry + "runner:0123456789@sha256:" + "d" * 64
        self.objects = {
            "agentproviders.agents.proompteng.ai": [
                {"kind": "AgentProvider", "spec": {"workload": {"image": self.idle}}}
            ],
            "agentruns.agents.proompteng.ai": [
                {"kind": "AgentRun", "spec": {"workload": {"image": self.pending}}}
            ],
            "tools.tools.proompteng.ai": [
                {"kind": "Tool", "spec": {"image": self.registry + "tool:retained"}}
            ],
            "applications.argoproj.io": [
                {
                    "spec": {
                        "sources": [
                            {
                                "helm": {
                                    "valuesObject": {
                                        "template": {
                                            "spec": {
                                                "containers": [
                                                    {
                                                        "image": self.registry
                                                        + "helm-runner:retained"
                                                    }
                                                ]
                                            }
                                        }
                                    }
                                }
                            }
                        ]
                    }
                }
            ],
            "workflowtemplates.argoproj.io": [
                {
                    "spec": {
                        "templates": [
                            {"container": {"image": self.registry + "worker:retained"}}
                        ]
                    }
                }
            ],
            "services.serving.knative.dev": [
                {
                    "spec": {
                        "template": {
                            "spec": {
                                "containers": [
                                    {"image": self.registry + "scaled-to-zero:retained"}
                                ]
                            }
                        }
                    }
                }
            ],
            "clusterimagecatalogs.postgresql.cnpg.io": [
                {"spec": {"images": [{"image": self.registry + "postgres:retained"}]}}
            ],
            "freights.kargo.akuity.io": [
                {
                    "metadata": {"namespace": "other-delivery"},
                    "images": [
                        {
                            "repoURL": self.registry + "release",
                            "tag": "retained",
                            "digest": "sha256:" + "b" * 64,
                        }
                    ],
                }
            ],
            "stages.kargo.akuity.io": [
                {
                    "status": {
                        "freightHistory": [
                            {
                                "images": [
                                    {
                                        "repoURL": self.registry + "stage",
                                        "tag": "retained",
                                    }
                                ]
                            }
                        ]
                    }
                }
            ],
            "promotions.kargo.akuity.io": [
                {"status": {"image": self.registry + "promotion@sha256:" + "c" * 64}}
            ],
        }
        for resource in [
            "analysistemplates",
            "clusteranalysistemplates",
            "analysisruns",
        ]:
            self.objects[resource + ".argoproj.io"] = [
                {
                    "spec": {
                        "metrics": [
                            {
                                "provider": {
                                    "job": {
                                        "spec": {
                                            "template": {
                                                "spec": {
                                                    "containers": [
                                                        {
                                                            "image": self.registry
                                                            + resource
                                                            + ":retained"
                                                        }
                                                    ]
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        ]
                    }
                }
            ]
        for resource in [
            "autoscalingrunnersets",
            "ephemeralrunnersets",
            "ephemeralrunners",
        ]:
            self.objects[resource + ".actions.github.com"] = [
                {
                    "spec": {
                        "template": {
                            "spec": {
                                "containers": [
                                    {"image": self.registry + resource + ":retained"}
                                ]
                            }
                        }
                    }
                }
            ]
        self.objects["images.caching.internal.knative.dev"] = [
            {"spec": {"image": self.registry + "knative-cache:retained"}}
        ]

    def read(self, args, **kwargs):
        self.calls.append(args)
        self.assertEqual(args[:3], ["kubectl", "--context", "fixture"])
        resources = args[args.index("get") + 1]
        self.assertIn("--all-namespaces", args)
        if self.fail_resource and self.fail_resource in resources.split(","):
            raise subprocess.CalledProcessError(1, args)
        if resources == "pods":
            return b'{"items":[{"spec":{"containers":[{"image":"registry.ide-newton.ts.net/lab/running:latest"}]}}]}'
        return json.dumps(
            {
                "items": [
                    row
                    for name in resources.split(",")
                    for row in self.objects.get(name, [])
                ]
            }
        ).encode()

    def test_idle_provider_is_protected_without_a_pod_or_job(self):
        with patch.object(protection.subprocess, "check_output", side_effect=self.read):
            result = protection.references("fixture")
        self.assertIn(self.idle, result)
        self.assertIn(self.registry + "running:latest", result)

    def test_pending_agentrun_image_override_is_protected_without_a_pod_or_job(self):
        with patch.object(protection.subprocess, "check_output", side_effect=self.read):
            result = protection.references("fixture")
        self.assertIn(self.pending, result)

    def test_idle_tool_image_is_protected_without_a_pod_or_job(self):
        with patch.object(protection.subprocess, "check_output", side_effect=self.read):
            result = protection.references("fixture")
        self.assertIn(self.registry + "tool:retained", result)

    def test_analysis_jobs_are_protected_before_a_job_or_pod_exists(self):
        with patch.object(protection.subprocess, "check_output", side_effect=self.read):
            result = protection.references("fixture")
        for resource in [
            "analysistemplates",
            "clusteranalysistemplates",
            "analysisruns",
        ]:
            self.assertIn(self.registry + resource + ":retained", result)

    def test_helm_application_values_are_protected_before_workload_creation(self):
        with patch.object(protection.subprocess, "check_output", side_effect=self.read):
            result = protection.references("fixture")
        self.assertIn(self.registry + "helm-runner:retained", result)

    def test_runner_retries_and_knative_cache_images_are_protected_without_pods(self):
        with patch.object(protection.subprocess, "check_output", side_effect=self.read):
            result = protection.references("fixture")
        for image in [
            "autoscalingrunnersets",
            "ephemeralrunnersets",
            "ephemeralrunners",
            "knative-cache",
        ]:
            self.assertIn(self.registry + image + ":retained", result)

    def test_templates_scale_to_zero_catalogs_and_kargo_in_other_namespaces_are_protected(
        self,
    ):
        with patch.object(protection.subprocess, "check_output", side_effect=self.read):
            result = protection.references("fixture")
        for image in (
            "worker:retained",
            "scaled-to-zero:retained",
            "postgres:retained",
            "release:retained",
            "release@sha256:" + "b" * 64,
            "stage:retained",
            "promotion@sha256:" + "c" * 64,
        ):
            self.assertIn(self.registry + image, result)
        self.assertEqual(result, sorted(set(result)))

    def test_each_required_source_failure_aborts_the_entire_snapshot(self):
        for group, resources in protection.RESOURCES.items():
            for resource in resources:
                self.fail_resource = resource + ("." + group if group else "")
                with self.subTest(resource=self.fail_resource):
                    with patch.object(
                        protection.subprocess, "check_output", side_effect=self.read
                    ):
                        with self.assertRaises(subprocess.CalledProcessError):
                            protection.references("fixture")

    def test_cleanup_does_not_discover_or_read_unrelated_custom_resources(self):
        def denied(args, **kwargs):
            if "customresourcedefinitions" in args or "valkey.buf.red" in " ".join(
                args
            ):
                raise subprocess.CalledProcessError(1, args)
            return self.read(args, **kwargs)

        with patch.object(protection.subprocess, "check_output", side_effect=denied):
            result = protection.references("fixture")
        self.assertIn(self.idle, result)
        sources = json.loads(
            Path(__file__).with_name("protected_resources.json").read_text()
        )
        expected = {
            resource + ("." + group if group else "")
            for group, resources in sources.items()
            for resource in resources
        }
        queried = {
            resource
            for args in self.calls
            for resource in args[args.index("get") + 1].split(",")
        }
        self.assertEqual(queried, expected)

    def test_empty_snapshot_aborts_cleanup(self):
        with patch.object(
            protection.subprocess, "check_output", return_value=b'{"items":[]}'
        ):
            with self.assertRaisesRegex(RuntimeError, "No protected references"):
                protection.references("fixture")


if __name__ == "__main__":
    unittest.main()
