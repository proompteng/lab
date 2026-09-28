#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


DEFAULT_BASE_URL = "http://synthesis.synthesis.svc.cluster.local:3000"


ENDPOINTS = {
    "start-session": ("POST", "/api/autotrader/sessions"),
    "status": ("POST", "/api/autotrader/status"),
    "event": ("POST", "/api/autotrader/events"),
    "ticket": ("POST", "/api/autotrader/trade-tickets"),
    "risk": ("POST", "/api/autotrader/risk-checks"),
    "order": ("POST", "/api/autotrader/orders"),
    "fill": ("POST", "/api/autotrader/fills"),
    "position": ("POST", "/api/autotrader/position-snapshots"),
    "finalize": ("POST", "/api/autotrader/finalize"),
}


class SynthesisClient:
    def __init__(self, *, base_url: str | None = None, token: str | None = None, timeout_seconds: float = 10.0):
        self.base_url = (base_url or os.environ.get("SYNTHESIS_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")
        self.token = token if token is not None else read_token()
        self.timeout_seconds = timeout_seconds

    def get(self, path: str, query: dict[str, str] | None = None) -> Any:
        url = f"{self.base_url}{path}"
        if query:
            url = f"{url}?{urllib.parse.urlencode(query)}"
        return self._request("GET", url)

    def post(self, path: str, payload: dict[str, Any]) -> Any:
        return self._request("POST", f"{self.base_url}{path}", payload)

    def _request(self, method: str, url: str, payload: dict[str, Any] | None = None) -> Any:
        data = None if payload is None else json.dumps(payload).encode("utf-8")
        headers = {"accept": "application/json"}
        if payload is not None:
            headers["content-type"] = "application/json"
        if self.token:
            headers["authorization"] = f"Bearer {self.token}"
        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                body = response.read().decode("utf-8")
                return json.loads(body) if body else {"ok": True, "status": response.status}
        except urllib.error.HTTPError as error:
            body = error.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"Synthesis HTTP {error.code} for {method} {url}: {body}") from error


def read_token() -> str | None:
    token = os.environ.get("SYNTHESIS_API_TOKEN", "").strip()
    if token:
        return token
    token_file = os.environ.get("SYNTHESIS_API_TOKEN_FILE", "/var/run/synthesis/SYNTHESIS_API_TOKEN")
    path = Path(token_file)
    if path.exists():
        return path.read_text(encoding="utf-8").strip()
    return None


def load_payload(path: str | None) -> dict[str, Any]:
    if not path or path == "-":
        return json.loads(sys.stdin.read())
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("payload must be a JSON object")
    return payload


def write_output(payload: Any, output: str | None) -> None:
    text = json.dumps(payload, sort_keys=True, indent=2)
    if output:
        Path(output).parent.mkdir(parents=True, exist_ok=True)
        Path(output).write_text(f"{text}\n", encoding="utf-8")
    else:
        print(text)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Direct Synthesis autotrader HTTP fallback client.")
    parser.add_argument("--base-url")
    parser.add_argument("--timeout-seconds", type=float, default=10.0)
    parser.add_argument("--self-test", action="store_true")
    subparsers = parser.add_subparsers(dest="command")

    for command in ENDPOINTS:
        subparser = subparsers.add_parser(command)
        subparser.add_argument("--input", required=True)
        subparser.add_argument("--output")

    sessions = subparsers.add_parser("sessions")
    sessions.add_argument("--limit", default="20")
    sessions.add_argument("--output")

    session = subparsers.add_parser("session")
    session.add_argument("session_id")
    session.add_argument("--output")

    scorecards = subparsers.add_parser("scorecards")
    scorecards.add_argument("--symbol")
    scorecards.add_argument("--setup-type")
    scorecards.add_argument("--setup-grade")
    scorecards.add_argument("--regime")
    scorecards.add_argument("--time-bucket")
    scorecards.add_argument("--limit", default="20")
    scorecards.add_argument("--output")

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.self_test:
        payload = {
            "ok": True,
            "baseUrl": args.base_url or os.environ.get("SYNTHESIS_BASE_URL") or DEFAULT_BASE_URL,
            "mutatingEndpoints": sorted(ENDPOINTS),
            "hasToken": bool(read_token()),
        }
        write_output(payload, None)
        return 0
    client = SynthesisClient(base_url=args.base_url, timeout_seconds=args.timeout_seconds)
    if args.command in ENDPOINTS:
        method, path = ENDPOINTS[args.command]
        if method != "POST":
            raise ValueError(f"Unsupported mutating method {method}")
        write_output(client.post(path, load_payload(args.input)), args.output)
        return 0
    if args.command == "sessions":
        write_output(client.get("/api/autotrader/sessions", {"limit": args.limit}), args.output)
        return 0
    if args.command == "session":
        write_output(client.get(f"/api/autotrader/sessions/{urllib.parse.quote(args.session_id)}"), args.output)
        return 0
    if args.command == "scorecards":
        query = {
            key: value
            for key, value in {
                "symbol": args.symbol,
                "setupType": args.setup_type,
                "setupGrade": args.setup_grade,
                "regime": args.regime,
                "timeBucket": args.time_bucket,
                "limit": args.limit,
            }.items()
            if value
        }
        write_output(client.get("/api/autotrader/scorecards", query), args.output)
        return 0
    raise SystemExit("command is required unless --self-test is set")


if __name__ == "__main__":
    raise SystemExit(main())
