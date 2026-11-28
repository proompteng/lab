#!/usr/bin/env python3
"""Expose guest service readiness without creating a Kata exec process."""

import pathlib
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def ready():
    if not pathlib.Path("/run/devbox-ready").is_file():
        return False
    try:
        result = subprocess.run(
            ["systemctl", "is-active", "ssh", "docker"],
            capture_output=True,
            text=True,
            timeout=3,
            check=False,
        )
        return result.returncode == 0 and result.stdout.splitlines() == [
            "active",
            "active",
        ]
    except (OSError, subprocess.TimeoutExpired):
        return False


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/healthz":
            self.send_error(404)
            return
        status = 200 if ready() else 503
        body = b"ready\n" if status == 200 else b"not ready\n"
        self.send_response(status)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format, *_args):
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
