from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.assemble_runtime_ledger_proof_packet.support import *


class TestRuntimeLedgerProofPacketPart6(_TestRuntimeLedgerProofPacketBase):
    def test_json_loaders_require_objects_and_support_urls(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            bad_path = Path(tmp_dir) / "bad.json"
            bad_path.write_text(json.dumps(["not", "an", "object"]), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "json_object_required"):
                packet._load_json_object(bad_path)

        class _Response:
            def __init__(self, body: object) -> None:
                self.body = body

            def __enter__(self) -> "_Response":
                return self

            def __exit__(self, *_args: object) -> None:
                return None

            def read(self) -> bytes:
                return json.dumps(self.body).encode("utf-8")

        with patch.object(packet, "urlopen", return_value=_Response({"ok": True})):
            self.assertEqual(
                packet._load_json_url(
                    "http://example.invalid/status.json", timeout_seconds=1
                ),
                {"ok": True},
            )
        with patch.object(packet, "urlopen", return_value=_Response(["bad"])):
            with self.assertRaisesRegex(ValueError, "json_object_required"):
                packet._load_json_url(
                    "http://example.invalid/status.json",
                    timeout_seconds=1,
                )
        http_error_url = "http://example.invalid/degraded.json"
        with patch.object(
            packet,
            "urlopen",
            side_effect=HTTPError(
                url=http_error_url,
                code=503,
                msg="Service Unavailable",
                hdrs={},
                fp=io.BytesIO(json.dumps({"ok": False}).encode("utf-8")),
            ),
        ):
            payload = packet._load_json_url(http_error_url, timeout_seconds=1)
            self.assertEqual(payload["ok"], False)
            self.assertEqual(
                payload["source_load"],
                {
                    "source_url": http_error_url,
                    "http_status": 503,
                    "http_reason": "Service Unavailable",
                    "http_error": True,
                },
            )
        with patch.object(
            packet,
            "urlopen",
            side_effect=HTTPError(
                url=http_error_url,
                code=503,
                msg="Service Unavailable",
                hdrs={},
                fp=io.BytesIO(json.dumps(["bad"]).encode("utf-8")),
            ),
        ):
            with self.assertRaises(HTTPError):
                packet._load_json_url(http_error_url, timeout_seconds=1)
        with patch.object(
            packet,
            "_load_json_url",
            side_effect=HTTPError(
                url=http_error_url,
                code=503,
                msg="Service Unavailable",
                hdrs={},
                fp=io.BytesIO(b"Service Unavailable"),
            ),
        ):
            with self.assertRaises(HTTPError):
                packet._load_optional_json_object(
                    path=None,
                    url=http_error_url,
                    timeout_seconds=1,
                )
