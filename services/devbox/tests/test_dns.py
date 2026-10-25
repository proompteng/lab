import importlib.util
import pathlib
import unittest

spec = importlib.util.spec_from_file_location(
    "devbox_dns", pathlib.Path(__file__).resolve().parents[1] / "dns.py"
)
dns = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dns)


class DnsTests(unittest.TestCase):
    def test_preserves_unrelated_aliases_and_is_idempotent(self):
        current = [
            "192.0.2.1 nuc.example",
            f"192.0.2.2 {dns.HOSTNAME} existing.example",
        ]
        desired = ["192.0.2.99 unrelated.example", f"100.100.244.183 {dns.HOSTNAME}"]
        updated = dns.reconcile(current, desired)
        self.assertEqual(
            updated, ["192.0.2.1 nuc.example", "192.0.2.2 existing.example", desired[1]]
        )
        self.assertEqual(dns.reconcile(updated, desired), updated)

    def test_rejects_missing_or_ambiguous_desired_records(self):
        record = f"100.100.244.183 {dns.HOSTNAME}"
        for desired in [[], [record, record], [record + " unrelated.example"]]:
            with self.subTest(desired=desired), self.assertRaises(ValueError):
                dns.reconcile([], desired)
