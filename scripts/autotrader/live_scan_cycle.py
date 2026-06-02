#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import urllib.error
import urllib.parse
import urllib.request
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from protective_preflight import assert_paper_base_url, normalize_alpaca_base_url
from synthesis_autotrader_client import SynthesisClient


DEFAULT_DATA_BASE_URL = "https://data.alpaca.markets/v2"
DEFAULT_WATCHLIST = ("SPY", "QQQ", "NVDA", "AVGO", "TSLA", "AAPL", "MSFT", "AMD", "PLTR", "GOOGL")
MARKET_TIMEZONE = ZoneInfo("America/New_York")


class AlpacaRestClient:
    def __init__(
        self,
        *,
        trading_base_url: str | None = None,
        data_base_url: str | None = None,
        timeout_seconds: float = 10.0,
    ):
        self.trading_base_url = normalize_alpaca_base_url(
            trading_base_url or os.environ.get("APCA_API_BASE_URL") or "https://paper-api.alpaca.markets"
        )
        assert_paper_base_url(self.trading_base_url)
        self.data_base_url = normalize_alpaca_data_base_url(
            data_base_url or os.environ.get("ALPACA_DATA_BASE_URL") or DEFAULT_DATA_BASE_URL
        )
        self.key_id = (
            os.environ.get("APCA_API_KEY_ID")
            or os.environ.get("ALPACA_API_KEY_ID")
            or os.environ.get("ALPACA_API_KEY")
        )
        self.secret_key = os.environ.get("APCA_API_SECRET_KEY") or os.environ.get("ALPACA_SECRET_KEY")
        self.timeout_seconds = timeout_seconds
        if not self.key_id or not self.secret_key:
            raise RuntimeError("Alpaca credentials are required for live scan cycle")

    def trading_get(self, path: str, query: dict[str, str] | None = None) -> Any:
        return self._request(self.trading_base_url, path, query)

    def data_get(self, path: str, query: dict[str, str]) -> Any:
        return self._request(self.data_base_url, path, query)

    def _request(self, base_url: str, path: str, query: dict[str, str] | None = None) -> Any:
        url = f"{base_url}{path}"
        if query:
            url = f"{url}?{urllib.parse.urlencode(query)}"
        request = urllib.request.Request(
            url,
            headers={
                "accept": "application/json",
                "APCA-API-KEY-ID": self.key_id,
                "APCA-API-SECRET-KEY": self.secret_key,
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                body = response.read().decode("utf-8")
                return json.loads(body) if body else {"ok": True, "status": response.status}
        except urllib.error.HTTPError as error:
            body = error.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"Alpaca HTTP {error.code} for GET {url}: {body}") from error


def normalize_alpaca_data_base_url(base_url: str) -> str:
    trimmed = base_url.rstrip("/")
    parsed = urllib.parse.urlparse(trimmed)
    path = parsed.path.rstrip("/")
    if path.endswith("/v2"):
        next_path = path
    else:
        next_path = f"{path}/v2" if path else "/v2"
    if not parsed.scheme or not parsed.netloc:
        return trimmed
    return urllib.parse.urlunparse(parsed._replace(path=next_path, params="", query="", fragment="")).rstrip("/")


def normalize_watchlist(values: list[str]) -> list[str]:
    symbols = values or list(DEFAULT_WATCHLIST)
    normalized: list[str] = []
    seen: set[str] = set()
    for value in symbols:
        symbol = value.strip().upper()
        if not symbol or symbol in seen:
            continue
        seen.add(symbol)
        normalized.append(symbol)
    if not normalized:
        raise ValueError("watchlist cannot be empty")
    return normalized


def next_cycle_number(work_dir: Path) -> int:
    max_cycle = 0
    pattern = re.compile(r"^cycle-(\d+)$")
    for path in work_dir.glob("cycle-*"):
        match = pattern.match(path.name)
        if match:
            max_cycle = max(max_cycle, int(match.group(1)))
    return max_cycle + 1


def prune_old_cycle_dirs(work_dir: Path, retain_cycles: int) -> list[str]:
    if retain_cycles < 1:
        return []
    cycles: list[tuple[int, Path]] = []
    pattern = re.compile(r"^cycle-(\d+)$")
    for path in work_dir.glob("cycle-*"):
        if not path.is_dir():
            continue
        match = pattern.match(path.name)
        if match:
            cycles.append((int(match.group(1)), path))
    cycles.sort(key=lambda item: item[0])
    stale_cycles = cycles[: max(0, len(cycles) - retain_cycles)]
    removed: list[str] = []
    for _, path in stale_cycles:
        shutil.rmtree(path)
        removed.append(path.name)
    return removed


def format_account(account: dict[str, Any]) -> dict[str, Any]:
    return {
        "account": {
            "id": account.get("id"),
            "equity": account.get("equity"),
            "cash": account.get("cash"),
            "buying_power": account.get("buying_power"),
            "daytrading_buying_power": account.get("daytrading_buying_power") or account.get("daytrade_buying_power"),
            "trading_blocked": bool(account.get("trading_blocked", False)),
            "account_blocked": bool(account.get("account_blocked", False)),
        }
    }


def format_latest_quotes(payload: dict[str, Any], symbols: list[str]) -> dict[str, Any]:
    raw_quotes = payload.get("quotes") if isinstance(payload, dict) else None
    if not isinstance(raw_quotes, dict):
        raw_quotes = {}
    quotes: dict[str, dict[str, Any]] = {}
    for symbol in symbols:
        quote = raw_quotes.get(symbol) or raw_quotes.get(symbol.upper()) or {}
        if not isinstance(quote, dict):
            quote = {}
        bid = quote.get("bid") if "bid" in quote else quote.get("bp")
        ask = quote.get("ask") if "ask" in quote else quote.get("ap")
        quotes[symbol] = {"symbol": symbol, "bid": bid, "ask": ask}
    return {"quotes": quotes}


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"{json.dumps(payload, separators=(',', ':'), sort_keys=True)}\n", encoding="utf-8")


def market_open_start(now: datetime) -> str:
    market_day = now.astimezone(MARKET_TIMEZONE).date()
    market_open = datetime(market_day.year, market_day.month, market_day.day, 9, 30, tzinfo=MARKET_TIMEZONE)
    return market_open.astimezone(UTC).isoformat().replace("+00:00", "Z")


def stock_analysis_cli_path(value: str | None) -> str:
    if value:
        return value
    artifact_dir = os.environ.get("AUTONOMOUS_TRADER_ARTIFACT_DIR", "/workspace/.agentrun/autonomous-trader")
    return str(Path(artifact_dir) / "stock_analysis")


def run_stock_analysis_scan(
    *,
    stock_analysis_cli: str,
    cycle_dir: Path,
    analysis_context_path: Path,
    watchlist: list[str],
) -> dict[str, Any]:
    live_scan_input = cycle_dir / "live-scan-input.json"
    live_scan = cycle_dir / "live-scan.json"
    build_command = [
        stock_analysis_cli,
        "build-live-scan-input",
        "--bars",
        str(cycle_dir / "bars.json"),
        "--quotes",
        str(cycle_dir / "quotes.json"),
        "--account",
        str(cycle_dir / "account.json"),
        "--positions",
        str(cycle_dir / "positions.json"),
        "--open-orders",
        str(cycle_dir / "open-orders.json"),
        "--scorecards",
        str(cycle_dir / "scorecards.json"),
        "--analysis-context",
        str(analysis_context_path),
        "--require-live-state",
        "--max-input-age-seconds",
        "1800",
        "--output",
        str(live_scan_input),
    ]
    for symbol in watchlist:
        build_command.extend(["--watchlist", symbol])
    subprocess.run(build_command, check=True)
    subprocess.run(
        [stock_analysis_cli, "daytrading-scan", "--input", str(live_scan_input), "--output", str(live_scan)],
        check=True,
    )
    payload = json.loads(live_scan.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("scanner output must be a JSON object")
    return payload


def fetch_scan_inputs(
    *,
    alpaca: AlpacaRestClient,
    synthesis: SynthesisClient,
    symbols: list[str],
    start: str,
    end: str,
    feed: str,
    scorecard_limit: int,
) -> dict[str, Any]:
    account = format_account(alpaca.trading_get("/v2/account"))
    positions = alpaca.trading_get("/v2/positions")
    orders = alpaca.trading_get("/v2/orders", {"status": "open", "nested": "true"})
    bars = alpaca.data_get(
        "/stocks/bars",
        {
            "symbols": ",".join(symbols),
            "timeframe": "1Min",
            "start": start,
            "end": end,
            "limit": "1000",
            "feed": feed,
            "sort": "asc",
        },
    )
    quotes = format_latest_quotes(
        alpaca.data_get("/stocks/quotes/latest", {"symbols": ",".join(symbols), "feed": feed}),
        symbols,
    )
    scorecards = synthesis.get("/api/autotrader/scorecards", {"limit": str(scorecard_limit)})
    return {
        "account.json": account,
        "positions.json": {"positions": positions if isinstance(positions, list) else []},
        "open-orders.json": {"orders": orders if isinstance(orders, list) else []},
        "bars.json": bars,
        "quotes.json": quotes,
        "scorecards.json": scorecards,
        "watchlist.json": {"watchlist": symbols},
    }


def summarize_scan(
    cycle: int,
    cycle_dir: Path,
    scan: dict[str, Any],
    symbols: list[str],
    *,
    retained_cycles: int,
    removed_cycle_dirs: list[str],
) -> dict[str, Any]:
    results = scan.get("results")
    if not isinstance(results, list):
        results = []
    top_results = []
    for result in results[:10]:
        if not isinstance(result, dict):
            continue
        top_results.append(
            {
                key: result.get(key)
                for key in (
                    "symbol",
                    "bars",
                    "setup_type",
                    "setup_grade",
                    "fat_pitch",
                    "expected_r",
                    "no_trade_reason",
                    "last",
                    "vwap",
                    "spread_pct",
                    "liquidity_score",
                    "momentum_score",
                    "risk_notes",
                )
            }
        )
    return {
        "ok": True,
        "cycle": cycle,
        "cycleDir": str(cycle_dir),
        "retainedCycles": retained_cycles,
        "removedCycleDirs": removed_cycle_dirs,
        "watchlist": symbols,
        "resultCount": len(results),
        "topResults": top_results,
    }


def run_cycle(args: argparse.Namespace) -> dict[str, Any]:
    symbols = normalize_watchlist(args.watchlist)
    work_dir = Path(args.work_dir or os.environ.get("AUTONOMOUS_TRADER_WORK_DIR", "/tmp/autonomous-trader-work"))
    cycle = args.cycle if args.cycle is not None else next_cycle_number(work_dir)
    cycle_dir = work_dir / f"cycle-{cycle}"
    cycle_dir.mkdir(parents=True, exist_ok=True)
    now = datetime.now(UTC)
    end = args.end or now.isoformat().replace("+00:00", "Z")
    start = args.start or market_open_start(now)
    alpaca = AlpacaRestClient(timeout_seconds=args.timeout_seconds)
    synthesis = SynthesisClient(base_url=args.synthesis_base_url, timeout_seconds=args.timeout_seconds)
    inputs = fetch_scan_inputs(
        alpaca=alpaca,
        synthesis=synthesis,
        symbols=symbols,
        start=start,
        end=end,
        feed=args.feed,
        scorecard_limit=args.scorecard_limit,
    )
    for name, payload in inputs.items():
        write_json(cycle_dir / name, payload)
    analysis_context = Path(
        args.analysis_context or os.environ.get("ANALYSIS_CONTEXT_PATH") or work_dir / "analysis-context.json"
    )
    scan = run_stock_analysis_scan(
        stock_analysis_cli=stock_analysis_cli_path(args.stock_analysis_cli),
        cycle_dir=cycle_dir,
        analysis_context_path=analysis_context,
        watchlist=symbols,
    )
    removed_cycle_dirs = prune_old_cycle_dirs(work_dir, args.retain_cycles)
    return summarize_scan(
        cycle,
        cycle_dir,
        scan,
        symbols,
        retained_cycles=args.retain_cycles,
        removed_cycle_dirs=removed_cycle_dirs,
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run one autonomous-trader live scan cycle.")
    parser.add_argument("--work-dir")
    parser.add_argument("--cycle", type=int)
    parser.add_argument("--watchlist", action="append", default=[])
    parser.add_argument("--start")
    parser.add_argument("--end")
    parser.add_argument("--feed", default="iex")
    parser.add_argument("--scorecard-limit", type=int, default=20)
    parser.add_argument("--timeout-seconds", type=float, default=10.0)
    parser.add_argument("--synthesis-base-url")
    parser.add_argument("--analysis-context")
    parser.add_argument("--stock-analysis-cli")
    parser.add_argument("--retain-cycles", type=int, default=5)
    parser.add_argument("--self-test", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.self_test:
        payload = {
            "ok": True,
            "defaultWatchlist": list(DEFAULT_WATCHLIST),
            "stockAnalysisCli": stock_analysis_cli_path(args.stock_analysis_cli),
        }
        print(json.dumps(payload, sort_keys=True, indent=2))
        return 0
    print(json.dumps(run_cycle(args), sort_keys=True, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
