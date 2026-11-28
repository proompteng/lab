"""Independently verify every target against original Qlib float32 inputs."""

import argparse
import bisect
import csv
import hashlib
import itertools
import json
import math
from pathlib import Path
import re
import struct
from collections import Counter, defaultdict
from calendar import monthrange


HEADER = [
    "instrument",
    "date",
    "split",
    "universe",
    "eligible",
    "target_date",
    "horizon_sessions",
    "forward_return",
    "status",
]
RULE = {
    "endpoint": "first-finite-close-in-split",
    "currentAndEndpointMustBePositive": True,
    "compressionLimit": 0.1,
    "compressWhenSessionGapExceeds": 1,
}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def validate_date(value):
    if (
        not isinstance(value, str)
        or re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", value) is None
    ):
        raise ValueError("Invalid source date")
    year, month, day = map(int, value.split("-"))
    try:
        maximum = monthrange(year, month)[1]
    except ValueError as error:
        raise ValueError("Invalid source date") from error
    if not 1 <= day <= maximum:
        raise ValueError("Invalid source date")


def series(raw, length):
    if len(raw) < 4 or len(raw) % 4:
        raise ValueError("Malformed Qlib binary")
    values = struct.unpack("<" + "f" * (len(raw) // 4), raw)
    offset = values[0]
    if not math.isfinite(offset) or int(offset) != offset or offset < 0:
        raise ValueError("Invalid Qlib offset")
    offset = int(offset)
    if offset + len(values) - 1 > length:
        raise ValueError("Qlib extent exceeds calendar")
    return (
        [math.nan] * offset
        + list(values[1:])
        + [math.nan] * (length - offset - len(values) + 1)
    )


def mask(value):
    if not math.isfinite(value):
        return ""
    if value not in (0, 1):
        raise ValueError("Invalid eligibility mask")
    return str(int(value))


def verify(request_path, artifact, native_references=()):
    request_path = Path(request_path).resolve()
    request = json.loads(request_path.read_text())
    if request["schemaVersion"] != "bayn.cosmosalpha-calendar-target-request.v1":
        raise ValueError("Unsupported target request")
    artifact = Path(artifact)
    manifest = json.loads((artifact / "manifest.json").read_text())
    identity = manifest["identity"]
    encoded = json.dumps(identity, separators=(",", ":"), ensure_ascii=False).encode()
    if sha(encoded) != manifest["targetId"]:
        raise ValueError("Target identity digest mismatch")
    if identity[
        "schemaVersion"
    ] != "bayn.cosmosalpha-calendar-targets.v1" or json.dumps(
        identity["rule"], sort_keys=True
    ) != json.dumps(RULE, sort_keys=True):
        raise ValueError("Unsupported target protocol")
    if identity["window"] != {
        "fromDate": request["fromDate"],
        "splits": request["splits"],
    }:
        raise ValueError("Target window differs from independent request")
    roots = {
        "market": (request_path.parent / request["marketRoot"]).resolve(),
        "masks": (request_path.parent / request["maskRoot"]).resolve(),
    }
    inputs = {}

    def read(root, relative):
        path = (roots[root] / relative).resolve()
        if not path.is_relative_to(roots[root]):
            raise ValueError("Input path escapes root")
        raw = path.read_bytes()
        inputs[(root, relative)] = {
            "root": root,
            "path": relative,
            "sha256": sha(raw),
            "sizeBytes": len(raw),
        }
        return raw

    calendar = read("market", "calendars/day.txt").decode().splitlines()
    for value in calendar:
        validate_date(value)
    if calendar != sorted(set(calendar)) or not calendar:
        raise ValueError("Calendar is not strictly ordered")
    if calendar != read("masks", "calendars/day.txt").decode().splitlines():
        raise ValueError("Mask calendar differs")
    membership = defaultdict(list)
    for line in read("market", "instruments/csi300.txt").decode().splitlines():
        symbol, first, last = line.split()
        if re.fullmatch(r"(?:sh|sz)[0-9]{6}", symbol) is None:
            raise ValueError("Invalid membership instrument")
        validate_date(first)
        validate_date(last)
        if first > last:
            raise ValueError("Invalid membership interval")
        membership[symbol].append((first, last))
    splits = request["splits"]
    previous_end = ""
    names = set()
    windows = []
    for split in splits:
        name, start, end = split["name"], split["startDate"], split["endDate"]
        validate_date(start)
        validate_date(end)
        if (
            name not in {"train", "validation", "test"}
            or name in names
            or start <= previous_end
            or start > end
        ):
            raise ValueError("Invalid independent split definition")
        names.add(name)
        if start < calendar[0] or end > calendar[-1]:
            raise ValueError("Split exceeds calendar")
        first, last = (
            bisect.bisect_left(calendar, start),
            bisect.bisect_right(calendar, end) - 1,
        )
        if first > last:
            raise ValueError("Empty trading split")
        windows.append((name, first, last))
        previous_end = end
    validate_date(request["fromDate"])
    if not windows or not calendar[0] <= request["fromDate"] <= splits[0]["startDate"]:
        raise ValueError("Invalid projection start")
    first_day = bisect.bisect_left(calendar, request["fromDate"])
    last_day = bisect.bisect_right(calendar, splits[-1]["endDate"]) - 1

    def positions(symbol, start=first_day, end=last_day):
        result = set()
        for first, last in membership[symbol]:
            a = max(start, bisect.bisect_left(calendar, first))
            b = min(end + 1, bisect.bisect_right(calendar, last))
            result.update(range(a, b))
        return sorted(result)

    csv_path = artifact / "targets.csv"
    if identity["targets"]["file"] != "targets.csv":
        raise ValueError("Unexpected target filename")
    with csv_path.open("rb") as stream:
        if (
            hashlib.file_digest(stream, "sha256").hexdigest()
            != identity["targets"]["sha256"]
        ):
            raise ValueError("Target CSV digest mismatch")
    mismatch_count = 0
    examples = []
    statuses, split_rows = Counter(), Counter()
    rows = instruments = eligible_rows = unknown_eligible = labeled_rows = (
        eligible_labeled
    ) = 0

    def mismatch(expected, actual):
        nonlocal mismatch_count
        mismatch_count += 1
        if len(examples) < 12:
            examples.append({"expected": expected, "actual": actual})

    def expected_rows():
        nonlocal \
            rows, \
            instruments, \
            eligible_rows, \
            unknown_eligible, \
            labeled_rows, \
            eligible_labeled
        for symbol in sorted(membership):
            selected = positions(symbol)
            if not selected:
                continue
            instruments += 1
            closes = series(
                read("market", f"features/{symbol}/close.day.bin"), len(calendar)
            )
            eligible = series(
                read("masks", f"features/{symbol}/eligible_mask.day.bin"), len(calendar)
            )
            universe = series(
                read("masks", f"features/{symbol}/universe_mask.day.bin"), len(calendar)
            )
            finite_by_split = {
                name: [i for i in range(first, last + 1) if math.isfinite(closes[i])]
                for name, first, last in windows
            }
            for index in selected:
                row = dict(
                    zip(
                        HEADER,
                        [
                            symbol,
                            calendar[index],
                            "",
                            mask(universe[index]),
                            mask(eligible[index]),
                            "",
                            "",
                            "",
                            "outside-split",
                        ],
                        strict=True,
                    )
                )
                window = next(
                    (item for item in windows if item[1] <= index <= item[2]), None
                )
                if window is not None:
                    name = window[0]
                    row["split"] = name
                    if not math.isfinite(closes[index]) or closes[index] <= 0:
                        row["status"] = "invalid-current-close"
                    else:
                        finite = finite_by_split[name]
                        next_position = bisect.bisect_right(finite, index)
                        if next_position == len(finite):
                            row["status"] = "cutoff"
                        else:
                            endpoint = finite[next_position]
                            row["target_date"] = calendar[endpoint]
                            row["horizon_sessions"] = str(endpoint - index)
                            if closes[endpoint] <= 0:
                                row["status"] = "invalid-endpoint-close"
                            else:
                                value = closes[endpoint] / closes[index] - 1.0
                                if endpoint - index > 1:
                                    value = min(0.1, max(-0.1, value))
                                if not math.isfinite(value):
                                    raise ValueError("Nonfinite reference return")
                                row["status"] = "ok"
                                row["forward_return"] = value
                rows += 1
                eligible_rows += row["eligible"] == "1"
                unknown_eligible += row["eligible"] == ""
                labeled_rows += row["status"] == "ok"
                eligible_labeled += row["status"] == "ok" and row["eligible"] == "1"
                statuses[row["status"]] += 1
                split_rows[row["split"] or "outside"] += 1
                yield row

    with csv_path.open(newline="") as stream:
        reader = csv.DictReader(stream)
        if reader.fieldnames != HEADER:
            raise ValueError("Unexpected CSV schema")
        for expected, actual in itertools.zip_longest(expected_rows(), reader):
            if expected is None or actual is None:
                mismatch(expected, actual)
                continue
            actual = dict(actual)
            if actual["forward_return"]:
                actual["forward_return"] = float(actual["forward_return"])
                if not math.isfinite(actual["forward_return"]):
                    mismatch(expected, actual)
                    continue
            if actual != expected:
                mismatch(expected, actual)
    if rows == 0:
        raise ValueError("No membership rows to verify")
    expected_counts = {
        "rows": rows,
        "instruments": instruments,
        "eligibleRows": eligible_rows,
        "unknownEligibleRows": unknown_eligible,
        "labeledRows": labeled_rows,
        "eligibleLabeledRows": eligible_labeled,
        "statuses": dict(statuses),
        "splitRows": dict(split_rows),
    }
    for key, value in expected_counts.items():
        if identity["targets"][key] != value:
            mismatch({key: value}, {key: identity["targets"][key]})
    if identity["inputs"] != [inputs[key] for key in sorted(inputs)]:
        raise ValueError(
            "Recorded input inventory differs from independently consumed files"
        )
    expected_code = []
    for name in ["cosmosalpha-calendar-targets.ts", "generate-cosmosalpha-targets.ts"]:
        expected_code.append(
            {"path": name, "sha256": sha((Path(__file__).parent / name).read_bytes())}
        )
    if identity["generatorSources"] != expected_code:
        raise ValueError("Generator source identity differs")
    native = [
        verify_native(Path(reference), Path(artifacts), roots, calendar, membership)
        for reference, artifacts in native_references
    ]
    return {
        "schemaVersion": "bayn.cosmosalpha-calendar-target-verification.v1",
        "targetId": manifest["targetId"],
        "verifierSha256": sha(Path(__file__).read_bytes()),
        "status": "PASS" if mismatch_count == 0 else "FAIL",
        "unexplainedMismatches": mismatch_count,
        "numericTolerance": 0,
        "sourceFilesVerified": len(inputs),
        **expected_counts,
        "nativeSnapshots": native,
        "examples": examples,
        "scope": "Target/source/coverage agreement under the declared rule. No industry-PIT, predictive, execution or economic qualification.",
    }


def verify_native(reference_path, artifact_root, roots, calendar, membership):
    import numpy as np

    reference_bytes = reference_path.read_bytes()
    snapshot = json.loads(reference_bytes)
    if snapshot["schemaVersion"] != "bayn.cosmosalpha-downstream-source-validation.v1":
        raise ValueError("Unsupported native source reference")

    def artifact(kind):
        refs = [ref for ref in snapshot["artifactRefs"] if ref["kind"] == kind]
        if len(refs) != 1:
            raise ValueError(
                "Native source reference must identify exactly one artifact"
            )
        return refs[0]

    def columns(ref):
        aid = ref["artifact_id"]
        path = artifact_root / aid[:2] / aid
        raw = path.read_bytes()
        if (
            sha(raw) != aid
            or ref["checksum"] != "sha256:" + aid
            or len(raw) != ref["size_bytes"]
        ):
            raise ValueError("Native artifact identity differs")
        with np.load(path, allow_pickle=False) as bundle:
            manifest = json.loads(bundle["__cosmosalpha_manifest__"].item())
            result = {}
            for column in manifest["columns"]:
                name = column["name"]
                if name not in {
                    "datetime",
                    "instrument",
                    "close",
                    "eligible_mask",
                    "universe_mask",
                }:
                    continue
                values = bundle[column["data_key"]].copy()
                valid = bundle[column["valid_key"]]
                if (
                    len(values) != manifest["row_count"]
                    or len(valid) != manifest["row_count"]
                    or valid.dtype != np.bool_
                ):
                    raise ValueError("Native column length or validity schema differs")
                if name in {"datetime", "instrument"}:
                    if not valid.all():
                        raise ValueError("Native row key is null")
                else:
                    values = values.astype(float)
                    values[~valid] = np.nan
                result[name] = values
            return result

    market_ref, mask_ref = artifact("market_data"), artifact("mask_data")
    market = columns(market_ref)
    masks = columns(mask_ref)
    for key in ["datetime", "instrument"]:
        if not np.array_equal(market[key], masks[key]):
            raise ValueError("Native market/mask keys differ")
    dates = np.array(calendar)
    days = np.searchsorted(dates, market["datetime"])
    if not np.array_equal(dates[days], market["datetime"]):
        raise ValueError("Native dates missing from complete calendar")
    order = np.argsort(market["instrument"], kind="stable")
    groups = np.split(
        order,
        np.flatnonzero(
            market["instrument"][order][1:] != market["instrument"][order][:-1]
        )
        + 1,
    )
    seen = set()
    request = snapshot["request"]
    verified = 0
    for group in groups:
        symbol = str(market["instrument"][group[0]])
        seen.add(symbol)
        expected = sorted(
            {
                i
                for first, last in membership[symbol]
                for i in range(
                    max(
                        bisect.bisect_left(calendar, first),
                        bisect.bisect_left(calendar, request["warmup_start_date"]),
                    ),
                    min(
                        bisect.bisect_right(calendar, last),
                        bisect.bisect_right(calendar, request["end_date"]),
                    ),
                )
            }
        )
        if not np.array_equal(days[group], expected):
            raise ValueError("Native membership coverage differs")
        for root, field, native in [
            ("market", "close", market),
            ("masks", "eligible_mask", masks),
            ("masks", "universe_mask", masks),
        ]:
            raw = (
                roots[root] / "features" / symbol / (field + ".day.bin")
            ).read_bytes()
            values = np.array(series(raw, len(calendar)))[days[group]]
            if not np.array_equal(values, native[field][group], equal_nan=True):
                raise ValueError("Native prices or masks differ from original binaries")
        verified += len(group)
    expected_symbols = {
        symbol
        for symbol, intervals in membership.items()
        if any(
            first <= request["end_date"] and last >= request["warmup_start_date"]
            for first, last in intervals
        )
    }
    if seen != expected_symbols or verified != snapshot["sampleCount"]:
        raise ValueError("Native instruments or sample count differ")
    return {
        "snapshotId": snapshot["snapshotId"],
        "referenceSha256": sha(reference_bytes),
        "marketArtifactSha256": market_ref["artifact_id"],
        "maskArtifactSha256": mask_ref["artifact_id"],
        "priceAndMaskRowsVerified": verified,
        "instrumentCount": len(seen),
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("request")
    parser.add_argument("artifact")
    parser.add_argument(
        "--native-reference",
        nargs=2,
        action="append",
        default=[],
        metavar=("SUMMARY_JSON", "ARTIFACT_ROOT"),
    )
    parser.add_argument("--report")
    args = parser.parse_args()
    report = verify(args.request, args.artifact, args.native_reference)
    encoded = json.dumps(report, indent=2, allow_nan=False) + "\n"
    if args.report:
        with Path(args.report).open("x") as stream:
            stream.write(encoded)
    print(encoded, end="")
    raise SystemExit(0 if report["status"] == "PASS" else 1)
