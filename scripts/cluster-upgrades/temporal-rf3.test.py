#!/usr/bin/env python3
"""Exercise the rendered maintenance shell against a stateful Kubernetes CLI fixture."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = r"""#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
args = sys.argv[1:]
assert args[:2] == ["-n", "temporal"], args
args = args[2:]
text = " ".join(args)
with open(os.environ["FAKE_LOG"], "a") as log:
    log.write(json.dumps(args) + "\n")
uids = ["310f9545-d4f6-4b8c-8bdd-a3186a109c14", "74dd51e0-bc67-4713-804b-c01d60c8d06b", "a0bf87d0-df41-49c1-9a97-d4af83e11116"]
owner = "0a9b7396-7c88-4750-ba97-cf03e48e374b"
state = Path(os.environ["FAKE_STATE"])
def emit(value):
    print(value, end="")
    raise SystemExit(0)
if args[0] == "wait":
    if "volumesnapshot/" in text:
        emit("")
    raise SystemExit("no matching resources found")
if args[0] == "get":
    resource = args[1]
    if resource.startswith("deployment/"):
        emit(os.environ.get("FAKE_SERVER_REPLICAS", "0"))
    if resource == "pods":
        emit(os.environ.get("FAKE_REMAINING_POD", ""))
    if resource == "job":
        emit("2026-09-08T16:00:00Z")
    if resource.startswith("volumesnapshot/"):
        ordinal = resource.rsplit("-", 1)[1]
        values = {"readyToUse": "true", "persistentVolumeClaimName": "data-temporal-cassandra-" + ordinal,
            "volumeSnapshotClassName": "rook-ceph-block", "upgrade-stage": "cassandra-rf3",
            "backup-generation": os.environ.get("FAKE_BACKUP_GENERATION", "cassandra-rf3-before-alter-v1"),
            "boundVolumeSnapshotContentName": "content-" + ordinal,
            "creationTimestamp": os.environ.get("FAKE_SNAPSHOT_CREATED", "2026-09-08T16:01:00Z"),
            "status.error.message": ""}
    elif resource.startswith("pvc/"):
        ordinal = int(resource.rsplit("-", 1)[1])
        values = {"status.phase": "Bound", "storageClassName": "rook-ceph-block", "requests.storage": "20Gi",
            "metadata.uid": os.environ.get("FAKE_PVC_UID", uids[ordinal]), "spec.volumeName": "pvc-" + uids[ordinal]}
    elif resource == "statefulset":
        values = {"containers": os.environ.get("FAKE_IMAGE", "mirror.gcr.io/cassandra:3.11.5"),
            "metadata.uid": owner, "updateStrategy": "OnDelete"}
    elif resource.startswith("pod/"):
        values = {"status.phase": "Running", "conditions": "True", "containers": "mirror.gcr.io/cassandra:3.11.5",
            "deletionTimestamp": "", "metadata.uid": resource + "-uid", "ownerReferences": owner}
    else:
        raise SystemExit("unhandled resource: " + text)
    for field, value in values.items():
        if field in text:
            emit(value)
    raise SystemExit("unhandled field: " + text)
if args[0] == "exec":
    if "nodetool status" in text:
        emit("UN 10.0.0.1\nUN 10.0.0.2\nUN 10.0.0.3\n")
    if "nodetool describecluster" in text:
        emit("Schema versions:\n  11111111-1111-1111-1111-111111111111: [10.0.0.1, 10.0.0.2, 10.0.0.3]\n")
    if "nodetool netstats" in text:
        stream = os.environ.get("FAKE_STREAM_ONCE")
        observed = Path(os.environ["FAKE_STATE"] + ".stream-observed")
        if stream and args[1] == "temporal-cassandra-1" and not observed.exists():
            observed.write_text("yes")
            emit("Mode: NORMAL\n    " + stream + " 2 files, 123 bytes total.\n")
        emit("Mode: NORMAL\nNot sending any streams.\nNot receiving any streams.\n")
    if "nodetool flush temporal" in text:
        emit("")
    if "nodetool repair -full temporal" in text:
        if os.environ.get("FAKE_REPAIR_FAILURE") == args[1]:
            raise SystemExit("repair failed")
        emit("repair completed\n")
    if "ALTER KEYSPACE" in text:
        state.write_text("3")
        emit("")
    if "SELECT replication" in text:
        factor = state.read_text() if state.exists() else "1"
        emit("{'class': 'org.apache.cassandra.locator.SimpleStrategy', 'replication_factor': '" + factor + "'}\n")
raise SystemExit("unhandled command: " + text)
"""


class TemporalReplicationMaintenance(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        loader = """
const fs = require('fs');
const yaml = require('./packages/scripts/node_modules/yaml');
const jobs = process.argv.slice(1).flatMap(path => yaml.parseAllDocuments(fs.readFileSync(path, 'utf8')))
  .map(doc => doc.toJSON()).filter(doc => doc?.kind === 'Job');
process.stdout.write(JSON.stringify(Object.fromEntries(jobs.map(job =>
  [job.metadata.name, job.spec.template.spec.containers[0].args[0]]))));
"""
        cls.scripts = json.loads(
            subprocess.check_output(
                [
                    "node",
                    "-e",
                    loader,
                    "argocd/applications/temporal/preparation/cassandra-quiesce.yaml",
                    "argocd/applications/temporal/preparation/cassandra-rf3.yaml",
                ],
                cwd=ROOT,
                text=True,
            )
        )

    def run_gate(self, *, factor="1", job="repair", **overrides):
        with tempfile.TemporaryDirectory(prefix="temporal-rf3-test-") as directory:
            work = Path(directory)
            cli = work / "kubectl"
            cli.write_text(FIXTURE)
            cli.chmod(0o755)
            sleep = work / "sleep"
            sleep.write_text("#!/bin/sh\nexit 0\n")
            sleep.chmod(0o755)
            date = work / "date"
            date.write_text(
                "#!/usr/bin/env python3\nimport datetime,sys\n"
                "assert sys.argv[1] == '-d' and sys.argv[3] == '+%s'\n"
                "print(int(datetime.datetime.fromisoformat(sys.argv[2].replace('Z','+00:00')).timestamp()))\n"
            )
            date.chmod(0o755)
            state = work / "state"
            state.write_text(factor)
            env = {
                **os.environ,
                "PATH": str(work) + os.pathsep + os.environ["PATH"],
                "FAKE_LOG": str(work / "commands.jsonl"),
                "FAKE_STATE": str(state),
                "EXPECTED_CASSANDRA_IMAGE": "mirror.gcr.io/cassandra:3.11.5",
                "EXPECTED_BACKUP_GENERATION": "cassandra-rf3-before-alter-v1",
                **overrides,
            }
            result = subprocess.run(
                ["bash", "-c", self.scripts[f"temporal-cassandra-rf3-{job}"]],
                env=env,
                text=True,
                capture_output=True,
                timeout=30,
            )
            commands = [
                json.loads(line)
                for line in (work / "commands.jsonl").read_text().splitlines()
            ]
            return result, commands, state.read_text()

    def test_quiesce_flushes_all_nodes_after_servers_stop(self):
        result, commands, _ = self.run_gate(job="quiesce")
        self.assertEqual(result.returncode, 0, result.stderr)
        flushes = [c[1] for c in commands if "nodetool flush temporal" in " ".join(c)]
        self.assertEqual(flushes, [f"temporal-cassandra-{n}" for n in range(3)])
        self.assertFalse(any(c[0] == "wait" for c in commands))

    def test_active_streams_on_another_node_delay_alter(self):
        for direction in ("Receiving", "Sending"):
            with self.subTest(direction=direction):
                result, commands, _ = self.run_gate(FAKE_STREAM_ONCE=direction)
                self.assertEqual(result.returncode, 0, result.stderr)
                before_alter = commands[
                    : next(
                        i
                        for i, c in enumerate(commands)
                        if "ALTER KEYSPACE" in " ".join(c)
                    )
                ]
                self.assertGreaterEqual(
                    sum(
                        c[:2] == ["exec", "temporal-cassandra-1"]
                        and "nodetool netstats" in " ".join(c)
                        for c in before_alter
                    ),
                    2,
                )

    def test_rf1_and_rf3_both_complete_full_repair(self):
        for factor in ("1", "3"):
            with self.subTest(factor=factor):
                result, commands, current = self.run_gate(factor=factor)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(current, "3")
                self.assertEqual(
                    sum("ALTER KEYSPACE" in " ".join(c) for c in commands), 1
                )
                self.assertEqual(
                    [
                        c[1]
                        for c in commands
                        if "nodetool repair -full temporal" in " ".join(c)
                    ],
                    [f"temporal-cassandra-{n}" for n in range(3)],
                )

    def test_invalid_preconditions_do_not_alter_or_repair(self):
        scenarios = [
            {"FAKE_SERVER_REPLICAS": "1"},
            {"FAKE_REMAINING_POD": "pod/temporal-history-old"},
            {"FAKE_BACKUP_GENERATION": "old-generation"},
            {"FAKE_SNAPSHOT_CREATED": "2026-09-08T15:59:59Z"},
            {"FAKE_PVC_UID": "replacement-pvc"},
            {"FAKE_IMAGE": "cassandra:4.1.12"},
        ]
        for overrides in scenarios:
            with self.subTest(overrides=overrides):
                result, commands, current = self.run_gate(**overrides)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(current, "1")
                self.assertFalse(
                    any(
                        "ALTER KEYSPACE" in " ".join(c)
                        or "nodetool repair" in " ".join(c)
                        for c in commands
                    )
                )

    def test_replication_factor_13_is_not_misread_as_1(self):
        result, commands, current = self.run_gate(factor="13")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(current, "13")
        self.assertFalse(any("ALTER KEYSPACE" in " ".join(c) for c in commands))

    def test_failed_repair_stops_and_preserves_rf3(self):
        result, commands, current = self.run_gate(
            FAKE_REPAIR_FAILURE="temporal-cassandra-1"
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(current, "3")
        self.assertEqual(
            [c[1] for c in commands if "nodetool repair -full temporal" in " ".join(c)],
            ["temporal-cassandra-0", "temporal-cassandra-1"],
        )


if __name__ == "__main__":
    unittest.main()
