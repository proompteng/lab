import configparser
import os
import pathlib
import subprocess
import tempfile
import time
import unittest


def systemd_available():
    try:
        return (
            os.geteuid() == 0
            and pathlib.Path("/proc/1/comm").read_text().strip() == "systemd"
        )
    except OSError:
        return False


@unittest.skipUnless(systemd_available(), "requires root in a systemd guest")
class PrepareRestartTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="devbox-retry-", dir="/run")
        self.root = pathlib.Path(self.directory.name)
        self.unit = self.root.name + ".service"
        self.unit_path = pathlib.Path("/run/systemd/system") / self.unit
        source = pathlib.Path(__file__).resolve().parents[1] / "devbox-prepare.service"
        config = configparser.ConfigParser(interpolation=None)
        config.optionxform = str
        config.read(source)
        config["Unit"] = {"Description": "Devbox preparation retry regression"}
        config.remove_section("Install")
        config["Service"]["ExecStart"] = "/bin/sh " + str(self.root / "prepare.sh")
        with self.unit_path.open("w") as file:
            config.write(file, space_around_delimiters=False)
        (self.root / "prepare.sh").write_text(
            'echo attempt >> "' + str(self.root / "attempts") + '"\n'
            'test -f "' + str(self.root / "daemon-ready") + '" || exit 1\n'
            'touch "' + str(self.root / "setup-ready") + '"\n'
        )
        self.control("daemon-reload")

    def tearDown(self):
        self.control("stop", self.unit, check=False)
        self.control("reset-failed", self.unit, check=False)
        self.unit_path.unlink(missing_ok=True)
        self.control("daemon-reload")
        self.directory.cleanup()

    def control(self, *args, check=True):
        return subprocess.run(
            ["systemctl", *args],
            capture_output=True,
            text=True,
            check=check,
            timeout=15,
        )

    def wait_for(self, condition):
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if condition():
                return
            time.sleep(0.1)
        self.fail("preparation did not reach the expected state within 15 seconds")

    def attempts(self):
        path = self.root / "attempts"
        return len(path.read_text().splitlines()) if path.exists() else 0

    def test_daemon_ready_after_first_failure_completes_preparation(self):
        result = self.control("start", self.unit, check=False)
        self.assertNotEqual(result.returncode, 0)
        self.wait_for(lambda: self.attempts() == 1)
        self.assertFalse((self.root / "setup-ready").exists())
        (self.root / "daemon-ready").touch()
        self.wait_for(lambda: (self.root / "setup-ready").exists())
        self.wait_for(
            lambda: self.control("is-active", self.unit, check=False).stdout.strip()
            == "active"
        )
        self.assertEqual(self.attempts(), 2)

    def test_repeated_failure_never_reports_setup_ready(self):
        self.control("start", self.unit, check=False)
        self.wait_for(lambda: self.attempts() >= 2)
        self.assertFalse((self.root / "setup-ready").exists())
        state = self.control(
            "show", self.unit, "--property=SubState", "--value"
        ).stdout.strip()
        self.assertEqual(state, "auto-restart")

    def test_docker_start_failure_does_not_prevent_preparation_retries(self):
        dependency = self.root.name + "-docker.service"
        dependency_path = pathlib.Path("/run/systemd/system") / dependency
        dependency_path.write_text(
            "[Service]\nType=oneshot\nRemainAfterExit=yes\n"
            "ExecStart=/bin/sh -c 'test -f \""
            + str(self.root / "docker-ready")
            + "\"'\n"
        )
        config = configparser.ConfigParser(interpolation=None)
        config.optionxform = str
        config.read(self.unit_path)
        source = configparser.ConfigParser(interpolation=None)
        source.read(
            pathlib.Path(__file__).resolve().parents[1] / "devbox-prepare.service"
        )
        for key in ("After", "Requires", "Wants"):
            if "docker.service" in source["Unit"].get(key, "").split():
                config["Unit"][key] = dependency
        with self.unit_path.open("w") as file:
            config.write(file, space_around_delimiters=False)
        self.control("daemon-reload")
        try:
            self.assertNotEqual(
                self.control("start", dependency, check=False).returncode, 0
            )
            self.control("start", self.unit, check=False)
            self.wait_for(lambda: self.attempts() >= 2)
            self.assertFalse((self.root / "setup-ready").exists())
            (self.root / "docker-ready").touch()
            (self.root / "daemon-ready").touch()
            self.control("reset-failed", dependency)
            self.control("start", dependency)
            self.wait_for(lambda: (self.root / "setup-ready").exists())
        finally:
            self.control("stop", self.unit, dependency, check=False)
            self.control("reset-failed", dependency, check=False)
            dependency_path.unlink(missing_ok=True)
            self.control("daemon-reload")


if __name__ == "__main__":
    unittest.main()
