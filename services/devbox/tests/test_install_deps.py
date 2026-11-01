import json
import os
import pathlib
import subprocess
import tempfile
import unittest


SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "install-deps.sh"
TOOL = """#!/usr/bin/env python3
import json
import os
import pathlib
import sys

root = pathlib.Path(os.environ["DEVBOX_INSTALL_TEST_ROOT"])
tool = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
with (root / "calls.jsonl").open("a") as output:
    output.write(json.dumps([tool, *args]) + "\\n")
if tool == "npm":
    if not (root / "node-gyp.js").exists():
        raise SystemExit("native build helper disappeared")
    if os.environ.get("DEVBOX_INSTALL_TEST_REBUILD_FAIL"):
        raise SystemExit(17)
    if args[:1] != ["--prefix"] or not args[1].startswith("node_modules/.bun/"):
        raise SystemExit("prepare ran on a linked source package")
    (root / "native-built").touch()
elif tool == "jq":
    package = json.loads(pathlib.Path(args[-1]).read_text())
    print(package["name"] + "@" + package["version"])
elif args[:2] == ["pm", "ls"]:
    print(str(root) + " node_modules")
    print(os.environ["DEVBOX_INSTALL_TEST_TRUSTED"])
elif "--ignore-scripts" in args:
    (root / "node-gyp.js").write_text("installed native build helper")
elif "--force" in args:
    (root / "node-gyp.js").unlink()
    raise SystemExit("Cannot find module node-gyp.js during forced reinstall")
else:
    (root / "workspace-built").touch()
"""


class InstallDependenciesTests(unittest.TestCase):
    def run_install(self, trusted, rebuild_fail=False, missing=False):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = pathlib.Path(directory.name)
        binaries = root / "bin"
        binaries.mkdir()
        for name in ["bun", "npm", "jq"]:
            executable = binaries / name
            executable.write_text(TOOL)
            executable.chmod(0o755)
        store = root / "node_modules/.bun"
        packages = [
            ("tree-sitter-json", "0.24.8"),
            ("tree-sitter-json", "0.24.7"),
            ("@scope/native", "2.0.0-beta.1"),
            ("untrusted", "1.0.0"),
        ]
        if not missing:
            for name, version in packages:
                directory = store / f"{name.replace('/', '+')}@{version}"
                package = directory / "node_modules" / name
                package.mkdir(parents=True)
                (package / "package.json").write_text(
                    json.dumps({"name": name, "version": version})
                )
            links = store / "untrusted@1.0.0/node_modules"
            (links / "tree-sitter-json").symlink_to(
                store / "tree-sitter-json@0.24.8/node_modules/tree-sitter-json"
            )
        environment = {
            **os.environ,
            "PATH": f"{binaries}:{os.environ['PATH']}",
            "DEVBOX_INSTALL_TEST_ROOT": str(root),
            "DEVBOX_INSTALL_TEST_TRUSTED": trusted,
        }
        if rebuild_fail:
            environment["DEVBOX_INSTALL_TEST_REBUILD_FAIL"] = "1"
        result = subprocess.run(
            ["bash", str(SCRIPT)],
            cwd=root,
            env=environment,
            capture_output=True,
            text=True,
        )
        calls = [
            json.loads(line) for line in (root / "calls.jsonl").read_text().splitlines()
        ]
        return result, root, calls

    def test_native_build_preserves_materialized_helper_and_trust_selection(self):
        result, root, calls = self.run_install(
            "├── tree-sitter-json@0.24.8\n└── @scope/native@2.0.0-beta.1"
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((root / "node-gyp.js").exists())
        self.assertTrue((root / "native-built").exists())
        self.assertTrue((root / "workspace-built").exists())
        rebuilds = [call for call in calls if call[0] == "npm"]
        self.assertEqual(len(rebuilds), 2)
        self.assertEqual(
            [call[-1] for call in rebuilds],
            ["tree-sitter-json@0.24.8", "@scope/native@2.0.0-beta.1"],
        )
        self.assertIn("--package-lock=false", rebuilds[0])
        self.assertEqual(
            rebuilds[0][1:3],
            ["--prefix", "node_modules/.bun/tree-sitter-json@0.24.8"],
        )

    def test_missing_trusted_package_stops_before_workspace_postinstall(self):
        result, root, calls = self.run_install(
            "└── tree-sitter-json@0.24.8", missing=True
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("missing from Bun's isolated store", result.stderr)
        self.assertFalse(any(call[0] == "npm" for call in calls))
        self.assertFalse((root / "workspace-built").exists())

    def test_empty_trusted_list_never_rebuilds_all_dependencies(self):
        result, root, calls = self.run_install("")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(any(call[0] == "npm" for call in calls))
        self.assertTrue((root / "workspace-built").exists())

    def test_unrecognized_trusted_output_stops_before_running_scripts(self):
        for trusted in ["unexpected output", "└── --all@1.0.0"]:
            with self.subTest(trusted=trusted):
                result, root, calls = self.run_install(trusted)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(any(call[0] == "npm" for call in calls))
                self.assertFalse((root / "workspace-built").exists())

    def test_native_build_failure_stops_workspace_postinstall(self):
        result, root, _ = self.run_install(
            "└── tree-sitter-json@0.24.8", rebuild_fail=True
        )
        self.assertEqual(result.returncode, 17, result.stderr)
        self.assertFalse((root / "workspace-built").exists())
