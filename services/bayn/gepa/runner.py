"""Optimize one typed Jev question against native Bayn portfolio outcomes."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import signal
import subprocess
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

UPSTREAM_REVISION = "8f287de942f41a6d1e0e7e5b2d576247c4bedee9"
MAX_BYTES = 16 * 1024 * 1024


def encode(value):
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
        ensure_ascii=False,
    ).encode()


def identity(value):
    return hashlib.sha256(encode(value)).hexdigest()


def instant(seconds):
    return (
        datetime.fromtimestamp(seconds, timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def read_json(path):
    with Path(path).open("rb") as stream:
        raw = stream.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise ValueError("Study input exceeds 16 MiB")
    return json.loads(raw)


def instructions(value):
    if not isinstance(value, dict) or set(value) != {"entry"}:
        raise ValueError(
            "Only the native actual-entry complete-plan instruction is editable"
        )
    if (
        not isinstance(value["entry"], str)
        or not 1 <= len(value["entry"].strip()) <= 2000
    ):
        raise ValueError("The entry instruction must contain one to 2000 characters")
    return value


def validate_study(study):
    fields = {
        "schemaVersion",
        "sourceRevision",
        "imageRepository",
        "imageDigest",
        "baseline",
        "editor",
        "maximumSearchEvaluations",
        "maximumEditorCalls",
        "maximumNativeCalls",
        "maximumWallSeconds",
        "seed",
        "development",
        "evaluation",
    }
    if (
        not isinstance(study, dict)
        or set(study) != fields
        or study["schemaVersion"] != "bayn.jev-gepa-study.v1"
    ):
        raise ValueError("A frozen native GEPA study is required")
    if not re.fullmatch(r"[0-9a-f]{40}", study["sourceRevision"]):
        raise ValueError("Pin the exact reviewed source revision")
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", study["imageDigest"]):
        raise ValueError("Pin the published image digest")
    if study["imageRepository"] != "registry.ide-newton.ts.net/lab/bayn":
        raise ValueError("Use the existing Bayn image repository")
    for field, lower, upper in (
        ("maximumSearchEvaluations", 2, 32),
        ("maximumEditorCalls", 1, 16),
        ("maximumNativeCalls", 1, 100_000),
        ("maximumWallSeconds", 60, 86_400),
        ("seed", 0, 2**32 - 1),
    ):
        if type(study[field]) is not int or not lower <= study[field] <= upper:
            raise ValueError(f"{field} exceeds its supported bound")
    instructions(study["baseline"])
    if not isinstance(study["editor"], dict) or set(study["editor"]) != {
        "policy",
        "costBasis",
    }:
        raise ValueError("Freeze the editor serving policy and cost coverage")
    seen, ranges = set(), []
    for group in (study["development"], study["evaluation"]):
        if not isinstance(group, list) or not 1 <= len(group) <= 4:
            raise ValueError("Use one to four existing chronological blocks per group")
        intervals = []
        for task in group:
            if not isinstance(task, dict) or set(task) != {
                "id",
                "input",
                "arrivalsPath",
                "sourceReceiptPath",
                "sourceReceiptSha256",
                "operatingAllocations",
            }:
                raise ValueError(
                    "Each task requires its original native inputs and source receipt"
                )
            if (
                not re.fullmatch(r"[a-z][a-z0-9-]{0,63}", task["id"])
                or task["id"] in seen
            ):
                raise ValueError("Task IDs must be unique")
            seen.add(task["id"])
            native = task["input"]
            if (
                type(native["inference"]["maximumCalls"]) is not int
                or not 1
                <= native["inference"]["maximumCalls"]
                <= study["maximumNativeCalls"]
            ):
                raise ValueError(
                    "Each native evaluation requires its frozen positive call limit"
                )
            if native["jevInstructionsHash"] != identity(study["baseline"]):
                raise ValueError("Task instructions must bind the unchanged baseline")
            if (
                native["build"]["sourceRevision"] != study["sourceRevision"]
                or native["build"]["imageDigest"] != study["imageDigest"]
            ):
                raise ValueError("Task source and image differ from the frozen study")
            if not re.fullmatch(r"[0-9a-f]{64}", task["sourceReceiptSha256"]):
                raise ValueError("Source receipt bytes require a SHA-256")
            intervals.append(
                (native["interval"]["startAt"], native["interval"]["endAt"])
            )
        if intervals != sorted(intervals) or any(a >= b for a, b in intervals):
            raise ValueError("Native blocks must have chronological nonempty intervals")
        if any(left[1] > right[0] for left, right in zip(intervals, intervals[1:])):
            raise ValueError("Native blocks overlap")
        ranges.append(intervals)
    if ranges[0][-1][1] > ranges[1][0][0]:
        raise ValueError(
            "Evaluation must follow the complete development execution/label horizon"
        )
    if len(encode(study)) > MAX_BYTES:
        raise ValueError("Study input exceeds 16 MiB")
    return study


class Storage:
    def __init__(self, bucket, endpoint, study_id):
        self.bucket, self.prefix = bucket, f"gepa/jev-v1/{study_id}/"
        self.client = boto3.client(
            "s3",
            endpoint_url=endpoint,
            config=Config(
                connect_timeout=5,
                read_timeout=30,
                retries={"total_max_attempts": 1},
            ),
        )

    def read(self, key):
        try:
            response = self.client.get_object(Bucket=self.bucket, Key=self.prefix + key)
        except ClientError as error:
            if error.response["Error"]["Code"] in ("NoSuchKey", "404"):
                return None
            raise RuntimeError("GEPA evidence read failed") from None
        with response["Body"] as stream:
            raw = stream.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            raise ValueError("Retained GEPA evidence exceeds its byte limit")
        return json.loads(raw)

    def create(self, key, value):
        try:
            self.client.put_object(
                Bucket=self.bucket,
                Key=self.prefix + key,
                Body=encode(value),
                ContentType="application/json",
                IfNoneMatch="*",
            )
            return True
        except ClientError as error:
            if error.response["Error"]["Code"] in (
                "PreconditionFailed",
                "412",
                "ConditionalRequestConflict",
                "409",
            ):
                return False
            raise RuntimeError("GEPA evidence write failed") from None


def retain(storage, key, value):
    if not storage.create(key, value) and storage.read(key) != value:
        raise ValueError("Retained GEPA evidence conflicts")


def invoke(command, directory, timeout):
    with (
        (directory / "stdout.txt").open("xb") as stdout,
        (directory / "stderr.txt").open("xb") as stderr,
    ):
        child = subprocess.Popen(
            command, stdout=stdout, stderr=stderr, start_new_session=True
        )
        try:
            status = child.wait(timeout=timeout)
        finally:
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
    if status:
        raise RuntimeError(
            "Native evaluation failed; retain the private attempt and do not retry"
        )


class Study:
    def __init__(
        self,
        study,
        root,
        storage,
        checkout,
        dependencies,
        execute=invoke,
        clock=time.time,
    ):
        self.study, self.root, self.storage = validate_study(study), Path(root), storage
        self.checkout, self.dependencies, self.execute, self.clock = (
            str(checkout),
            str(dependencies),
            execute,
            clock,
        )
        self.lock = threading.Lock()
        registration = storage.read("registration.json")
        if registration is None:
            storage.create(
                "registration.json",
                {
                    "study": study,
                    "startedAt": clock(),
                    "upstreamRevision": UPSTREAM_REVISION,
                },
            )
            registration = storage.read("registration.json")
        if (
            registration["study"] != study
            or registration["upstreamRevision"] != UPSTREAM_REVISION
        ):
            raise ValueError("Study or optimizer differs from its frozen registration")
        self.deadline = registration["startedAt"] + study["maximumWallSeconds"]

    def reserve(self, kind, key, request, budget):
        with self.lock:
            slots = [self.storage.read(f"reservations/{i}.json") for i in range(128)]
            for index, slot in enumerate(slots):
                if slot:
                    retained = self.storage.read(f"receipts/{index}.json")
                    if retained is None or (
                        slot["kind"] == "editor" and retained["outcome"] != "COMPLETE"
                    ):
                        raise ValueError(
                            "An incomplete paid reservation cannot be retransmitted or bypassed"
                        )
            for index, slot in enumerate(slots):
                if slot and slot["key"] == key:
                    if slot["requestHash"] != identity(request):
                        raise ValueError("A retained reservation changed input")
                    receipt = self.storage.read(f"receipts/{index}.json")
                    if receipt is None:
                        raise ValueError(
                            "An incomplete paid reservation cannot be retransmitted"
                        )
                    return index, receipt
            if self.clock() >= self.deadline:
                raise ValueError("GEPA wall-time budget exhausted")
            counts = [slot for slot in slots if slot and slot["kind"] == kind]
            if kind == "editor" and len(counts) >= self.study["maximumEditorCalls"]:
                raise ValueError("GEPA editor-call budget exhausted")
            if (
                kind == "native"
                and sum(slot["requestBudget"] for slot in counts) + budget
                > self.study["maximumNativeCalls"]
            ):
                raise ValueError(
                    "GEPA total native-call budget exhausted, including evaluation and failures"
                )
            index = next((i for i, slot in enumerate(slots) if slot is None), None)
            if index is None or not self.storage.create(
                f"reservations/{index}.json",
                {
                    "kind": kind,
                    "key": key,
                    "requestHash": identity(request),
                    "requestBudget": budget,
                    "request": request,
                },
            ):
                raise ValueError(
                    "Concurrent study ownership or reservation budget exhausted"
                )
            return index, None

    def evaluate(self, candidate, task, *, replicate="primary"):
        document = instructions(json.loads(candidate))
        request = {"instructions": document, "task": task, "replicate": replicate}
        key = "native/" + identity(request)
        index, previous = self.reserve(
            "native", key, request, task["input"]["inference"]["maximumCalls"]
        )
        if previous is not None:
            return previous["score"], previous["feedback"]
        directory = self.root / "native" / str(index)
        directory.mkdir(parents=True)
        artifact = directory / "request.json"
        artifact.write_bytes(
            encode({**request, "study": self.study, "reservation": index})
        )
        self.execute(
            [
                "bayn-gepa-native",
                "--request",
                str(artifact),
                "--checkout",
                self.checkout,
                "--dependencies",
                self.dependencies,
                "--output",
                str(directory / "result"),
            ],
            directory,
            max(1, self.deadline - self.clock()),
        )
        outcome = read_json(directory / "result" / "outcome.json")
        if (
            outcome["knownNetPnlMicros"] is None
            or outcome["remainingPositions"] != 0
            or outcome["unresolvedModelCalls"] != 0
        ):
            raise ValueError(
                "Unclosed inventory or unpriced model calls cannot supply fitness"
            )
        forbidden = {
            "cycle-failure",
            "inexact-accounting",
            "unresolved-mutation",
            "unclosed-position",
            "unclosed-order",
            "missing-valuation",
            "unresolved-execution-cost",
        }
        if forbidden.intersection(outcome["issues"]):
            raise ValueError("Native execution failure cannot supply fitness")
        if outcome["providerRequests"] > task["input"]["inference"]["maximumCalls"]:
            raise ValueError("Native provider dispatches exceed the reserved cap")
        context = {"taskHash": identity(task), "contextHash": outcome["contextHash"]}
        retain(self.storage, f"contexts/{task['id']}.json", context)
        score = int(outcome["knownNetPnlMicros"]) / 1_000_000
        if not math.isfinite(score):
            raise ValueError("Native fitness is not finite")
        feedback = {
            key: outcome[key]
            for key in (
                "reportHash",
                "contextHash",
                "instructionsHash",
                "knownNetPnlMicros",
                "costCoverage",
                "issues",
                "providerRequests",
                "executionPnlMicros",
                "knownModelCostMicros",
                "conservativeMaximumDrawdownMicros",
            )
        }
        feedback["objective"] = (
            "Native portfolio P&L after known execution, inference and allocated costs; missing allocations remain unknown."
        )
        retain(
            self.storage,
            f"receipts/{index}.json",
            {"score": score, "feedback": feedback},
        )
        return score, feedback

    def propose(self, candidate, reflective_dataset, components_to_update):
        if components_to_update != ["current_candidate"] or set(candidate) != {
            "current_candidate"
        }:
            raise ValueError("GEPA can edit only the complete native question document")
        prompt = (
            "Improve the actual-entry complete-plan instruction for TypeSafe Jev, a typed System One decision model. "
            "Jev receives immutable trading signal state and code-supplied plans. It cannot execute tools or generate text. "
            "The independent setup judgment, plan construction, arithmetic, risk, quantities and authority remain in code. "
            "Only one entry instruction string of at most 2000 characters is editable. Return only its complete JSON document. "
            "Use the supplied development execution feedback. Do not embed dates, future outcomes or invented observations in the instruction.\n"
            + encode(
                {"candidate": candidate, "developmentFeedback": reflective_dataset}
            ).decode()
        )
        if len(prompt) > 90_000:
            raise ValueError(
                "Development feedback exceeds the frozen editor context bound"
            )
        now = self.clock()
        run = {
            "schemaVersion": "bayn.jev-editor.v1",
            "purpose": "prompt-edit",
            "sourceRevision": self.study["sourceRevision"],
            "studyHash": identity(self.study),
            "armManifestHashes": [identity(self.study["baseline"])],
            "captureManifestHash": identity(self.study["development"]),
            "registeredAt": instant(now),
            "featureCutoff": instant(now),
            "deadlineAt": instant(min(now + 179, self.deadline)),
            "attempt": 0,
            "promptTemplate": prompt,
            "context": {
                "memory": {
                    "text": "Only frozen development evidence may guide this question edit.",
                    "sha256": hashlib.sha256(
                        b"Only frozen development evidence may guide this question edit."
                    ).hexdigest(),
                    "availableAt": instant(now),
                }
            },
            **self.study["editor"],
        }
        index, previous = self.reserve(
            "editor",
            "editor/"
            + identity({"candidate": candidate, "feedback": reflective_dataset}),
            run,
            1,
        )
        if previous is None:
            directory = self.root / "editor" / str(index)
            directory.mkdir(parents=True)
            request, receipt = directory / "run.json", directory / "receipt.json"
            request.write_bytes(encode(run))
            self.execute(
                ["bayn-research", "--run", str(request), "--output", str(receipt)],
                directory,
                min(195, max(1, self.deadline - self.clock())),
            )
            previous = read_json(receipt)
            retain(self.storage, f"receipts/{index}.json", previous)
        if previous["outcome"] != "COMPLETE" or previous["instructions"] is None:
            raise ValueError(
                "The editor attempt is incomplete; no automatic paid retry"
            )
        document = instructions(previous["instructions"])
        return {"current_candidate": encode(document).decode()}


def run_study(
    study, root, storage, checkout, dependencies, execute=invoke, clock=time.time
):
    from gepa.optimize_anything import OptimizeAnythingConfig, optimize_anything

    validate_study(study)
    terminal = storage.read("result.json")
    if terminal is not None:
        material = {
            key: value for key, value in terminal.items() if key != "resultHash"
        }
        if terminal.get("resultHash") != identity(material):
            raise ValueError("Retained terminal result bytes differ")
        if (
            terminal["studyId"] != identity(study)
            or terminal["upstreamRevision"] != UPSTREAM_REVISION
        ):
            raise ValueError("Retained terminal study identity differs")
        return terminal
    root = Path(root) / identity(study)
    root.mkdir(parents=True, exist_ok=True)
    (root / "study.json").write_bytes(encode(study))
    adapter = Study(study, root, storage, checkout, dependencies, execute, clock)

    def no_other_model(_prompt):
        raise ValueError("Only the registered native editor may propose candidates")

    result = optimize_anything(
        seed_candidate=encode(study["baseline"]).decode(),
        evaluator=adapter.evaluate,
        dataset=study["development"],
        valset=study["development"],
        test_set=study["evaluation"],
        objective="Maximize native portfolio P&L after known costs under unchanged trading risk and execution rules.",
        background="Evaluation blocks are never proposal context. Unknown allocations are not zero or a profitability claim.",
        config=OptimizeAnythingConfig(
            engine="gepa",
            name="bayn-" + identity(study)[:12],
            max_evals=study["maximumSearchEvaluations"],
            max_concurrency=1,
            output_dir=root / "gepa",
            run_dir=str(root / "engine"),
            engine_config={
                "engine": {
                    "seed": study["seed"],
                    "parallel": False,
                    "raise_on_exception": True,
                    "use_cloudpickle": False,
                    "max_candidate_proposals": study["maximumEditorCalls"],
                },
                "reflection": {
                    "reflection_lm": no_other_model,
                    "custom_candidate_proposer": adapter.propose,
                    "reflection_minibatch_size": 1,
                    "skip_perfect_score": False,
                },
                "merge": {"max_merge_invocations": 0},
            },
        ),
    )
    selected = result.best_candidate
    if isinstance(selected, dict):
        selected = selected["current_candidate"]
    selected = instructions(json.loads(selected))
    pairs = []
    for task in study["evaluation"]:
        baseline = adapter.evaluate(encode(study["baseline"]).decode(), task)
        candidate = adapter.evaluate(encode(selected).decode(), task)
        repeat = adapter.evaluate(
            encode(study["baseline"]).decode(), task, replicate="unchanged-repeat"
        )
        pairs.append(
            {
                "taskId": task["id"],
                "baseline": baseline[1],
                "candidate": candidate[1],
                "baselineRepeat": repeat[1],
                "knownNetDeltaMicros": str(
                    int(candidate[1]["knownNetPnlMicros"])
                    - int(baseline[1]["knownNetPnlMicros"])
                ),
            }
        )
    material = {
        "schemaVersion": "bayn.jev-gepa-result.v1",
        "studyId": identity(study),
        "upstreamRevision": UPSTREAM_REVISION,
        "selected": selected,
        "distinctCandidate": identity(selected) != identity(study["baseline"]),
        "pairs": pairs,
        "economicImprovement": "UNPROVEN",
        "qualification": "UNQUALIFIED",
        "productionAdoption": "NOT_AUTHORIZED",
    }
    terminal = {**material, "resultHash": identity(material)}
    retain(storage, "result.json", terminal)
    (root / "result.json").write_bytes(encode(terminal))
    return terminal


def main():
    parser = argparse.ArgumentParser(prog="bayn-gepa")
    parser.add_argument(
        "--version", action="version", version="gepa 0.1.4 source " + UPSTREAM_REVISION
    )
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--checkout", required=True, type=Path)
    parser.add_argument("--dependencies", required=True, type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    study = validate_study(read_json(args.manifest))
    storage = Storage(
        os.environ["BAYN_PUBLIC_INFORMATION_BUCKET"],
        os.environ["BAYN_PUBLIC_INFORMATION_STORAGE_ENDPOINT"],
        identity(study),
    )
    result = run_study(
        study,
        args.output,
        storage,
        args.checkout.resolve(),
        args.dependencies.resolve(),
    )
    print(
        encode(
            {
                "studyId": result["studyId"],
                "resultHash": result["resultHash"],
                "distinctCandidate": result["distinctCandidate"],
            }
        ).decode()
    )


if __name__ == "__main__":
    main()
