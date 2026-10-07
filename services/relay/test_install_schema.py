import contextlib
import importlib.util
import io
import json
from pathlib import Path
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    "installer", Path(__file__).with_name("install-schema.py")
)
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class SchemaInstallationTests(unittest.TestCase):
    def run_installer(self, existing, apply=False):
        state = {"schema": existing, "writes": 0}

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                if self.headers["Authorization"] != "Bearer fixture-key":
                    self.send_error(403)
                    return
                if self.path == "/v1/schema/write":
                    state["writes"] += 1
                    state["schema"] = body["schema"]
                    result = {}
                    status = 200
                elif state["schema"] is None:
                    result, status = {"code": 5}, 404
                else:
                    result, status = {"schemaText": state["schema"]}, 200
                self.send_response(status)
                self.end_headers()
                self.wfile.write(json.dumps(result).encode())

        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        args = [
            "install-schema",
            "--endpoint",
            f"http://127.0.0.1:{server.server_port}",
        ]
        if apply:
            args.append("--apply")
        try:
            with (
                patch("sys.argv", args),
                patch.dict("os.environ", {"OFZ_TEST_TOKEN": "fixture-key"}),
                contextlib.redirect_stdout(io.StringIO()),
            ):
                installer.main()
        finally:
            server.shutdown()
            server.server_close()
            thread.join()
        return state

    def test_dry_run_does_not_write(self):
        self.assertEqual(self.run_installer(None)["writes"], 0)

    def test_empty_schema_is_installed_and_read_back(self):
        state = self.run_installer(None, apply=True)
        self.assertEqual(state["writes"], 1)
        self.assertEqual(
            installer.normalized(state["schema"]),
            installer.normalized(Path(__file__).with_name("schema.zed").read_text()),
        )

    def test_existing_matching_schema_is_idempotent(self):
        schema = Path(__file__).with_name("schema.zed").read_text()
        self.assertEqual(self.run_installer(schema, apply=True)["writes"], 0)

    def test_other_application_schema_is_preserved(self):
        with self.assertRaisesRegex(RuntimeError, "refusing to replace"):
            self.run_installer("definition unrelated_user {}", apply=True)


if __name__ == "__main__":
    unittest.main()
