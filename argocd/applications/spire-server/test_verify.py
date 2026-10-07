import copy
import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import verify


class HighAvailabilityVerification(unittest.TestCase):
    def setUp(self):
        self.database = {"spec": {"instances": 3}, "status": {"readyInstances": 3}}
        self.pods = {
            "items": [
                {
                    "metadata": {"name": f"replica-{i}"},
                    "spec": {"nodeName": f"node-{i}"},
                }
                for i in range(3)
            ]
        }
        self.datastore = {
            "database_type": "postgres",
            "connection_string": "dbname=spire host=spire-db-rw sslmode=verify-full",
        }

    def kubectl(self, context, namespace, *args):
        if args[1] == "cluster":
            result = self.database
        elif args[1] == "pods":
            result = self.pods
        else:
            result = {
                "data": {
                    "server.conf": json.dumps(
                        {
                            "plugins": {
                                "DataStore": [{"sql": {"plugin_data": self.datastore}}]
                            }
                        }
                    )
                }
            }
        return SimpleNamespace(stdout=json.dumps(result))

    def test_accepts_three_separate_hosts_with_ready_shared_database(self):
        with patch.object(verify, "kubectl", self.kubectl):
            verify.verify_ha("fixture")

    def test_ready_replica_counts_do_not_hide_one_host_failure_domain(self):
        self.pods = copy.deepcopy(self.pods)
        for pod in self.pods["items"]:
            pod["spec"]["nodeName"] = "one-host"
        with patch.object(verify, "kubectl", self.kubectl):
            with self.assertRaisesRegex(AssertionError, "distinct hosts"):
                verify.verify_ha("fixture")

    def test_rejects_database_without_all_ready_replicas(self):
        self.database["status"]["readyInstances"] = 2
        with patch.object(verify, "kubectl", self.kubectl):
            with self.assertRaisesRegex(AssertionError, "not fully ready"):
                verify.verify_ha("fixture")

    def test_rejects_embedded_datastore(self):
        self.datastore["database_type"] = "sqlite3"
        with patch.object(verify, "kubectl", self.kubectl):
            with self.assertRaisesRegex(AssertionError, "not using PostgreSQL"):
                verify.verify_ha("fixture")

    def test_rejects_unverified_database_tls(self):
        self.datastore["connection_string"] = "dbname=spire sslmode=require"
        with patch.object(verify, "kubectl", self.kubectl):
            with self.assertRaisesRegex(AssertionError, "TLS is not verified"):
                verify.verify_ha("fixture")


if __name__ == "__main__":
    unittest.main()
