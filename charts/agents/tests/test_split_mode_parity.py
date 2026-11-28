import json
import subprocess
import unittest
from pathlib import Path

import yaml

CHART = Path(__file__).resolve().parents[1]
GATEWAY = "agents-auto-ontology-mcp-gateway"
COLAB_GATEWAY = "agents-colab-mcp-gateway"
# Service, image, and API settings intentionally differ between deployments.
ROLE_SPECIFIC_ENV = {
    "AGENTS_AGENTRUN_IDEMPOTENCY_ENABLED",
    "AGENTS_AGENTRUN_IDEMPOTENCY_RETENTION_DAYS",
    "AGENTS_CONTROL_PLANE_CACHE_ENABLED",
    "AGENTS_GRPC_ENABLED",
    "AGENTS_IMAGE",
    "AGENTS_MIGRATIONS",
    "AGENTS_RUNTIME_IMAGE",
    "AGENTS_SERVER_PROFILE",
}
WEBHOOK_ENV = {
    "AGENTS_IMPLEMENTATION_SOURCE_WEBHOOK_QUEUE_SIZE": "80",
    "AGENTS_IMPLEMENTATION_SOURCE_WEBHOOK_RETRY_BASE_DELAY_SECONDS": "2",
    "AGENTS_IMPLEMENTATION_SOURCE_WEBHOOK_RETRY_MAX_DELAY_SECONDS": "16",
    "AGENTS_IMPLEMENTATION_SOURCE_WEBHOOK_RETRY_MAX_ATTEMPTS": "4",
}


class ManifestLoader(yaml.SafeLoader):
    def construct_mapping(self, node, deep=False):
        mapping = super().construct_mapping(node, deep=deep)
        if len(mapping) != len(node.value):
            raise ValueError(f"Duplicate YAML keys at {node.start_mark}")
        return mapping


def render(values, *args):
    result = subprocess.run(
        ["helm", "template", "agents", str(CHART), "--namespace", "agents", "-f", "-", *args],
        input=json.dumps(values),
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode:
        raise AssertionError(result.stderr)
    manifests = {}
    for document in yaml.load_all(result.stdout, Loader=ManifestLoader):
        if document is None:
            continue
        key = (document["kind"], document["metadata"]["name"])
        if key in manifests:
            raise AssertionError(f"Duplicate rendered resource: {key}")
        manifests[key] = document
    return manifests


class SplitModeParityTest(unittest.TestCase):
    maxDiff = None

    def env(self, manifests, deployment):
        entries = manifests["Deployment", deployment]["spec"]["template"]["spec"]["containers"][0]["env"]
        env = {entry["name"]: {key: value for key, value in entry.items() if key != "name"} for entry in entries}
        self.assertEqual(len(env), len(entries), f"Duplicate env vars in {deployment}")
        return env

    def assert_controller_parity(self, combined, split):
        ignored = ROLE_SPECIFIC_ENV | WEBHOOK_ENV.keys()
        self.assertEqual(
            {name: entry for name, entry in combined.items() if name not in ignored},
            {name: entry for name, entry in split.items() if name not in ignored},
        )

    def test_controller_defaults_match(self):
        combined = self.env(render({}), "agents")
        split = self.env(render({"controllers": {"enabled": True}}), "agents-controllers")
        self.assert_controller_parity(combined, split)
        self.assertEqual(split["AGENTS_CONTROLLER_REPO_CONCURRENCY_OVERRIDES"]["value"], "{}")

    def test_controller_overrides_match(self):
        values = {
            "database": {"secretRef": {"name": "agents-test-db", "key": "uri"}},
            "controller": {
                "repoConcurrency": {"enabled": True, "default": 3, "overrides": {"example/project": 7}},
                "jobTtlSecondsAfterFinished": 1500,
                "logRetentionSeconds": 7200,
                "agentRunArtifacts": {"max": 12, "strict": True},
                "runtimeDebrisCleanup": {
                    "mode": "audit",
                    "orphanPodRetentionSeconds": 7200,
                    "maxDeletesPerNamespace": 8,
                },
                "webhook": {"queueSize": 80, "retry": {"baseDelaySeconds": 2, "maxDelaySeconds": 16, "maxAttempts": 4}},
            },
            "agentComms": {"enabled": True, "nats": {"userSecret": {"name": "test-nats"}}},
        }
        combined = self.env(render(values), "agents")
        split_manifests = render({**values, "controllers": {"enabled": True}})
        split = self.env(split_manifests, "agents-controllers")
        control_plane = self.env(split_manifests, "agents")
        self.assert_controller_parity(combined, split)
        expected = {
            "AGENTS_AGENT_RUNNER_JOB_TTL_SECONDS": "1500",
            "AGENTS_AGENT_RUNNER_LOG_RETENTION_SECONDS": "7200",
            "AGENTS_AGENTRUN_ARTIFACTS_MAX": "12",
            "AGENTS_AGENTRUN_ARTIFACTS_STRICT": "true",
            "AGENTS_CONTROLLER_REPO_CONCURRENCY_ENABLED": "true",
            "AGENTS_CONTROLLER_REPO_CONCURRENCY_DEFAULT": "3",
            "AGENTS_CONTROLLER_REPO_CONCURRENCY_OVERRIDES": '{"example/project":7}',
            "AGENTS_CONTROLLER_RUNTIME_DEBRIS_CLEANUP_MODE": "audit",
        }
        for name, value in expected.items():
            self.assertEqual(split[name]["value"], value, name)
        for name, value in WEBHOOK_ENV.items():
            self.assertEqual(control_plane[name]["value"], value, name)
            self.assertNotIn(name, split)
        self.assertEqual(control_plane["AGENTS_CONTROLLER_ENABLED"]["value"], "0")
        self.assertEqual(split["AGENTS_CONTROLLER_ENABLED"]["value"], "1")

    def test_raw_repo_concurrency_and_retention_env_overrides_survive_split(self):
        overrides = {
            "AGENTS_CONTROLLER_REPO_CONCURRENCY_ENABLED": "true",
            "AGENTS_CONTROLLER_REPO_CONCURRENCY_DEFAULT": "5",
            "AGENTS_CONTROLLER_REPO_CONCURRENCY_OVERRIDES": '{"example/project":8}',
            "AGENTS_AGENT_RUNNER_LOG_RETENTION_SECONDS": "0",
        }
        combined = self.env(render({"env": {"vars": overrides}}), "agents")
        split = self.env(render({"controllers": {"enabled": True, "env": {"vars": overrides}}}), "agents-controllers")
        self.assert_controller_parity(combined, split)
        for name, value in overrides.items():
            self.assertEqual(split[name]["value"], value, name)

    def test_control_plane_and_controller_budgets_render_as_separate_documents(self):
        values = {
            "podDisruptionBudget": {"enabled": True},
            "controllers": {"enabled": True, "podDisruptionBudget": {"enabled": True, "maxUnavailable": 0}},
        }
        manifests = render(values)
        for name, availability in (("agents", {"minAvailable": 1}), ("agents-controllers", {"maxUnavailable": 0})):
            deployment = manifests["Deployment", name]
            budget = manifests["PodDisruptionBudget", name]
            self.assertEqual(budget["apiVersion"], "policy/v1")
            self.assertEqual(budget["spec"], {"selector": deployment["spec"]["selector"], **availability})

    def test_gateway_budget_and_scheduling(self):
        tolerations = [{"key": "dedicated", "operator": "Exists", "effect": "NoSchedule"}]
        spread = [
            {
                "maxSkew": 1,
                "topologyKey": "kubernetes.io/hostname",
                "whenUnsatisfiable": "ScheduleAnyway",
                "labelSelector": {"matchLabels": {"app.kubernetes.io/name": GATEWAY}},
            }
        ]
        gateway = {
            "enabled": True,
            "podDisruptionBudget": {"enabled": True, "maxUnavailable": "50%", "annotations": {"test": "annotation"}},
            "tolerations": tolerations,
            "topologySpreadConstraints": spread,
        }
        manifests = render({"autoOntologyMcpGateway": gateway})
        deployment = manifests["Deployment", GATEWAY]["spec"]
        budget = manifests["PodDisruptionBudget", GATEWAY]
        self.assertEqual(deployment["template"]["spec"]["tolerations"], tolerations)
        self.assertEqual(deployment["template"]["spec"]["topologySpreadConstraints"], spread)
        self.assertEqual(budget["metadata"]["annotations"], {"test": "annotation"})
        self.assertEqual(budget["spec"], {"selector": deployment["selector"], "maxUnavailable": "50%"})
        self.assertNotIn(
            ("PodDisruptionBudget", GATEWAY), render({"autoOntologyMcpGateway": {**gateway, "enabled": False}})
        )

    def test_agent_run_default_printer_columns(self):
        manifests = render({}, "--include-crds")
        versions = manifests["CustomResourceDefinition", "agentruns.agents.proompteng.ai"]["spec"]["versions"]
        columns = next(version for version in versions if version["name"] == "v1alpha1")["additionalPrinterColumns"]
        self.assertEqual(
            {column["name"]: (column["type"], column["jsonPath"]) for column in columns if not column.get("priority")},
            {
                "Phase": ("string", ".status.phase"),
                "Agent": ("string", ".spec.agentRef.name"),
                "Age": ("date", ".metadata.creationTimestamp"),
                "Job": ("string", ".status.runtimeRef.name"),
                "Head": ("string", ".status.vcs.headBranch"),
                "Blocked": ("string", '.status.conditions[?(@.type=="Blocked")].reason'),
            },
        )

    def test_colab_gateway_is_single_writer_with_gateway_only_optional_adc(self):
        self.assertNotIn(("Deployment", COLAB_GATEWAY), render({}))
        for split in (False, True):
            with self.subTest(split=split):
                manifests = render(
                    {
                        "controllers": {
                            "enabled": split,
                            "image": {"tag": "controller-test"},
                        },
                        "colabMcpGateway": {"enabled": True},
                        "autoOntologyMcpGateway": {"enabled": split},
                    }
                )
                deployment = manifests["Deployment", COLAB_GATEWAY]["spec"]
                pod = deployment["template"]["spec"]
                self.assertEqual(deployment["replicas"], 1)
                self.assertEqual(deployment["strategy"], {"type": "Recreate"})
                self.assertEqual(
                    pod["containers"][0]["image"].split(":")[-1], "controller-test"
                )
                self.assertEqual(
                    pod["containers"][0]["command"],
                    ["bun", "run", "src/colab-mcp/index.ts"],
                )
                self.assertEqual(
                    pod["volumes"],
                    [
                        {
                            "name": "colab-adc",
                            "secret": {
                                "secretName": "colab-mcp-adc",
                                "optional": True,
                                "defaultMode": 0o440,
                                "items": [
                                    {
                                        "key": "credentials.json",
                                        "path": "credentials.json",
                                    }
                                ],
                            },
                        }
                    ],
                )
                self.assertEqual(
                    [
                        key
                        for key, value in manifests.items()
                        if "secretName: colab-mcp-adc" in yaml.safe_dump(value)
                    ],
                    [("Deployment", COLAB_GATEWAY)],
                )
                self.assertEqual(
                    self.env(manifests, COLAB_GATEWAY)["COLAB_MAX_CONCURRENT_RUNTIMES"],
                    {"value": "5"},
                )
                self.assertEqual(
                    self.env(manifests, COLAB_GATEWAY)["COLAB_QUOTA_PROJECT"],
                    {"value": "proompteng"},
                )
                self.assertEqual(
                    manifests["PodDisruptionBudget", COLAB_GATEWAY]["spec"]["selector"],
                    deployment["selector"],
                )
                self.assertEqual(
                    manifests["Service", COLAB_GATEWAY]["spec"]["selector"],
                    deployment["selector"]["matchLabels"],
                )
                self.assertEqual(
                    manifests["ClusterRole", COLAB_GATEWAY]["rules"],
                    [
                        {
                            "apiGroups": ["authentication.k8s.io"],
                            "resources": ["tokenreviews"],
                            "verbs": ["create"],
                        }
                    ],
                )
                self.assertFalse(
                    manifests["ServiceAccount", "google-triage-runner"][
                        "automountServiceAccountToken"
                    ]
                )
                self.assertFalse(
                    manifests["ServiceAccount", "codex-auto-ontology-runner"][
                        "automountServiceAccountToken"
                    ]
                )
