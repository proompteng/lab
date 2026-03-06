from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from app.db import _parse_migration_graph


def _service_root() -> Path:
    return Path(__file__).resolve().parents[1]


def _script_path() -> Path:
    return _service_root() / "scripts" / "check_migration_graph.py"


def _write_migration(path: Path, revision: str, down_revision: str | None) -> None:
    payload = [f"revision = '{revision}'"]
    if down_revision is None:
        payload.append("down_revision = None")
    else:
        payload.append(f"down_revision = '{down_revision}'")
    path.write_text("\n".join(payload) + "\n", encoding="utf-8")


class TestCheckMigrationGraphScript(TestCase):
    def _run_script(self, *args: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
        service_root = _service_root()
        script_path = _script_path()
        process_env = dict(os.environ)
        process_env["PYTHONPATH"] = str(service_root)
        if env:
            process_env.update(env)
        return subprocess.run(
            [sys.executable, str(script_path), *args],
            cwd=service_root,
            capture_output=True,
            text=True,
            check=False,
            env=process_env,
        )

    def test_cli_rejects_new_branch_divergence_without_override(self) -> None:
        with TemporaryDirectory() as tmpdir:
            versions_dir = Path(tmpdir)
            _write_migration(versions_dir / "0001_root.py", "0001_root", None)
            _write_migration(versions_dir / "0002_alpha.py", "0002_alpha", "0001_root")
            _write_migration(versions_dir / "0002_beta.py", "0002_beta", "0001_root")

            result = self._run_script("--versions-dir", str(versions_dir))

        self.assertEqual(result.returncode, 1, msg=result.stdout or result.stderr)
        payload = json.loads(result.stdout)
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["branch_count"], 2)
        self.assertEqual(payload["errors"], [
            "migration branch count 2 exceeds allowed 1; add --allow-signature "
            "<signature> (or update allowlist) in the same change if intentional"
        ])

    def test_cli_accepts_allowlisted_signature_for_known_divergence(self) -> None:
        with TemporaryDirectory() as tmpdir:
            versions_dir = Path(tmpdir)
            _write_migration(versions_dir / "0001_root.py", "0001_root", None)
            _write_migration(versions_dir / "0002_alpha.py", "0002_alpha", "0001_root")
            _write_migration(versions_dir / "0002_beta.py", "0002_beta", "0001_root")
            signature = str(
                _parse_migration_graph(versions_dir)["expected_schema_graph_signature"]
            )

            result = self._run_script(
                "--versions-dir",
                str(versions_dir),
                "--allow-signature",
                signature,
            )

        self.assertEqual(result.returncode, 0, msg=result.stdout or result.stderr)
        payload = json.loads(result.stdout)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["errors"], [])
        self.assertEqual(
            payload["warnings"],
            [
                f"migration branch count 2 exceeds allowed 1; allowlisted signature {signature}"
            ],
        )
