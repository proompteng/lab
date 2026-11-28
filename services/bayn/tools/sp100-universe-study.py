"""Audit a frozen, paginated Alpaca capture; never place orders or fill missing bars."""

import argparse
import csv
import hashlib
import io
import json
import math
import statistics
from collections import Counter
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit, urlunsplit
from zoneinfo import ZoneInfo


def load(root, name):
    return json.loads((root / name).read_text())


def percentile(values, p):
    ordered = sorted(values)
    return ordered[math.ceil(len(ordered) * p) - 1] if ordered else None


def instant(value):
    return datetime.fromisoformat(value)


def source_rows(root, manifest, dataset):
    result = {}
    continuations = {}
    for request in manifest:
        if dataset == "expanded":
            selected = request["file"].startswith("expanded-quotes-")
        else:
            selected = ("-" + dataset + "-") in request["file"]
        if not selected:
            continue
        url = urlsplit(request["url"])
        query = parse_qs(url.query)
        token = query.pop("page_token", [None])[0]
        key = urlunsplit(
            (
                url.scheme,
                url.netloc,
                url.path,
                urlencode(sorted(query.items()), doseq=True),
                "",
            )
        )
        if key in continuations and continuations[key] != token:
            raise ValueError(
                "broken or duplicated provider pagination: " + request["file"]
            )
        if key not in continuations and token is not None:
            raise ValueError("first provider page is missing: " + request["file"])
        response = load(root, request["file"])
        content = response[
            "quotes" if "quotes" in dataset or dataset == "expanded" else "bars"
        ]
        for symbol, rows in content.items():
            if symbol not in query["symbols"][0].split(","):
                raise ValueError("unrequested source symbol: " + symbol)
            result.setdefault(symbol, []).extend(rows)
        continuations[key] = response.get("next_page_token")
    if any(token is not None for token in continuations.values()):
        raise ValueError("source pagination has an unconsumed continuation: " + dataset)
    return result


def sampled_seconds(rows, sessions, maximum_quote_age_ms=10_000):
    eastern = ZoneInfo("America/New_York")
    ordered = sorted(rows, key=lambda q: instant(q["t"]))
    index = 0
    fresh = 0
    eligible = 0
    total = len(sessions) * 3 * 20
    for session in sessions:
        for hour in (10, 12, 14):
            begin = datetime.fromisoformat(session["date"] + f"T{hour}:00:00").replace(
                tzinfo=eastern
            )
            last = None
            for second in range(20):
                at = begin + timedelta(seconds=second)
                while index < len(ordered) and instant(ordered[index]["t"]) <= at:
                    last = ordered[index]
                    index += 1
                if (
                    last is None
                    or not 0
                    <= (at - instant(last["t"])).total_seconds() * 1000
                    <= maximum_quote_age_ms
                ):
                    continue
                if (
                    not all(
                        math.isfinite(last[k]) and last[k] > 0
                        for k in ("bp", "ap", "bs", "as")
                    )
                    or last["bp"] > last["ap"]
                ):
                    continue
                fresh += 1
                eligible += 20_000 * (last["ap"] - last["bp"]) <= 5 * (
                    last["ap"] + last["bp"]
                )
    return {
        "maximumQuoteAgeMs": maximum_quote_age_ms,
        "sampledSeconds": total,
        "freshTwoSidedQuoteSeconds": fresh,
        "within5BpsSeconds": eligible,
        "freshQuoteCoverage": fresh / total,
        "executableOpportunityFraction": eligible / total,
        "within5BpsGivenFreshQuoteFraction": eligible / fresh if fresh else None,
    }


def audit(root):
    rule = load(root, "selection-rule.json")
    membership_bytes = (root.parent / "oef-latest.csv").read_bytes()
    if hashlib.sha256(membership_bytes).hexdigest() != rule["members"]["sha256"]:
        raise ValueError("issuer membership bytes differ from frozen source hash")
    issuer_rows = list(csv.reader(io.StringIO(membership_bytes.decode("utf-8-sig"))))
    header = next(
        index for index, row in enumerate(issuer_rows) if row and row[0] == "Ticker"
    )
    issuer_members = {
        row[0].replace(" ", "."): {
            "symbol": row[0].replace(" ", "."),
            "name": row[1],
            "sector": row[2],
        }
        for row in issuer_rows[header + 1 :]
        if len(row) > 3 and row[3] == "Equity"
    }
    if len(issuer_members) != 101 or issuer_members != {
        row["symbol"]: row for row in rule["members"]["rows"]
    }:
        raise ValueError("frozen members differ from the issuer equity rows")
    manifest = load(root, "manifest.json")
    expanded_rule = (
        load(root, "expanded-sample-rule.json")
        if (root / "expanded-sample-rule.json").exists()
        else None
    )
    for request in manifest:
        data = (root / request["file"]).read_bytes()
        if (
            len(data) != request["bytes"]
            or hashlib.sha256(data).hexdigest() != request["sha256"]
        ):
            raise ValueError(
                "source bytes differ from acquisition manifest: " + request["file"]
            )
        if request["status"] != 200 or request["completedAt"] < request["startedAt"]:
            raise ValueError(
                "unsuccessful or incoherent acquisition: " + request["file"]
            )
        frozen = (
            expanded_rule["frozenAt"]
            if request["file"].startswith("expanded-quotes-") and expanded_rule
            else rule["frozenAt"]
        )
        if request["startedAt"] < frozen:
            raise ValueError(
                "acquisition precedes its frozen sampling rule: " + request["file"]
            )
    sessions = load(root, "sessions.json")
    calendars = [
        load(root, request["file"])
        for request in manifest
        if "-calendar-" in request["file"]
    ]
    if (
        len(calendars) != 2
        or calendars[0] != calendars[1]
        or any(row not in calendars[0] for row in sessions)
    ):
        raise ValueError(
            "selected sessions differ from repeated raw exchange calendars"
        )
    dates = [s["date"] for s in sessions]
    if len(dates) != 20 or dates != sorted(set(dates)):
        raise ValueError("study requires 20 unique ordered completed exchange sessions")
    # Provider calendar times are America/New_York; the corpus crosses the November DST boundary.
    eastern = ZoneInfo("America/New_York")
    minutes_by_day = {}
    for session in sessions:
        begin = datetime.fromisoformat(session["date"] + "T" + session["open"]).replace(
            tzinfo=eastern
        )
        end = datetime.fromisoformat(session["date"] + "T" + session["close"]).replace(
            tzinfo=eastern
        )
        minutes_by_day[session["date"]] = [
            begin + timedelta(minutes=i)
            for i in range(int((end - begin).total_seconds() // 60))
        ]
    daily = source_rows(root, manifest, "daily-sip")
    minute = source_rows(root, manifest, "minute-iex")
    quotes = source_rows(root, manifest, "sample-quotes-iex")
    expanded = source_rows(root, manifest, "expanded")
    raw_assets = {row["symbol"]: row for row in load(root, "0002-assets.json")}
    asset_receipt = next(
        request for request in manifest if request["file"] == "0002-assets.json"
    )
    assets = {
        symbol: {"asset": asset, "observedAt": asset_receipt["completedAt"]}
        for symbol, asset in raw_assets.items()
    }
    raw_account = load(root, "0001-account.json")
    account_receipt = next(
        request for request in manifest if request["file"] == "0001-account.json"
    )
    expected_account = {
        "observedAt": account_receipt["completedAt"],
        "status": raw_account["status"],
        "shortingEnabled": raw_account.get("shorting_enabled"),
        "tradingBlocked": raw_account["trading_blocked"],
        "accountBlocked": raw_account["account_blocked"],
    }
    members = {row["symbol"]: row for row in rule["members"]["rows"]}
    rows = []
    for symbol in sorted(set(members) | set(rule["control"])):
        bars = daily.get(symbol, [])
        day_ids = [instant(b["t"]).astimezone(eastern).date().isoformat() for b in bars]
        if len(day_ids) != len(set(day_ids)):
            raise ValueError("duplicate daily symbol/session grain: " + symbol)
        values = []
        for bar in bars:
            if not all(
                math.isfinite(bar[k]) and bar[k] > 0
                for k in ("o", "h", "l", "c", "v", "vw")
            ) or not (
                bar["l"]
                <= min(bar["o"], bar["c"])
                <= max(bar["o"], bar["c"])
                <= bar["h"]
            ):
                raise ValueError("invalid daily OHLCV: " + symbol)
            values.append(bar["v"] * bar["vw"])
        native = minute.get(symbol, [])
        native_ids = [instant(b["t"]) for b in native]
        if len(native_ids) != len(set(native_ids)):
            raise ValueError("duplicate minute symbol/timestamp grain: " + symbol)
        available = set()
        for bar, at in zip(native, native_ids):
            if (
                at.second
                or at.microsecond
                or not all(
                    math.isfinite(bar[k]) and bar[k] > 0
                    for k in ("o", "h", "l", "c", "v")
                )
                or not (
                    bar["l"]
                    <= min(bar["o"], bar["c"])
                    <= max(bar["o"], bar["c"])
                    <= bar["h"]
                )
            ):
                raise ValueError("invalid native minute OHLCV/grain: " + symbol)
            available.add(at)
        expected_count = 0
        observed_count = 0
        window_count = 0
        complete_windows = 0
        coverage_by_day = []
        for date, expected in minutes_by_day.items():
            present = [at in available for at in expected]
            expected_count += len(expected)
            observed_count += sum(present)
            complete = sum(
                all(present[i - 30 : i]) for i in range(30, len(expected) + 1)
            )
            window_count += max(0, len(expected) - 29)
            complete_windows += complete
            coverage_by_day.append(
                {
                    "date": date,
                    "bars": sum(present),
                    "expected": len(expected),
                    "complete30MinuteWindows": complete,
                }
            )
        sample = quotes.get(symbol, [])
        valid = [
            q
            for q in sample
            if all(math.isfinite(q[k]) and q[k] > 0 for k in ("bp", "ap", "bs", "as"))
            and q["bp"] <= q["ap"]
        ]
        spreads = [20_000 * (q["ap"] - q["bp"]) / (q["ap"] + q["bp"]) for q in valid]
        asset_row = assets.get(symbol, {})
        asset = asset_row.get("asset") or {}
        shortable = (
            asset.get("status") == "active"
            and asset.get("class") == "us_equity"
            and all(
                asset.get(k) is True
                for k in ("tradable", "marginable", "shortable", "easy_to_borrow")
            )
        )
        rows.append(
            {
                "symbol": symbol,
                "sector": members.get(symbol, {}).get("sector"),
                "sp100": symbol in members,
                "currentUniverse": symbol in rule["control"],
                "dailySessions": len(bars),
                "dailyDatesMatch": sorted(day_ids) == dates,
                "medianDailyDollarVolume": statistics.median(values)
                if values
                else None,
                "medianDailyShareVolume": statistics.median([b["v"] for b in bars])
                if bars
                else None,
                "nativeScreened": symbol in minute,
                "nativeExpectedMinutes": expected_count,
                "nativeObservedMinutes": observed_count,
                "nativeMinuteCoverage": observed_count / expected_count,
                "complete30MinuteWindowCoverage": complete_windows / window_count,
                "coverageByDay": coverage_by_day,
                "quoteEvents": len(sample),
                "validQuoteEvents": len(valid),
                "invalidQuoteEvents": len(sample) - len(valid),
                "sampleSpreadMedianBps": statistics.median(spreads)
                if spreads
                else None,
                "sampleSpreadP95Bps": percentile(spreads, 0.95),
                "sampleWithin5BpsFraction": sum(x <= 5 for x in spreads) / len(spreads)
                if spreads
                else None,
                "shortEligibleAtObservation": shortable,
                "borrowObservedAt": asset_row.get("observedAt"),
                "expandedSample": sampled_seconds(expanded[symbol], sessions)
                if symbol in expanded
                else None,
            }
        )
    rows.sort(key=lambda row: (-(row["medianDailyDollarVolume"] or 0), row["symbol"]))
    selected = []
    sectors = Counter()
    for row in rows:
        reasons = []
        if not row["sp100"]:
            reasons.append("NOT_SP100")
        if not row["dailyDatesMatch"]:
            reasons.append("DAILY_SOURCE_INCOMPLETE")
        if (row["medianDailyDollarVolume"] or 0) < 1e9:
            reasons.append("MEDIAN_DOLLAR_VOLUME_BELOW_1B")
        if not row["shortEligibleAtObservation"]:
            reasons.append("BORROW_INELIGIBLE")
        if not row["nativeScreened"]:
            reasons.append("NATIVE_COVERAGE_NOT_SCREENED")
        elif (
            row["nativeMinuteCoverage"] < 0.95
            or row["complete30MinuteWindowCoverage"] < 0.8
        ):
            reasons.append("NATIVE_HISTORY_INCOMPLETE")
        if row["sampleSpreadP95Bps"] is None or row["sampleSpreadP95Bps"] > 5:
            reasons.append("SAMPLED_SPREAD_OVER_5BPS_OR_MISSING")
        if not reasons:
            if sectors[row["sector"]] >= 5:
                reasons.append("SECTOR_LIMIT")
            elif row["symbol"] in ("GOOG", "GOOGL") and any(
                x in selected for x in ("GOOG", "GOOGL")
            ):
                reasons.append("DUPLICATE_ISSUER")
            elif len(selected) >= 15:
                reasons.append("CANDIDATE_BUDGET")
            else:
                selected.append(row["symbol"])
                sectors[row["sector"]] += 1
        row["selectionRejections"] = reasons
    structural = []
    structural_sectors = Counter()
    for row in rows:
        if (
            row["sp100"]
            and row["dailyDatesMatch"]
            and (row["medianDailyDollarVolume"] or 0) >= 1e9
            and row["shortEligibleAtObservation"]
            and row["nativeMinuteCoverage"] >= 0.95
            and row["complete30MinuteWindowCoverage"] >= 0.8
        ):
            if structural_sectors[row["sector"]] >= 5 or (
                row["symbol"] in ("GOOG", "GOOGL")
                and any(x in structural for x in ("GOOG", "GOOGL"))
            ):
                continue
            if len(structural) < 15:
                structural.append(row["symbol"])
                structural_sectors[row["sector"]] += 1
    return {
        "schemaVersion": "bayn.sp100-universe-study.v1",
        "selectionRule": rule,
        "expandedSamplingRule": expanded_rule,
        "acquisitionRequests": len(manifest),
        "sessions": dates,
        "account": expected_account,
        "selected": selected,
        "selectedSectors": dict(sectors),
        "rows": rows,
        "structuralUniverseWithMandatoryPerEntrySpreadGate": structural,
        "limitations": [
            "Current membership; no historical point-in-time constituent or borrow claim.",
            "Dollar volume uses consolidated SIP daily bars; native coverage and sampled spreads use IEX only.",
            "Spread sample covers two minutes of one session and is event-weighted; it cannot establish all-session spreads.",
            "Expanded quotes sample three 20-second windows on each of 20 sessions; one-second decisions use only observed, two-sided quotes no older than ten seconds. Unsampled times remain unknown.",
            "Expanded sampling and the structural-universe alternative were chosen after inspecting the initial spread screen. They are exploratory and not an untouched holdout.",
            "Liquidity selection is not evidence of positive JeV expected returns.",
        ],
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("capture", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    result = audit(args.capture)
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(
        json.dumps(
            {
                "selected": result["selected"],
                "sectors": result["selectedSectors"],
                "rows": len(result["rows"]),
                "sessions": len(result["sessions"]),
            }
        )
    )
