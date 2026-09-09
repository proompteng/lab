"""Exercise native upgrade ordering and API deletion preconditions with a stateful CLI."""

import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "argocd/applications/temporal/upgrade/cassandra-gate.sh"
SOURCE = "mirror.gcr.io/cassandra:3.11.5"
TARGET = "mirror.gcr.io/cassandra:3.11.19@sha256:" + "a" * 64
FIXTURE = r"""#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
args=sys.argv[1:]
assert args[:3]==['-n','temporal','--cache-dir=/tmp/kubectl-cache'] and args[3].startswith('--request-timeout='), args
args=args[4:]
path=Path(os.environ['STATE'])
s=json.loads(path.read_text())
mode=os.environ.get('FAILURE','')
with open(os.environ['CALLS'],'a') as log: log.write(json.dumps(args)+'\n')
owner='0a9b7396-7c88-4750-ba97-cf03e48e374b'
uids=['310f9545-d4f6-4b8c-8bdd-a3186a109c14','74dd51e0-bc67-4713-804b-c01d60c8d06b','a0bf87d0-df41-49c1-9a97-d4af83e11116']
hosts=['49cbb919-5b4c-4489-bab3-ec01a67297fa','d464e999-f072-461d-80ee-bac1b31c269c','03d74056-6b9b-4574-8757-80e130c9bae3']
def done(value=''):
 path.write_text(json.dumps(s)); print(value); raise SystemExit(0)
if args[0]=='get':
 resource=args[1]
 if mode=='forbidden': raise SystemExit('Forbidden')
 if resource.startswith('pvc/'):
  n=int(resource[-1]); uid=uids[n]
  if mode=='pvc': uid='changed'
  done('|'.join([uid,'Bound','rook-ceph-block','pvc-'+uids[n]]))
 if resource.startswith('statefulset/'):
  if 'metadata.uid' not in args[-1]: done(os.environ['TARGET_IMAGE'])
  done(owner+'|OnDelete|3|'+('unexpected-image' if mode=='template' else os.environ['TEMPLATE_IMAGE']))
 if resource.startswith('pod/'):
  n=int(resource[-1]); pod=s['pods'][n]
  if args[-1]=='jsonpath={.status.podIP}': done('10.0.0.'+str(n+1))
  done('|'.join([pod['uid'],str(pod['rv']),('changed' if mode=='owner' else owner),pod['image'],'True','','data-temporal-cassandra-'+str(n)]))
 if resource.startswith('job/'):
  done('' if mode=='no-rehearsal' and resource.endswith('rehearsal') else '2026-09-09T09:00:00Z')
 if resource.startswith('volumesnapshot/'):
  n=int(resource[-1]);reads=s.setdefault('snapshot_reads',[0,0,0]);reads[n]+=1
  pending=mode=='snapshot-pending' and reads[n]<3
  done('|'.join(['data-temporal-cassandra-'+str(n),'false' if pending else 'true','wrong-v1' if mode=='generation' else '31119-v1','2026-09-08T10:00:00Z' if mode=='stale' else '2026-09-09T09:01:00Z','' if pending else 'content-'+str(n),'snapshot failed' if mode=='snapshot-error' else '','wrong-class' if mode=='snapshot-class' else 'rook-ceph-block']))
 raise SystemExit('Unexpected get '+repr(args))
if args[0]=='exec':
 n=int(args[1][-1]); cmd=args[args.index('--')+1:]
 if cmd[:2]==['nodetool','status']:
  if mode=='ring-api': raise SystemExit('Forbidden exec')
  if mode=='host-id': hosts[-1]='00000000-0000-0000-0000-000000000000'
  done('\n'.join('UN 10.0.0.%s 5 GiB 256 100%% %s rack1' % (i+1,h) for i,h in enumerate(hosts)))
 if cmd==['nodetool','netstats']: done('Mode: NORMAL\nNot sending any streams.')
 if cmd==['nodetool','describecluster']:
  mixed=len({p['image'] for p in s['pods']})>1
  done('Schema versions:\n  aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa: [10.0.0.1]\n'+('  bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb: [10.0.0.2]\n' if mixed else ''))
 if cmd[0]=='cqlsh' and cmd[-1]=='SELECT host_id FROM system.local;': done(hosts[int(cmd[1][-1])-1])
 if cmd[0]=='cqlsh': done("{'class': 'org.apache.cassandra.locator.SimpleStrategy', 'replication_factor': '%s'}" % ('1' if mode=='rf1' else '3'))
 if cmd[:2]==['nodetool','listsnapshots']: done(' '.join(s['snapshots'][n]))
 if cmd[:2]==['nodetool','snapshot']:
  s['snapshots'][n].append(cmd[-1]);done()
 if cmd==['nodetool','drain']:
  s['pods'][n]['rv']+=1
  if mode=='drain-identity': s['pods'][n]['uid']='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  done()
 if cmd[:2]==['nodetool','upgradesstables']: done()
 raise SystemExit('Unexpected exec '+repr(args))
if args[0]=='delete':
 assert args[1]=='--raw' and args[-2:]==['-f','-'],args
 n=int(args[2][-1]); payload=json.loads(sys.stdin.read());pod=s['pods'][n]
 assert payload=={'apiVersion':'v1','kind':'DeleteOptions','gracePeriodSeconds':300,'preconditions':{'uid':pod['uid'],'resourceVersion':str(pod['rv'])}},payload
 if mode=='delete-conflict': raise SystemExit('Conflict: resourceVersion precondition failed')
 pod['uid']='bbbbbbbb-bbbb-bbbb-bbbb-%012d' % n
 pod['rv']+=1
 pod['image']='unexpected-image' if mode=='replacement-image' else os.environ['TARGET_IMAGE']
 done()
raise SystemExit('Unexpected command '+repr(args))
"""


class CassandraGateTests(unittest.TestCase):
    def test_rendered_configmap_reference_requires_matching_namespace_and_hash(self):
        from temporal_manifest_check import validate

        config = {
            "kind": "ConfigMap",
            "metadata": {
                "name": "temporal-cassandra-upgrade-scripts-hash",
                "namespace": "temporal",
            },
        }
        job = {
            "kind": "Job",
            "metadata": {
                "name": "temporal-cassandra-test-snapshot",
                "namespace": "temporal",
            },
            "spec": {
                "template": {
                    "spec": {
                        "volumes": [
                            {
                                "name": "scripts",
                                "configMap": {
                                    "name": "temporal-cassandra-upgrade-scripts"
                                },
                            }
                        ]
                    }
                }
            },
        }
        with self.assertRaisesRegex(ValueError, "missing rendered ConfigMap"):
            validate([config, job])
        job["spec"]["template"]["spec"]["volumes"][0]["configMap"]["name"] = config[
            "metadata"
        ]["name"]
        self.assertEqual(validate([config, job]), 1)
        malformed = copy.deepcopy(job)
        malformed["metadata"]["name"] = "temporal-cassandra-test-rehearsal"
        malformed["spec"]["template"]["spec"]["volumes"][0]["configMap"]["name"] = (
            "misspelled-scripts"
        )
        with self.assertRaisesRegex(ValueError, "missing rendered ConfigMap"):
            validate([config, job, malformed])
        malformed["spec"]["template"]["spec"]["volumes"] = []
        with self.assertRaisesRegex(ValueError, "expected one scripts"):
            validate([config, job, malformed])
        config["metadata"]["namespace"] = "elsewhere"
        with self.assertRaisesRegex(ValueError, "missing rendered ConfigMap"):
            validate([config, job])

    def run_gate(self, mode="rollout", failure="", upgraded=()):
        with tempfile.TemporaryDirectory() as directory:
            tmp = Path(directory)
            account = tmp / "serviceaccount"
            account.mkdir()
            (account / "token").write_text("fixture-token")
            (account / "ca.crt").write_text("fixture-ca")
            (account / "namespace").write_text("temporal")
            cli = tmp / "kubectl"
            cli.write_text(FIXTURE)
            cli.chmod(0o755)
            # A real sleep in these converged fixtures is an unexpected wait.
            sleeper = tmp / "sleep"
            sleeper.write_text(
                '#!/bin/sh\n[ "$FAILURE" = snapshot-pending ] || exit 99\n'
            )
            sleeper.chmod(0o755)
            date = tmp / "date"
            date.write_text(
                '#!/usr/bin/env python3\nimport datetime,sys\nprint(int(datetime.datetime.fromisoformat(sys.argv[2].replace("Z","+00:00")).timestamp()))\n'
            )
            date.chmod(0o755)
            state = tmp / "state.json"
            state.write_text(
                json.dumps(
                    {
                        "pods": [
                            {
                                "uid": "cccccccc-cccc-cccc-cccc-%012d" % i,
                                "rv": 100,
                                "image": TARGET if i in upgraded else SOURCE,
                            }
                            for i in range(3)
                        ],
                        "snapshots": [[], [], []],
                    }
                )
            )
            calls = tmp / "calls.jsonl"
            env = {
                **os.environ,
                "KUBERNETES_SERVICE_HOST": "10.96.0.1",
                "KUBERNETES_SERVICE_PORT": "443",
                "SERVICE_ACCOUNT_DIRECTORY": str(account),
                "TMPDIR": str(tmp),
                "PATH": str(tmp) + os.pathsep + os.environ["PATH"],
                "STATE": str(state),
                "CALLS": str(calls),
                "SOURCE_IMAGE": SOURCE,
                "TARGET_IMAGE": TARGET,
                "GENERATION": "31119-v1",
                "FAILURE": failure,
                "REHEARSAL_PROOF_DIRECTORY": str(tmp),
                "TEMPLATE_IMAGE": TARGET if mode == "rollout" else SOURCE,
            }
            result = subprocess.run(
                ["/bin/bash", str(SCRIPT), mode],
                text=True,
                capture_output=True,
                env=env,
                timeout=30,
            )
            return (
                result,
                [json.loads(line) for line in calls.read_text().splitlines()],
                json.loads(state.read_text()),
            )

    def test_serial_rollout_uses_exact_uid_and_latest_revision_after_drain(self):
        result, calls, state = self.run_gate()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([c[2][-1] for c in calls if c[0] == "delete"], ["2", "1", "0"])
        self.assertTrue(all(p["image"] == TARGET for p in state["pods"]))
        self.assertEqual(sum("upgradesstables" in c for c in calls), 3)

    def test_resume_skips_already_upgraded_node(self):
        result, calls, _ = self.run_gate(upgraded=(2,))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([c[2][-1] for c in calls if c[0] == "delete"], ["1", "0"])

    def test_changed_identity_or_unverified_backup_blocks_all_deletions(self):
        for failure in [
            "pvc",
            "owner",
            "generation",
            "stale",
            "no-rehearsal",
            "forbidden",
            "host-id",
            "ring-api",
            "template",
            "snapshot-class",
            "snapshot-error",
            "rf1",
        ]:
            with self.subTest(failure=failure):
                result, calls, _ = self.run_gate(failure=failure)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(any(c[0] == "delete" for c in calls))

    def test_identity_change_during_drain_cannot_delete_replacement(self):
        result, calls, _ = self.run_gate(failure="drain-identity")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any(c[0] == "delete" for c in calls))

    def test_conflict_stops_before_advancing_to_another_node(self):
        result, calls, state = self.run_gate(failure="delete-conflict")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(sum(c[0] == "delete" for c in calls), 1)
        self.assertEqual(sum("drain" in c for c in calls), 1)
        self.assertTrue(all(p["image"] == SOURCE for p in state["pods"]))

    def test_unexpected_replacement_image_stops_rollout(self):
        result, calls, _ = self.run_gate(failure="replacement-image")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(sum(c[0] == "delete" for c in calls), 1)

    def test_backup_preserves_serving_ring_without_deletion(self):
        result, calls, state = self.run_gate(mode="backup")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(state["snapshots"], [["temporal-before-31119-v1"]] * 3)
        self.assertFalse(any(c[0] == "delete" or "drain" in c for c in calls))

    def test_rehearsal_verification_requires_native_backup_and_live_cql_controls(self):
        result, calls, _ = self.run_gate(mode="verify-rehearsal")
        self.assertEqual(result.returncode, 0, result.stderr)
        controls = [
            c
            for c in calls
            if c[0] == "exec" and c[-1] == "SELECT host_id FROM system.local;"
        ]
        self.assertEqual(len(controls), 3)
        self.assertFalse(any(c[0] == "delete" for c in calls))

    def test_network_guard_waits_for_enforcement_and_rejects_reachable_sources(self):
        script = (
            ROOT / "argocd/applications/temporal/upgrade/verify-rehearsal-network.py"
        )
        spec = importlib.util.spec_from_file_location("rehearsal_network", script)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as directory:
            tmp = Path(directory)
            (tmp / "verified-generation").write_text("31119-v3")
            (tmp / "production-cassandra-addresses").write_text(
                "10.0.0.1\n10.0.0.2\n10.0.0.3\n"
            )
            with self.assertRaisesRegex(ValueError, "generation"):
                module.verify(directory, "wrong-v1")
            with mock.patch.object(
                module, "blocked", side_effect=[False] * 3 + [True] * 9
            ) as probe:
                with mock.patch.object(module.time, "sleep"):
                    module.verify(directory, "31119-v3")
                self.assertEqual(probe.call_count, 12)
            ticks = iter([0, 0, 1, 3])
            with mock.patch.object(module, "blocked", return_value=False):
                with mock.patch.object(
                    module.time, "time", side_effect=lambda: next(ticks)
                ):
                    with mock.patch.object(module.time, "sleep"):
                        with self.assertRaisesRegex(
                            RuntimeError, "can reach production"
                        ):
                            module.verify(directory, "31119-v3", timeout=2)

    def test_rf1_backup_is_rejected(self):
        result, calls, _ = self.run_gate(mode="backup", failure="rf1")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any("snapshot" in c for c in calls))

    def test_async_snapshots_are_awaited_before_rollout(self):
        result, calls, state = self.run_gate(failure="snapshot-pending")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(state["snapshot_reads"], [3, 3, 3])
        first_delete = next(i for i, call in enumerate(calls) if call[0] == "delete")
        snapshot_reads = [
            call
            for call in calls[:first_delete]
            if call[0] == "get" and call[1].startswith("volumesnapshot/")
        ]
        self.assertEqual(len(snapshot_reads), 9)

    def test_namespace_hash_ignores_query_formatting_and_row_order(self):
        script = ROOT / "argocd/applications/temporal/upgrade/canonicalize-cql.py"

        def hash_rows(value):
            return subprocess.run(
                ["python3", str(script)], input=value, text=True, capture_output=True
            )

        first = hash_rows(
            ' [json]\n --------\n {"id":1,"data":"0x0123"}\n {"id":2,"data":"0x4567"}\n(2 rows)\n'
        )
        second = hash_rows('{ "data": "0x4567", "id": 2 }\n{"data":"0x0123", "id":1}\n')
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertEqual(first.stdout, second.stdout)
        self.assertNotEqual(hash_rows("(0 rows)\n").returncode, 0)
        self.assertNotEqual(hash_rows("{malformed}\n").returncode, 0)


if __name__ == "__main__":
    unittest.main()
