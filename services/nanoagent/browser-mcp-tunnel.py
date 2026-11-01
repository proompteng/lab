#!/usr/bin/env python3
"""Connect a fresh Tengri browser grant to a dedicated private OpenAI MCP tunnel."""

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from http.cookies import SimpleCookie
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

GATEWAY = "https://tengri.proompteng.ai"
TOKEN = re.compile(r"[A-Za-z0-9_-]{43}")
COOKIE = "__Host-tengri_preview"
MAX_JSON = 64 * 1024


class ConnectionError(Exception):
    pass


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ConnectionError("Tengri unexpectedly redirected the connection request")


def launch_token(value, origin, path):
    if not isinstance(value, str):
        raise ConnectionError("Invalid Tengri connection URL")
    url = urlsplit(value)
    if (
        f"{url.scheme}://{url.netloc}" != origin
        or url.path != path
        or url.query
        or not TOKEN.fullmatch(url.fragment)
    ):
        raise ConnectionError("Invalid Tengri connection URL")
    return url.fragment


def validate_connection(value):
    if not isinstance(value, dict) or value.get("version") != 1:
        raise ConnectionError("Unsupported Tengri connection file")
    identity = value.get("id")
    if not isinstance(identity, str) or not re.fullmatch(r"[a-z0-9]{24}", identity):
        raise ConnectionError("Invalid Tengri browser identity")
    origin = f"https://tengri-{identity}.proompteng.ai"
    if value.get("previewOrigin") != origin:
        raise ConnectionError("Invalid Tengri browser origin")
    return origin, launch_token(value.get("launchUrl"), GATEWAY, "/v1/preview/open")


def post_json(opener, url, payload):
    request = Request(
        url,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    try:
        with opener.open(request, timeout=10) as response:
            body = response.read(MAX_JSON + 1)
            if len(body) > MAX_JSON:
                raise ConnectionError(
                    "Tengri returned an oversized connection response"
                )
            return json.loads(body), response.headers
    except HTTPError as error:
        error.close()
        raise ConnectionError(
            f"Tengri rejected the connection (HTTP {error.code}); download a fresh connection"
        ) from None
    except (URLError, TimeoutError, OSError):
        raise ConnectionError("Could not reach Tengri securely") from None
    except (ValueError, UnicodeError):
        raise ConnectionError(
            "Tengri returned an invalid connection response"
        ) from None


def exchange_connection(connection, opener):
    origin, token = validate_connection(connection)
    opened, _ = post_json(opener, f"{GATEWAY}/v1/preview/open", {"token": token})
    if not isinstance(opened, dict):
        raise ConnectionError("Invalid Tengri launch response")
    preview_token = launch_token(
        opened.get("location"), origin, "/_tengri/preview/open"
    )
    lease, headers = post_json(
        opener, f"{origin}/_tengri/bootstrap", {"token": preview_token}
    )
    cookies = SimpleCookie()
    for header in headers.get_all("Set-Cookie", []):
        cookies.load(header)
    cookie = cookies.get(COOKIE)
    if (
        cookie is None
        or cookie.value != preview_token
        or not cookie["secure"]
        or not cookie["httponly"]
        or cookie["path"] != "/"
        or cookie["domain"]
    ):
        raise ConnectionError("Tengri did not issue a private browser cookie")
    lifetime = lease.get("expiresInMs") if isinstance(lease, dict) else None
    if type(lifetime) is not int or not 0 < lifetime <= 30 * 60 * 1000:
        raise ConnectionError("Invalid Tengri browser lease")
    return origin, f"{COOKIE}={cookie.value}", lifetime / 1000


def read_connection(path):
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), "rb") as source:
        info = os.fstat(source.fileno())
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.getuid()
            or info.st_size > MAX_JSON
            or time.time() - info.st_mtime > 30
        ):
            raise ConnectionError(
                "Download a fresh Tengri connection file after starting this helper"
            )
        os.fchmod(source.fileno(), 0o600)
        value = json.load(source)
        validate_connection(value)
        return value, info


def tunnel_profile(tunnel_id, origin, cookie_file):
    # JSON is also YAML; no parser dependency or generated credential-bearing command line.
    return {
        "config_version": 1,
        "control_plane": {
            "tunnel_id": tunnel_id,
            "api_key": "env:CONTROL_PLANE_API_KEY",
            "poll_channels": ["main"],
        },
        "mcp": {
            "server_urls": [{"channel": "main", "url": f"{origin}/mcp"}],
            "extra_headers": {"Cookie": f"file:{cookie_file}"},
            "discovery_extra_headers": {"Cookie": f"file:{cookie_file}"},
        },
        "health": {"listen_addr": "127.0.0.1:0"},
        "log": {"level": "warn"},
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "connection",
        type=Path,
        nargs="?",
        default=Path.home() / "Downloads/tengri-browser-connection.json",
    )
    args = parser.parse_args()
    binary = shutil.which("tunnel-client")
    if not binary:
        raise ConnectionError("Install OpenAI's tunnel-client before connecting")
    tunnel_id = os.environ.get("CONTROL_PLANE_TUNNEL_ID", "")
    if not re.fullmatch(r"tunnel_(?:[a-z0-9]{4}_)?[a-z0-9]{32}", tunnel_id):
        raise ConnectionError(
            "Set CONTROL_PLANE_TUNNEL_ID to a dedicated private browser tunnel"
        )
    if not os.environ.get("CONTROL_PLANE_API_KEY"):
        raise ConnectionError("Set CONTROL_PLANE_API_KEY to the tunnel runtime key")
    print(
        "Waiting for Connect ChatGPT → Download connection in Tengri Chrome…",
        flush=True,
    )
    deadline = time.monotonic() + 300
    while not args.connection.exists():
        if time.monotonic() >= deadline:
            raise ConnectionError("No connection file arrived within five minutes")
        time.sleep(0.2)
    connection, info = read_connection(args.connection)
    try:
        origin, cookie, lifetime = exchange_connection(
            connection, build_opener(NoRedirect(), ProxyHandler({}))
        )
    finally:
        current = args.connection.lstat()
        if (current.st_dev, current.st_ino) == (info.st_dev, info.st_ino):
            args.connection.unlink()
    with tempfile.TemporaryDirectory(prefix="tengri-browser-tunnel-") as directory:
        root = Path(directory)
        cookie_file = root / "cookie"
        cookie_file.write_text(cookie)
        cookie_file.chmod(0o600)
        profile_file = root / "profile.json"
        profile_file.write_text(
            json.dumps(tunnel_profile(tunnel_id, origin, cookie_file))
        )
        profile_file.chmod(0o600)
        # Explicit profile and a small environment prevent inheriting other MCP targets or unsafe logging.
        environment = {
            name: os.environ[name]
            for name in (
                "PATH",
                "HOME",
                "LANG",
                "TMPDIR",
                "SSL_CERT_FILE",
                "SSL_CERT_DIR",
                "CONTROL_PLANE_API_KEY",
                "CONTROL_PLANE_ORGANIZATION_ID",
            )
            if name in os.environ
        }
        child = subprocess.Popen(
            [binary, "run", "--profile-file", str(profile_file)], env=environment
        )
        print(
            "Private browser tunnel started. Take control pauses tools; closing Tengri Chrome revokes access.",
            flush=True,
        )
        try:
            result = child.wait(timeout=lifetime)
            if result:
                raise ConnectionError(
                    "The OpenAI tunnel client stopped; create a fresh connection to retry"
                )
        except subprocess.TimeoutExpired:
            print(
                "The browser connection has expired. Download a fresh connection to reconnect."
            )
        finally:
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
    except ConnectionError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except (OSError, ValueError):
        # Unexpected input and network exceptions may contain a bearer fragment. Never print their raw values.
        print(
            "Browser connection failed. Check tunnel settings and download a fresh Tengri connection.",
            file=sys.stderr,
        )
        sys.exit(1)
