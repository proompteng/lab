#!/usr/bin/env python3
import http.server
import os
from pathlib import Path


EXPECTED_NONCE = os.environ["EXPECTED_NONCE"]
READY_PATH = Path("/work/agent-callback.json")


class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/ready":
            self.send_error(404)
            return

        if self.headers.get("X-Bootstrap-Nonce") != EXPECTED_NONCE:
            self.send_error(403)
            return

        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)
        READY_PATH.write_bytes(body)
        self.send_response(204)
        self.end_headers()

    def log_message(self, format: str, *args: object) -> None:
        print(f"HOST_CALLBACK {format % args}", flush=True)


if __name__ == "__main__":
    http.server.ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
