import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import verify


class DatastoreVerification(unittest.TestCase):
    def setUp(self):
        self.database = {"spec": {"instances": 3}, "status": {"readyInstances": 3}}
        self.datastore = {
            "database_type": "postgres",
            "connection_string": "dbname=spire host=spire-db-rw sslmode=verify-full",
        }

    def kubectl(self, context, namespace, *args):
        if args[1] == "cluster":
            result = self.database
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

    def test_accepts_ready_shared_database(self):
        with patch.object(verify, "kubectl", self.kubectl):
            verify.verify_datastore("fixture")

    def test_rejects_database_without_all_ready_replicas(self):
        self.database["status"]["readyInstances"] = 2
        with patch.object(verify, "kubectl", self.kubectl):
            with self.assertRaisesRegex(AssertionError, "not fully ready"):
                verify.verify_datastore("fixture")

    def test_rejects_embedded_datastore(self):
        self.datastore["database_type"] = "sqlite3"
        with patch.object(verify, "kubectl", self.kubectl):
            with self.assertRaisesRegex(AssertionError, "not using PostgreSQL"):
                verify.verify_datastore("fixture")

    def test_rejects_unverified_database_tls(self):
        self.datastore["connection_string"] = "dbname=spire sslmode=require"
        with patch.object(verify, "kubectl", self.kubectl):
            with self.assertRaisesRegex(AssertionError, "TLS is not verified"):
                verify.verify_datastore("fixture")


class FederationVerification(unittest.TestCase):
    def setUp(self):
        self.key = {"kid": "current", "kty": "RSA", "n": "public-modulus", "e": "AQAB"}
        self.bundle = {
            "keys": [dict(self.key, use="jwt-svid"), {"kty": "RSA", "use": "x509-svid"}]
        }
        self.discovery = {
            "issuer": verify.JWT_ISSUER,
            "jwks_uri": verify.JWT_ISSUER + "/keys",
        }
        self.jwks = {"keys": [dict(self.key, use="sig")]}

    def test_accepts_only_the_published_jwt_authorities(self):
        verify.verify_public_keys(self.bundle, self.discovery, self.jwks)

    def test_rejects_other_issuer_or_jwks_destination(self):
        for field in ("issuer", "jwks_uri"):
            with self.subTest(field=field):
                discovery = dict(self.discovery, **{field: "https://other.example"})
                with self.assertRaises(AssertionError):
                    verify.verify_public_keys(self.bundle, discovery, self.jwks)

    def test_rejects_private_key_material(self):
        for field in ("d", "p", "q", "dp", "dq", "qi", "oth", "k"):
            with self.subTest(field=field):
                jwks = {"keys": [dict(self.jwks["keys"][0], **{field: "private"})]}
                with self.assertRaisesRegex(AssertionError, "private key material"):
                    verify.verify_public_keys(self.bundle, self.discovery, jwks)

    def test_rejects_unrelated_or_stale_public_key(self):
        self.jwks["keys"][0]["n"] = "another-modulus"
        with self.assertRaisesRegex(AssertionError, "does not match"):
            verify.verify_public_keys(self.bundle, self.discovery, self.jwks)

    def test_requires_keys_and_rejects_x509_authorities(self):
        for keys in ([], [dict(self.key, use="x509-svid")]):
            with self.subTest(keys=keys), self.assertRaises(AssertionError):
                verify.verify_public_keys(self.bundle, self.discovery, {"keys": keys})

    def test_rejects_duplicate_key_ids(self):
        self.jwks["keys"].append(dict(self.jwks["keys"][0]))
        with self.assertRaisesRegex(AssertionError, "duplicate"):
            verify.verify_public_keys(self.bundle, self.discovery, self.jwks)

    def test_accepts_key_rotation_after_bundle_and_discovery_converge(self):
        next_key = dict(self.key, kid="next", n="next-modulus")
        self.bundle["keys"].append(dict(next_key, use="jwt-svid"))
        self.jwks["keys"].append(dict(next_key, use="sig"))
        verify.verify_public_keys(self.bundle, self.discovery, self.jwks)


if __name__ == "__main__":
    unittest.main()
