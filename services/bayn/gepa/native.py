"""Compile one data-only question variant and run the ordinary native portfolio evaluator."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
from pathlib import Path

from runner import encode, identity, instructions, read_json, validate_study


def file_hash(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def execute(command, directory, name, env):
    with (
        (directory / f"{name}.stdout.txt").open("xb") as stdout,
        (directory / f"{name}.stderr.txt").open("xb") as stderr,
    ):
        completed = subprocess.run(
            command, stdout=stdout, stderr=stderr, env=env, check=False
        )
    if completed.returncode:
        raise RuntimeError(
            f"Native {name} failed; preserve its original files and do not retry"
        )


def evaluate(request, checkout, dependencies, output):
    study = validate_study(request["study"])
    task, document = request["task"], instructions(request["instructions"])
    if task not in study["development"] + study["evaluation"]:
        raise ValueError("Native task is not in the frozen study")
    if file_hash(task["sourceReceiptPath"]) != task["sourceReceiptSha256"]:
        raise ValueError("Native source receipt file differs")
    output = Path(output)
    output.mkdir(mode=0o700)
    runtime = Path(os.environ.get("BAYN_IMAGE_ROOT") or "/") / "app/services/bayn"
    if not (runtime / "node_modules").is_dir():
        raise ValueError("Run native evaluation in the exact published Bayn image")
    env = dict(os.environ)
    databases = json.loads(env.pop("BAYN_GEPA_DATABASE_URLS"))
    index = request["reservation"]
    if (
        type(index) is not int
        or index < 0
        or index >= len(databases)
        or len(set(databases)) != len(databases)
    ):
        raise ValueError(
            "Each native reservation requires its own pre-created local replay database"
        )
    env["BAYN_BACKTEST_POSTGRES_URL"] = databases[index]
    spec = {
        "schemaVersion": "bayn.jev-instruction-variant.v1",
        "evaluation": "portfolio",
        "sourceRevision": study["sourceRevision"],
        "imageRepository": study["imageRepository"],
        "baseImageDigest": study["imageDigest"],
        "instructions": document,
        "dependencyReceiptSha256": file_hash(dependencies),
    }
    spec_path = output / "variant.json"
    spec_path.write_bytes(encode(spec))
    execute(
        [
            "bun",
            str(
                Path(checkout) / "services/bayn/tools/build-jev-instruction-variant.ts"
            ),
            "--spec",
            str(spec_path),
            "--dependencies",
            str(dependencies),
            "--output",
            str(output / "variant"),
        ],
        output,
        "compile",
        env,
    )
    variant = output / "variant"
    (variant / "node_modules").symlink_to(
        runtime / "node_modules", target_is_directory=True
    )
    native = {
        **task["input"],
        "jevInstructionsHash": identity(document),
        "replicate": f"gepa-{identity(study)[:16]}-{index}-{request['replicate']}",
    }
    native_path = output / "input.json"
    native_path.write_bytes(encode(native))
    execute(
        [
            "node",
            str(variant / "evaluation.js"),
            "--input",
            str(native_path),
            "--arrivals",
            task["arrivalsPath"],
            "--source-receipt",
            task["sourceReceiptPath"],
            "--source-receipt-sha256",
            task["sourceReceiptSha256"],
            "--output",
            str(output / "native"),
        ],
        output,
        "portfolio",
        env,
    )
    report = output / "native/report.json"
    outcome = {
        "reportPath": str(report),
        "reportSha256": file_hash(report),
        "instructions": document,
        "operatingAllocations": task["operatingAllocations"],
        "variantBuild": read_json(variant / "build.json"),
    }
    artifact = output / "outcome-input.json"
    artifact.write_bytes(encode(outcome))
    execute(
        [
            "bayn-jev-evaluate",
            "--outcome",
            str(artifact),
            "--output",
            str(output / "outcome.json"),
        ],
        output,
        "verify",
        env,
    )
    verified = read_json(output / "outcome.json")
    if verified["instructionsHash"] != identity(document):
        raise ValueError("Native outcome instructions differ")
    return verified


def main():
    parser = argparse.ArgumentParser(prog="bayn-gepa-native")
    parser.add_argument("--request", required=True, type=Path)
    parser.add_argument("--checkout", required=True, type=Path)
    parser.add_argument("--dependencies", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    evaluate(
        read_json(args.request),
        args.checkout.resolve(),
        args.dependencies.resolve(),
        args.output.resolve(),
    )


if __name__ == "__main__":
    main()
