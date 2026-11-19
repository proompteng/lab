import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
import time
import unittest
from contextlib import redirect_stdout
from email.message import Message
from io import BytesIO, StringIO
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "browser_mcp_tunnel", Path(__file__).with_name("browser-mcp-tunnel.py")
)
tunnel = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tunnel)


class BrowserTunnelTest(unittest.TestCase):
    def connection(self):
        return {
            "version": 1,
            "id": "a" * 24,
            "previewOrigin": f"https://tengri-{'a' * 24}.proompteng.ai",
            "launchUrl": f"{tunnel.GATEWAY}/v1/preview/open#{'b' * 43}",
        }

    def test_rejects_credentials_or_targets_outside_the_exact_browser_origins(self):
        connection = self.connection()
        origin, token = tunnel.validate_connection(connection)
        self.assertEqual(origin, connection["previewOrigin"])
        self.assertEqual(token, "b" * 43)
        for field, value in [
            ("id", "../unrelated"),
            ("previewOrigin", "https://attacker.example"),
            ("launchUrl", connection["launchUrl"].replace("https://", "http://")),
            (
                "launchUrl",
                connection["launchUrl"].replace("tengri.", "tengri.attacker."),
            ),
            (
                "launchUrl",
                connection["launchUrl"].replace("https://", "https://user:secret@"),
            ),
            (
                "launchUrl",
                connection["launchUrl"].replace("#", "?destination=attacker#"),
            ),
            ("launchUrl", connection["launchUrl"] + "\nother"),
        ]:
            with (
                self.subTest(field=field, value=value),
                self.assertRaises(tunnel.ConnectionError),
            ):
                tunnel.validate_connection({**connection, field: value})

    def test_native_exchange_keeps_credentials_in_post_bodies_and_private_cookie(self):
        connection = self.connection()
        origin = connection["previewOrigin"]
        preview_token = "c" * 43
        headers = Message()
        headers.add_header(
            "Set-Cookie",
            f"{tunnel.COOKIE}={preview_token}; Secure; HttpOnly; Path=/; SameSite=Strict",
        )
        responses = [
            ({"location": f"{origin}/_tengri/preview/open#{preview_token}"}, Message()),
            ({"expiresInMs": 1_800_000}, headers),
        ]
        sent = []

        class Opener:
            def open(self, request, timeout):
                sent.append(request)
                value, response_headers = responses.pop(0)
                response = BytesIO(json.dumps(value).encode())
                response.headers = response_headers
                return response

        actual_origin, cookie, lifetime = tunnel.exchange_connection(
            connection, Opener()
        )
        self.assertEqual(actual_origin, origin)
        self.assertEqual(cookie, f"{tunnel.COOKIE}={preview_token}")
        self.assertEqual(lifetime, 1800)
        self.assertEqual(
            [request.full_url for request in sent],
            [f"{tunnel.GATEWAY}/v1/preview/open", f"{origin}/_tengri/bootstrap"],
        )
        self.assertEqual(json.loads(sent[0].data), {"token": "b" * 43})
        self.assertEqual(json.loads(sent[1].data), {"token": preview_token})
        self.assertTrue(all(request.get_header("Cookie") is None for request in sent))

    def test_bootstrap_cannot_redirect_to_another_origin(self):
        class Opener:
            def open(self, request, timeout):
                response = BytesIO(
                    json.dumps(
                        {
                            "location": f"https://attacker.example/_tengri/preview/open#{'c' * 43}"
                        }
                    ).encode()
                )
                response.headers = Message()
                return response

        with self.assertRaises(tunnel.ConnectionError):
            tunnel.exchange_connection(self.connection(), Opener())
        with self.assertRaises(tunnel.ConnectionError):
            tunnel.NoRedirect().redirect_request(
                None, None, 302, "redirect", Message(), "https://attacker.example"
            )

    def test_file_is_private_fresh_regular_owned_and_bounded(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "connection.json"
            path.write_text(json.dumps(self.connection()))
            path.chmod(0o644)
            value, _ = tunnel.read_connection(path)
            self.assertEqual(value, self.connection())
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            link = Path(root) / "link.json"
            link.symlink_to(path)
            with self.assertRaises(OSError):
                tunnel.read_connection(link)
            os.utime(path, (time.time() - 31, time.time() - 31))
            with self.assertRaises(tunnel.ConnectionError):
                tunnel.read_connection(path)
            path.write_bytes(b"x" * (tunnel.MAX_JSON + 1))
            with self.assertRaises(tunnel.ConnectionError):
                tunnel.read_connection(path)

    def test_cookie_references_are_only_on_the_backend_profile(self):
        profile = tunnel.tunnel_profile(
            "tunnel_" + "a" * 32, self.connection()["previewOrigin"], "/private/cookie"
        )
        self.assertNotIn("extra_headers", profile["control_plane"])
        self.assertEqual(
            profile["control_plane"]["api_key"], "env:CONTROL_PLANE_API_KEY"
        )
        self.assertEqual(
            profile["mcp"]["extra_headers"], {"Cookie": "file:/private/cookie"}
        )
        self.assertEqual(
            profile["mcp"]["discovery_extra_headers"],
            {"Cookie": "file:/private/cookie"},
        )

    def test_interrupt_stops_the_child_and_removes_credentials(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "connection.json"
            path.write_text(json.dumps(self.connection()))
            profiles = []

            class Child:
                stopped = False

                def wait(self, timeout):
                    if not self.stopped:
                        raise KeyboardInterrupt
                    return 0

                def poll(self):
                    return 0 if self.stopped else None

                def terminate(self):
                    self.stopped = True

            child = Child()

            def start(arguments, env):
                profile = Path(arguments[-1])
                profiles.append(profile)
                self.assertTrue((profile.parent / "cookie").exists())
                self.assertNotIn("MCP_SERVER_URL", env)
                return child

            with (
                patch.object(tunnel.sys, "argv", ["browser-mcp-tunnel.py", str(path)]),
                patch.object(tunnel.shutil, "which", return_value="tunnel-client"),
                patch.object(
                    tunnel,
                    "exchange_connection",
                    return_value=(
                        self.connection()["previewOrigin"],
                        "private-cookie",
                        1800,
                    ),
                ),
                patch.object(tunnel.subprocess, "Popen", side_effect=start),
                patch.dict(
                    os.environ,
                    {
                        "CONTROL_PLANE_TUNNEL_ID": "tunnel_" + "a" * 32,
                        "CONTROL_PLANE_API_KEY": "test-key",
                        "MCP_SERVER_URL": "https://unrelated.example/mcp",
                    },
                ),
                redirect_stdout(StringIO()),
                self.assertRaises(KeyboardInterrupt),
            ):
                tunnel.main()
            self.assertTrue(child.stopped)
            self.assertFalse(path.exists())
            self.assertEqual(len(profiles), 1)
            self.assertFalse(profiles[0].parent.exists())


if __name__ == "__main__":
    unittest.main()
