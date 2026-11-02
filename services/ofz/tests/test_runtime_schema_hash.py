import runpy
import tempfile
import unittest
from pathlib import Path


schema_hash = runpy.run_path(
    str(Path(__file__).resolve().parents[3] / "nix/tengri-schema-hash.py")
)["schema_hash"]


class RuntimeSchemaHashTests(unittest.TestCase):
    def test_identical_migrations_are_independent_of_checkout_location_and_creation_order(
        self,
    ):
        with (
            tempfile.TemporaryDirectory() as left,
            tempfile.TemporaryDirectory() as right,
        ):
            for root, order in [(left, [1, 2]), (right, [2, 1])]:
                directory = Path(root) / "services/tengri/migrations"
                directory.mkdir(parents=True)
                for number in order:
                    (directory / f"{number:04}_control.sql").write_text(
                        f"SELECT {number};\n"
                    )
            self.assertEqual(schema_hash(Path(left)), schema_hash(Path(right)))
            self.assertRegex(schema_hash(Path(left)), r"^[0-9a-f]{64}$")

    def test_content_and_migration_identity_change_the_fingerprint(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root) / "services/tengri/migrations"
            directory.mkdir(parents=True)
            migration = directory / "0001_control.sql"
            migration.write_text("SELECT 1;\n")
            original = schema_hash(Path(root))
            migration.write_text("SELECT 2;\n")
            changed = schema_hash(Path(root))
            self.assertNotEqual(original, changed)
            migration.rename(directory / "0002_control.sql")
            self.assertNotEqual(changed, schema_hash(Path(root)))

    def test_missing_migrations_cannot_publish_an_empty_contract(self):
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaises(ValueError):
                schema_hash(Path(root))
