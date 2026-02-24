from __future__ import annotations

from pathlib import Path
import tempfile
from tempfile import TemporaryDirectory
from unittest import TestCase

from app.trading.scheduler import _resolve_autonomy_artifact_root


class TestAutonomyArtifactRoot(TestCase):
    def test_prefers_configured_root_when_writable(self) -> None:
        with TemporaryDirectory() as tmpdir:
            configured_root = Path(tmpdir) / "custom-artifacts"
            resolved = _resolve_autonomy_artifact_root(configured_root)
            self.assertEqual(resolved, configured_root)
            self.assertTrue(resolved.is_dir())

    def test_falls_back_when_configured_root_unwritable(self) -> None:
        configured_root = Path("/dev/null")
        resolved = _resolve_autonomy_artifact_root(configured_root)
        self.assertNotEqual(resolved, configured_root)
        self.assertEqual(resolved, Path(tempfile.gettempdir()) / "torghut" / "autonomy")
