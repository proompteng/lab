import importlib.util
from pathlib import Path
import sys
import unittest
import urllib.request
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    "platform_fixture", Path(__file__).with_name("platform_fixture.py")
)
fixture_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture_module)


class DisposableFixtureTests(unittest.TestCase):
    def test_root_uses_a_standard_account_without_runner_provisioning(self):
        original_lookup = fixture_module.pwd.getpwnam

        def system_account(name):
            if name != "nobody":
                raise KeyError(name)
            return original_lookup(name)

        with (
            patch.object(fixture_module.os, "getuid", return_value=0),
            patch.object(fixture_module.os, "chown") as chown,
            patch.object(fixture_module.pwd, "getpwnam", side_effect=system_account),
        ):
            with fixture_module.Fixture() as fixture:
                self.assertNotEqual(fixture.uid, 0)
                chown.assert_called_once_with(
                    fixture.directory, fixture.uid, fixture.gid
                )

    def test_real_service_and_directory_are_removed_after_failure(self):
        with self.assertRaisesRegex(RuntimeError, "simulated test failure"):
            with fixture_module.Fixture() as fixture:
                directory = fixture.directory
                process = fixture.start(
                    "http",
                    [
                        sys.executable,
                        "-m",
                        "http.server",
                        str(fixture.http_port),
                        "--bind",
                        "127.0.0.1",
                    ],
                )

                def healthy():
                    try:
                        with urllib.request.urlopen(fixture.endpoint, timeout=1):
                            return True
                    except OSError:
                        return False

                fixture.wait(process, healthy)
                raise RuntimeError("simulated test failure")
        self.assertIsNotNone(process.poll())
        self.assertFalse(directory.exists())

    def test_early_service_exit_fails_instead_of_polling_forever(self):
        fixture = fixture_module.Fixture()
        process = fixture.start("failed", [sys.executable, "-c", "raise SystemExit(7)"])
        try:
            with self.assertRaisesRegex(RuntimeError, "exited with 7"):
                fixture.wait(process, lambda: False)
        finally:
            fixture.close()


if __name__ == "__main__":
    unittest.main()
