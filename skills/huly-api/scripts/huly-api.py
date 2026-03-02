#!/usr/bin/env python3
"""Minimal authenticated Huly API client for swarm agents."""

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request


def env_first(*keys: str) -> str:
    for key in keys:
        value = os.getenv(key, "").strip()
        if value:
            return value
    return ""


def join_url(base_url: str, path: str) -> str:
    normalized_base = base_url.rstrip("/")
    normalized_path = path if path.startswith("/") else f"/{path}"
    return f"{normalized_base}{normalized_path}"


def maybe_parse_json(value: str):
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return value


def parse_headers(raw_headers: list[str]) -> dict[str, str]:
    headers: dict[str, str] = {}
    for header in raw_headers:
        if ":" not in header:
            raise ValueError(f"invalid header format (expected key:value): {header}")
        key, value = header.split(":", 1)
        headers[key.strip()] = value.strip()
    return headers


def main() -> int:
    parser = argparse.ArgumentParser(description="Call Huly API endpoints with bearer auth.")
    parser.add_argument("--method", default="GET", help="HTTP method")
    parser.add_argument("--path", required=True, help="API path, for example /api/issues")
    parser.add_argument("--data", default="", help="JSON payload string for write operations")
    parser.add_argument("--token", default="", help="Override bearer token (defaults to env)")
    parser.add_argument(
        "--base-url",
        default="",
        help="Override base URL (defaults to HULY_API_BASE_URL or HULY_BASE_URL)",
    )
    parser.add_argument("--header", action="append", default=[], help="Extra header in key:value format")
    parser.add_argument("--timeout-seconds", type=int, default=30, help="Request timeout")
    args = parser.parse_args()

    base_url = args.base_url.strip() or env_first("HULY_API_BASE_URL", "HULY_BASE_URL")
    if not base_url:
        print("missing HULY_API_BASE_URL/HULY_BASE_URL", file=sys.stderr)
        return 2

    token = args.token.strip() or env_first("HULY_API_TOKEN", "HULY_TOKEN")
    if not token:
        print("missing HULY_API_TOKEN/HULY_TOKEN", file=sys.stderr)
        return 2

    method = args.method.upper().strip() or "GET"
    url = join_url(base_url, args.path)

    body = None
    headers = {
        "Accept": "application/json",
        "Authorization": f"Bearer {token}",
    }
    headers.update(parse_headers(args.header))

    if args.data:
        payload = maybe_parse_json(args.data)
        if isinstance(payload, (dict, list)):
            body = json.dumps(payload).encode("utf-8")
            headers.setdefault("Content-Type", "application/json")
        else:
            body = str(payload).encode("utf-8")
            headers.setdefault("Content-Type", "text/plain; charset=utf-8")

    request = urllib.request.Request(url=url, method=method, headers=headers, data=body)

    try:
        with urllib.request.urlopen(request, timeout=args.timeout_seconds) as response:
            raw_body = response.read().decode("utf-8", errors="replace")
            content_type = response.headers.get("Content-Type", "")
            if "json" in content_type.lower():
                parsed = maybe_parse_json(raw_body)
                if isinstance(parsed, (dict, list)):
                    print(json.dumps(parsed, indent=2, sort_keys=True))
                else:
                    print(raw_body)
            else:
                print(raw_body)
            return 0
    except urllib.error.HTTPError as error:
        error_body = error.read().decode("utf-8", errors="replace")
        print(
            json.dumps(
                {
                    "status": error.code,
                    "reason": error.reason,
                    "url": url,
                    "body": maybe_parse_json(error_body),
                },
                indent=2,
                sort_keys=True,
            ),
            file=sys.stderr,
        )
        return 1
    except urllib.error.URLError as error:
        print(f"request failed: {error.reason}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
