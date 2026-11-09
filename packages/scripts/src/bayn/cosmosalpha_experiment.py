"""Freeze and execute the calendar-target Graph/MCTS/no-Flow comparison."""

import argparse
from collections import Counter
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
import hashlib
import importlib.util
from importlib.metadata import distributions
import json
from pathlib import Path
import platform
import re
from statistics import mean, stdev
import subprocess
from threading import Lock
import time
import tomllib
import urllib.error
import urllib.request

_verifier_spec = importlib.util.spec_from_file_location(
    "calendar_verifier", Path(__file__).with_name("verify-cosmosalpha-targets.py")
)
_verifier = importlib.util.module_from_spec(_verifier_spec)
_verifier_spec.loader.exec_module(_verifier)
verify = _verifier.verify


SCHEMA = "bayn.cosmosalpha-frozen-experiment.v1"
SOURCE_COMMIT = "237f0a56895fd295542e202be8f62be48d6e9995"
SOURCE_INVENTORY_ID = "d881fb60c4cb560e5aafce650291ed50dd2ca3d8db99a7eac1eadac1dd99f778"
ENDPOINT = "http://flamingo.ide-newton.ts.net/v1"
MODEL = "qwen38-flamingo"
ARMS = ("graph", "mcts", "no-flow")
PROFILE = {
    "temperature": 0.0,
    "top_p": 0.95,
    "top_k": 20,
    "min_p": 0.0,
    "presence_penalty": 0.0,
    "frequency_penalty": 0.0,
    "repetition_penalty": 1.0,
    "chat_template_kwargs": {"enable_thinking": True},
}


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def identity(value):
    return hashlib.sha256(
        json.dumps(
            value, sort_keys=True, separators=(",", ":"), allow_nan=False
        ).encode()
    ).hexdigest()


def write_json(path, value):
    with Path(path).open("x") as stream:
        json.dump(value, stream, indent=2, allow_nan=False)
        stream.write("\n")


def native_source(manifest, source_root):
    value = json.loads(Path(manifest).read_text())
    if value["sourceCommit"] != SOURCE_COMMIT:
        raise ValueError("Unexpected CosmosAlpha author commit")
    root = Path(source_root).resolve()
    expected = {}
    for item in value["files"]:
        name = item["path"].removeprefix("src/cosmosalpha/")
        path = (root / name).resolve()
        if not path.is_relative_to(root) or name in expected:
            raise ValueError("Invalid source inventory")
        expected[name] = item["sha256"]
        if digest(path) != item["sha256"]:
            raise ValueError("Native source differs: " + name)
    if identity(expected) != SOURCE_INVENTORY_ID:
        raise ValueError("Native source is not the registered repaired implementation")
    actual = {
        str(p.relative_to(root))
        for p in root.rglob("*")
        if p.is_file() and "__pycache__" not in p.parts and p.suffix != ".pyc"
    }
    if "py.typed" in actual and not (root / "py.typed").read_bytes().strip():
        actual.remove("py.typed")
    if actual != set(expected):
        raise ValueError("Native source inventory is incomplete")
    return {"manifestSha256": digest(manifest), "files": len(expected)}


def write_source_identity(source_root, output):
    root = Path(source_root).resolve()
    files = [
        {
            "path": "src/cosmosalpha/" + str(path.relative_to(root)),
            "sha256": digest(path),
        }
        for path in sorted(root.rglob("*"))
        if path.is_file()
        and "__pycache__" not in path.parts
        and path.suffix != ".pyc"
        and path.name != "py.typed"
    ]
    write_json(
        output,
        {
            "sourceCommit": SOURCE_COMMIT,
            "inventoryId": SOURCE_INVENTORY_ID,
            "files": files,
        },
    )
    return native_source(output, root)


def provider_inventory(providers):
    result = []
    for role, directory in sorted(providers.items()):
        root = Path(directory).expanduser().resolve()
        files = []
        for path in sorted(root.rglob("*")):
            relative = path.relative_to(root)
            parts = relative.parts
            selected = (
                len(parts) == 3
                and parts[0] == "features"
                and path.name.endswith(".day.bin")
                or len(parts) == 2
                and parts[0] in {"calendars", "instruments"}
                and path.suffix == ".txt"
                or len(parts) == 1
                and path.suffix == ".json"
            )
            if path.is_file() and selected:
                files.append(
                    {
                        "path": str(relative),
                        "sha256": digest(path),
                        "sizeBytes": path.stat().st_size,
                    }
                )
        if not files:
            raise ValueError("QLib provider inventory is empty")
        result.append({"role": role, "root": str(root), "files": files})
    return result


def verify_provider_inventory(root, plan):
    path = root / plan["providerIdentityFile"]
    if digest(path) != plan["providerIdentitySha256"] or provider_inventory(
        plan["providers"]
    ) != json.loads(path.read_text()):
        raise ValueError("QLib provider bytes drifted from the frozen experiment")
    return True


def serving_identity(response):
    raw = response.headers.get("x-model-serving-identity")
    if raw is None:
        raise ValueError("Serving identity header is absent")
    value = json.loads(raw)
    if value.get("model") != MODEL:
        raise ValueError("Unexpected served model")
    return value


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        raise ValueError("Frozen model route cannot redirect")


def live_model():
    with urllib.request.build_opener(NoRedirect()).open(
        ENDPOINT + "/models", timeout=30
    ) as response:
        served = serving_identity(response)
        models = json.load(response)["data"]
    if [m["id"] for m in models] != [MODEL]:
        raise ValueError("Unexpected model inventory")
    return served


def runtime_versions():
    from lightgbm.basic import _LIB

    return {
        "python": platform.python_version(),
        "platform": platform.platform(),
        "lightgbmBinarySha256": digest(_LIB._name),
        "packages": dict(
            sorted((item.metadata["Name"], item.version) for item in distributions())
        ),
    }


@dataclass(frozen=True)
class Limits:
    evaluable_factors: int = 150
    proposal_slots: int = 600
    physical_requests: int = 2000
    completion_tokens: int = 20_000_000
    max_output_tokens: int = 20_000

    def __post_init__(self):
        if any(type(v) is not int or v <= 0 for v in asdict(self).values()):
            raise ValueError("Experiment budgets must be positive integers")
        if self.evaluable_factors > self.proposal_slots:
            raise ValueError("Evaluable target exceeds proposal allowance")


class BudgetReached(Exception):
    pass


class EvaluableTargetReached(BaseException):
    """Exit native search without entering its broad proposal-failure handlers."""


def auxiliary_response_valid(purpose, content):
    try:
        value = json.loads(content)
        if not isinstance(value, dict):
            return False
        if purpose == "suggestion":
            items = value.get("suggestions")
            return (
                isinstance(items, list)
                and bool(items)
                and all(isinstance(item, str) and item.strip() for item in items)
            )
        return purpose == "portrait" and all(
            isinstance(value.get(key), str) and value[key].strip()
            for key in [
                "portrait_name",
                "portrait_logic",
                "portrait_pseudocode",
                "expression",
            ]
        )
    except (ValueError, TypeError):
        return False


class CheckedModelClient:
    def __init__(self, delegate, budget):
        self.delegate, self.budget = delegate, budget

    def complete(self, request):
        purpose = request.prompt.prompt_id
        if purpose not in {"suggestion", "portrait"}:
            return self.delegate.complete(request)
        if self.budget.target_reached():
            self.budget.record(
                {
                    "event": "search-stop",
                    "reason": "evaluable-factor-target",
                    "boundary": purpose,
                }
            )
            raise EvaluableTargetReached()
        content = None
        try:
            response = self.delegate.complete(request)
            content = response.content
            if not auxiliary_response_valid(purpose, content):
                raise ValueError("Unusable MCTS auxiliary response: " + purpose)
        except Exception as error:
            self.budget.auxiliary(purpose, False, content, type(error).__name__)
            raise
        self.budget.auxiliary(purpose, True, content, None)
        return response


class ArmBudget:
    def __init__(self, limits):
        self.limits = limits
        self.lock = Lock()
        self.slots = self.requests = self.tokens = self.held_tokens = 0
        self.prompt_tokens = self.rejected_requests = 0
        self.unknown_usage = 0
        self.blocked = Counter()
        self.evaluable = {}
        self.evaluation_pending = set()
        self.evaluation_attempts = self.evaluation_completions = 0
        self.auxiliary_successes = self.auxiliary_failures = 0
        self.record = lambda event: None

    def target_reached(self):
        with self.lock:
            return len(self.evaluable) >= self.limits.evaluable_factors

    def _available(self):
        if self.unknown_usage:
            raise BudgetReached("unknown-request-usage")
        if self.auxiliary_failures:
            raise BudgetReached("unusable-auxiliary-response")
        if len(self.evaluable) >= self.limits.evaluable_factors:
            raise BudgetReached("evaluable-factor-target")

    def proposal(self, slots):
        with self.lock:
            self._available()
            if self.slots + slots > self.limits.proposal_slots:
                raise BudgetReached("proposal-slot-limit")
            self.slots += slots
            self.record({"event": "proposal-reserved", "slots": slots})

    def reserve_request(self, maximum):
        with self.lock:
            if self.unknown_usage:
                raise BudgetReached("unknown-request-usage")
            if self.auxiliary_failures:
                raise BudgetReached("unusable-auxiliary-response")
            if (
                type(maximum) is not int
                or not 0 < maximum <= self.limits.max_output_tokens
            ):
                raise ValueError("Unadmitted output-token limit")
            if self.requests >= self.limits.physical_requests:
                raise BudgetReached("physical-request-limit")
            if self.tokens + self.held_tokens + maximum > self.limits.completion_tokens:
                raise BudgetReached("completion-token-limit")
            self.requests += 1
            self.held_tokens += maximum
            return self.requests

    def settle(self, maximum, usage):
        with self.lock:
            self.held_tokens -= maximum
            if usage is None:
                self.unknown_usage += 1
            else:
                self.tokens += usage["completion_tokens"]
                self.prompt_tokens += usage["prompt_tokens"]

    def start_evaluation(self, key):
        with self.lock:
            if key in self.evaluable or key in self.evaluation_pending:
                raise BudgetReached("duplicate-factor-evaluation")
            if (
                len(self.evaluable) + len(self.evaluation_pending)
                >= self.limits.evaluable_factors
            ):
                raise BudgetReached("evaluable-factor-reservation-limit")
            self.evaluation_pending.add(key)
            self.evaluation_attempts += 1

    def finish_evaluation(self, key, result, eligible):
        with self.lock:
            self.evaluation_pending.remove(key)
            self.evaluation_completions += result is not None
            if eligible:
                self.evaluable[key] = result
                self.record({"event": "evaluable-factor", "factorId": key})

    def summary(self):
        with self.lock:
            return {
                "requestedProposalSlots": self.slots,
                "physicalRequests": self.requests,
                "completionTokens": self.tokens,
                "promptTokens": self.prompt_tokens,
                "rejectedRequests": self.rejected_requests,
                "heldCompletionTokens": self.held_tokens,
                "unknownUsageRequests": self.unknown_usage,
                "evaluableFactors": len(self.evaluable),
                "evaluationAttempts": self.evaluation_attempts,
                "completedEvaluations": self.evaluation_completions,
                "pendingEvaluations": len(self.evaluation_pending),
                "successfulAuxiliaryResponses": self.auxiliary_successes,
                "failedAuxiliaryResponses": self.auxiliary_failures,
                "blocked": dict(self.blocked),
            }

    def auxiliary(self, purpose, valid, content, error_type):
        with self.lock:
            self.auxiliary_successes += valid
            self.auxiliary_failures += not valid
            self.record(
                {
                    "event": "auxiliary-response",
                    "purpose": purpose,
                    "valid": valid,
                    "contentSha256": hashlib.sha256(
                        content.strip().encode()
                    ).hexdigest()
                    if isinstance(content, str)
                    else None,
                    "errorType": error_type,
                }
            )


class FlamingoTransport:
    def __init__(self, budget, seed, model_identity, journal, wire_directory=None):
        self.budget, self.seed, self.model_identity = budget, seed, model_identity
        self.journal = journal
        self.lock = Lock()
        self.budget.record = self.record
        self.opener = urllib.request.build_opener(NoRedirect())
        self.wire_directory = wire_directory
        if wire_directory is not None:
            wire_directory.mkdir()

    def record(self, event):
        with self.lock:
            self.journal.write(json.dumps(event, allow_nan=False) + "\n")
            self.journal.flush()

    def post_json(self, url, headers, payload, timeout_seconds):
        from cosmosalpha.llm.errors import LLMClientError
        from cosmosalpha.llm.openai_compatible import JsonHttpResponse

        if url != ENDPOINT + "/chat/completions" or payload.get("model") != MODEL:
            raise LLMClientError("FROZEN_MODEL_ROUTE_MISMATCH")
        if not isinstance(payload.get("messages"), list) or not payload["messages"]:
            with self.budget.lock:
                self.budget.rejected_requests += 1
            self.record({"event": "request-rejected", "reason": "empty-conversation"})
            raise LLMClientError("FROZEN_EMPTY_CONVERSATION")
        maximum = payload.get("max_tokens")
        try:
            number = self.budget.reserve_request(maximum)
        except BudgetReached as error:
            with self.budget.lock:
                self.budget.blocked[str(error)] += 1
            raise LLMClientError("FROZEN_BUDGET: " + str(error)) from error
        body = {**payload, **PROFILE, "seed": self.seed}
        body.pop("reasoning_effort", None)
        encoded = json.dumps(body, ensure_ascii=False).encode()
        event = {"number": number, "seed": self.seed, "maxTokens": maximum}
        self.record(
            {
                **event,
                "event": "started",
                "requestSha256": hashlib.sha256(encoded).hexdigest(),
                "model": MODEL,
                "parameters": PROFILE,
                "authorizationHeaderSent": False,
            }
        )
        started = time.monotonic()
        usage = None
        try:
            if self.wire_directory is not None:
                with (self.wire_directory / f"{number:06d}-request.json").open(
                    "xb"
                ) as stream:
                    stream.write(encoded)
            request = urllib.request.Request(
                url,
                data=encoded,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            try:
                response = self.opener.open(request, timeout=timeout_seconds)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                status, raw = response.status, response.read().decode()
                if self.wire_directory is not None:
                    with (self.wire_directory / f"{number:06d}-response.json").open(
                        "x"
                    ) as stream:
                        stream.write(raw)
                if serving_identity(response) != self.model_identity:
                    raise ValueError("Serving identity drifted during inference")
            value = json.loads(raw)
            candidate = value.get("usage")
            if (
                isinstance(candidate, dict)
                and all(
                    type(candidate.get(k)) is int and candidate[k] >= 0
                    for k in ("prompt_tokens", "completion_tokens", "total_tokens")
                )
                and candidate["total_tokens"]
                == candidate["prompt_tokens"] + candidate["completion_tokens"]
                and candidate["completion_tokens"] <= maximum
                and value.get("model") == MODEL
            ):
                usage = candidate
            self.record(
                {
                    **event,
                    "event": "received",
                    "status": status,
                    "elapsedSeconds": time.monotonic() - started,
                    "responseSha256": hashlib.sha256(raw.encode()).hexdigest(),
                    "usage": usage,
                    "servingIdentity": self.model_identity,
                }
            )
            if usage is None:
                raise ValueError("Model or observed request usage is unknown")
            return JsonHttpResponse(status_code=status, body=raw, headers={})
        except Exception as error:
            self.record(
                {
                    **event,
                    "event": "failed",
                    "errorType": type(error).__name__,
                    "elapsedSeconds": time.monotonic() - started,
                }
            )
            raise LLMClientError("FROZEN_TRANSPORT: " + type(error).__name__) from error
        finally:
            self.budget.settle(maximum, usage)


def write_toml(path, value):
    lines = []

    def table(values, prefix=(), array=False):
        if prefix:
            bracket = "[[" if array else "["
            lines.append(bracket + ".".join(prefix) + bracket.replace("[", "]"))
        children = []
        for key, item in values.items():
            name = (
                key if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key) else json.dumps(key)
            )
            if isinstance(item, dict):
                children.append((prefix + (name,), item, False))
            elif isinstance(item, list) and item and isinstance(item[0], dict):
                children.extend((prefix + (name,), child, True) for child in item)
            else:
                # Preserve float literals required by the native typed decoder.
                lines.append(name + " = " + json.dumps(item, allow_nan=False))
        lines.append("")
        for child_prefix, child, repeated in children:
            table(child, child_prefix, repeated)

    table(value)
    with Path(path).open("x") as stream:
        stream.write("\n".join(lines))


def limits_for(kind):
    if kind == "study":
        return Limits()
    if kind == "acceptance":
        return Limits(
            evaluable_factors=4,
            proposal_slots=16,
            physical_requests=80,
            completion_tokens=800_000,
        )
    raise ValueError("Unknown experiment kind")


def freeze(request_path, output):
    import cosmosalpha
    import cosmosalpha_native_experiment as native

    request_path = Path(request_path).resolve()
    request = json.loads(request_path.read_text())
    required = {
        "schemaVersion",
        "baseConfig",
        "targetRequest",
        "targetDirectory",
        "downstreamConfig",
        "kind",
    }
    if (
        set(request) != required
        or request["schemaVersion"] != "bayn.cosmosalpha-experiment-request.v1"
        or request["kind"] not in {"study", "acceptance"}
    ):
        raise ValueError("Invalid frozen-experiment request")
    paths = {
        k: (request_path.parent / request[k]).resolve()
        for k in required - {"schemaVersion", "kind"}
    }
    versions = runtime_versions()
    root = Path(output).resolve()
    root.mkdir()
    source = write_source_identity(
        Path(cosmosalpha.__file__).parent, root / "source-identity.json"
    )
    # The verifier recomputes all rows; an earlier PASS receipt is not admission.
    proof = verify(paths["targetRequest"], paths["targetDirectory"])
    if proof["status"] != "PASS":
        raise ValueError("Calendar-target verification failed")
    write_json(root / "target-verification.json", proof)
    base = tomllib.loads(paths["baseConfig"].read_text())
    model_base = tomllib.loads(paths["downstreamConfig"].read_text())
    providers = {
        role: str(Path(base["qlib"][role]["provider_uri"]).expanduser().resolve())
        for role in ["market", "exposure", "mask"]
    }
    for role, directory in providers.items():
        base["qlib"][role]["provider_uri"] = directory
    if (
        base["architecture"]["name"] != "graph"
        or base["data"]["end_date"] != "2019-05-31"
    ):
        raise ValueError("Expected the training-only native Graph configuration")
    base["llm"].update(
        base_url=ENDPOINT,
        model_alias=MODEL,
        api_key="SELF_HOSTED_ANONYMOUS",
        base_url_env="BAYN_FROZEN_UNUSED_URL",
        api_key_env="BAYN_FROZEN_UNUSED_KEY",
    )
    base["runtime"]["max_workers"] = 4
    base["storage"]["root"] = str(root / "runs")
    seeds = [20260823, 20260824, 20260825] if request["kind"] == "study" else [20260823]
    limits = limits_for(request["kind"])
    runs = []
    for i, seed in enumerate(seeds):
        order = ARMS[i:] + ARMS[:i]
        for arm in order:
            config = json.loads(json.dumps(base))
            config["runtime"]["random_seed"] = seed
            config["graph"]["initialization"]["random_seed"] = seed
            safety_limit = 300 if request["kind"] == "study" else 100
            config["graph"]["search"]["max_expansion_attempts"] = safety_limit
            config["graph"]["flow"]["gamma"] = 0.0 if arm == "no-flow" else 0.75
            if arm == "mcts":
                config["architecture"]["name"] = "mcts"
                config.pop("graph")
                config["mcts"] = {
                    "max_iterations": safety_limit,
                    "exploration_weight": 1.0,
                    "initial_budget": 4,
                    "budget_increment": 3,
                    "breakthrough_relax": 0.95,
                }
            run_id = f"calendar-{request['kind']}-{seed}-{arm}"
            config_path = root / (run_id + ".toml")
            write_toml(config_path, config)
            native.admit_config(config_path, run_id)
            model_config = json.loads(json.dumps(model_base))
            model_config["qlib"] = base["qlib"]
            model_config["factor_source"].update(
                storage_root=str(root / "pools"),
                run_id=run_id,
                include_rejected_factors=True,
            )
            model_config["output"]["root"] = str(root / "models")
            model_path = root / (run_id + "-model.toml")
            write_toml(model_path, model_config)
            native.admit_model_config(model_path)
            runs.append(
                {
                    "runId": run_id,
                    "seed": seed,
                    "arm": arm,
                    "config": config_path.name,
                    "sha256": digest(config_path),
                    "downstreamConfig": model_path.name,
                    "downstreamSha256": digest(model_path),
                }
            )
    write_json(root / "provider-identity.json", provider_inventory(providers))
    provider_binding = {
        "providers": providers,
        "providerIdentityFile": "provider-identity.json",
        "providerIdentitySha256": digest(root / "provider-identity.json"),
    }
    prepared = native.prepare_inputs(
        root, root / runs[0]["config"], paths["targetDirectory"], proof["targetId"]
    )
    consumption = verify(
        paths["targetRequest"],
        paths["targetDirectory"],
        [
            (root / (name + "-source.json"), root / "inputs" / "artifacts")
            for name in ["mining", "downstream"]
        ],
    )
    if consumption["status"] != "PASS":
        raise ValueError("Native source/target consumption verification failed")
    write_json(root / "source-consumption-verification.json", consumption)
    verify_provider_inventory(root, provider_binding)
    audit_plan = {
        "sourceCommit": SOURCE_COMMIT,
        "sourceIdentityFile": "source-identity.json",
        "sourceIdentitySha256": source["manifestSha256"],
        "runs": runs,
    }
    write_json(root / "configuration-audit-plan.json", audit_plan)
    audit = subprocess.run(
        [
            "bun",
            str(Path(__file__).with_name("audit-cosmosalpha-study.ts")),
            str(root / "configuration-audit-plan.json"),
            str(Path(cosmosalpha.__file__).parent),
        ],
        capture_output=True,
        text=True,
    )
    audit_report = json.loads(audit.stdout)
    write_json(root / "configuration-audit.json", audit_report)
    if audit.returncode != 0:
        raise ValueError("Native configurations are not matched: " + audit.stdout)
    if runtime_versions() != versions:
        raise ValueError("Native model runtime changed while freezing")
    plan = {
        "schemaVersion": SCHEMA,
        "frozenAt": datetime.now(timezone.utc).isoformat(),
        "kind": request["kind"],
        **provider_binding,
        "sourceCommit": SOURCE_COMMIT,
        "sourceIdentityFile": "source-identity.json",
        "sourceIdentitySha256": source["manifestSha256"],
        "targetId": proof["targetId"],
        "targetDirectory": str(paths["targetDirectory"]),
        "targetRequest": str(paths["targetRequest"]),
        "targetVerificationSha256": digest(root / "target-verification.json"),
        "configurationAuditSha256": digest(root / "configuration-audit.json"),
        "consumptionVerificationSha256": digest(
            root / "source-consumption-verification.json"
        ),
        "modelIdentity": live_model(),
        "modelProfile": PROFILE,
        "runtimeVersions": versions,
        "limits": asdict(limits),
        "inputs": prepared,
        "runs": runs,
        "implementation": [
            {"path": p.name, "sha256": digest(p)}
            for p in [
                Path(__file__),
                Path(native.__file__),
                Path(__file__).with_name("verify-cosmosalpha-targets.py"),
                Path(__file__).with_name("audit-cosmosalpha-study.ts"),
            ]
        ],
        "interpretation": "New calendar-target/Qwen experiment. Shortfalls and failed arms remain in the comparison. No industry-PIT or economic qualification.",
    }
    plan["experimentId"] = identity(plan)
    write_json(root / "plan.json", plan)
    return plan


def load_plan(path):
    path = Path(path).resolve()
    plan = json.loads(path.read_text())
    experiment_id = plan.pop("experimentId")
    if plan["schemaVersion"] != SCHEMA or identity(plan) != experiment_id:
        raise ValueError("Frozen experiment identity differs")
    limits = limits_for(plan.get("kind"))
    seeds = [20260823, 20260824, 20260825] if plan["kind"] == "study" else [20260823]
    expected = [
        (seed, arm) for i, seed in enumerate(seeds) for arm in ARMS[i:] + ARMS[:i]
    ]
    if (
        [(run.get("seed"), run.get("arm")) for run in plan.get("runs", [])] != expected
        or plan.get("limits") != asdict(limits)
        or plan.get("modelProfile") != PROFILE
        or plan.get("sourceCommit") != SOURCE_COMMIT
    ):
        raise ValueError("Incomplete or unmatched frozen study")
    if {item["path"] for item in plan["implementation"]} != {
        Path(__file__).name,
        "cosmosalpha_native_experiment.py",
        "verify-cosmosalpha-targets.py",
        "audit-cosmosalpha-study.ts",
    }:
        raise ValueError("Incomplete implementation identity")
    plan["experimentId"] = experiment_id
    for item in plan["implementation"]:
        if digest(Path(__file__).with_name(item["path"])) != item["sha256"]:
            raise ValueError("Experiment implementation drifted")
    for name, key in [
        ("target-verification", "targetVerificationSha256"),
        ("configuration-audit", "configurationAuditSha256"),
        ("source-consumption-verification", "consumptionVerificationSha256"),
    ]:
        if digest(path.parent / (name + ".json")) != plan[key]:
            raise ValueError("Frozen admission proof differs")
    for run in plan["runs"]:
        if run["runId"] != f"calendar-{plan['kind']}-{run['seed']}-{run['arm']}":
            raise ValueError("Frozen run identity differs")
        for key, checksum in [
            ("config", "sha256"),
            ("downstreamConfig", "downstreamSha256"),
        ]:
            if digest(path.parent / run[key]) != run[checksum]:
                raise ValueError("Frozen configuration differs")
    first_config = tomllib.loads((path.parent / plan["runs"][0]["config"]).read_text())
    if plan["providers"] != {
        role: first_config["qlib"][role]["provider_uri"]
        for role in ["market", "exposure", "mask"]
    }:
        raise ValueError("Provider inventory is detached from native configuration")
    if (
        digest(path.parent / plan["providerIdentityFile"])
        != plan["providerIdentitySha256"]
    ):
        raise ValueError("Frozen provider inventory differs")
    if digest(path.parent / plan["sourceIdentityFile"]) != plan["sourceIdentitySha256"]:
        raise ValueError("Frozen source manifest differs")
    return path.parent, plan


def execute(path):
    import cosmosalpha
    import cosmosalpha_native_experiment as native

    root, plan = load_plan(path)
    if runtime_versions() != plan["runtimeVersions"]:
        raise ValueError("Python runtime or dependencies drifted")
    verify_provider_inventory(root, plan)
    if (root / "receipts").exists() or (root / "result.json").exists():
        raise ValueError(
            "Experiment already started; audit retained state instead of replaying requests"
        )
    receipts = []
    for run in plan["runs"]:
        output = root / "receipts" / run["runId"]
        output.mkdir(parents=True)
        budget = ArmBudget(Limits(**plan["limits"]))
        started = time.monotonic()
        failure = None
        source = None
        try:
            with (output / "requests.jsonl").open("x", buffering=1) as journal:
                source = native_source(
                    root / plan["sourceIdentityFile"], Path(cosmosalpha.__file__).parent
                )
                if (
                    live_model() != plan["modelIdentity"]
                    or digest(root / run["config"]) != run["sha256"]
                ):
                    raise ValueError("Frozen model or configuration drifted before arm")
                verify_provider_inventory(root, plan)
                transport = FlamingoTransport(
                    budget, run["seed"], plan["modelIdentity"], journal, output / "wire"
                )
                native.run_arm(root, plan, run, budget, transport, output)
        except Exception as error:
            failure = {"type": type(error).__name__, "message": str(error)}
        summary = budget.summary()
        identity_failure = None
        try:
            unchanged = (
                source is not None
                and live_model() == plan["modelIdentity"]
                and runtime_versions() == plan["runtimeVersions"]
                and verify_provider_inventory(root, plan)
                and native_source(
                    root / plan["sourceIdentityFile"], Path(cosmosalpha.__file__).parent
                )
                == source
            )
        except Exception as error:
            unchanged = False
            identity_failure = {"type": type(error).__name__, "message": str(error)}
        complete = (
            failure is None
            and unchanged
            and not summary["unknownUsageRequests"]
            and not summary["heldCompletionTokens"]
            and not summary["pendingEvaluations"]
            and not summary["rejectedRequests"]
            and not summary["failedAuxiliaryResponses"]
            and (run["arm"] != "mcts" or summary["successfulAuxiliaryResponses"] > 0)
            and summary["completedEvaluations"] >= summary["evaluableFactors"]
            and summary["evaluableFactors"] == plan["limits"]["evaluable_factors"]
        )
        receipt = {
            "runId": run["runId"],
            "arm": run["arm"],
            "seed": run["seed"],
            "experimentId": plan["experimentId"],
            "targetId": plan["targetId"],
            "status": "COMPLETE" if complete else "INCONCLUSIVE",
            "failure": failure,
            "identityVerificationFailure": identity_failure,
            "identityUnchanged": unchanged,
            "wallSeconds": time.monotonic() - started,
            "resources": summary,
            "externalModelFeeUsd": 0,
            "economicQualification": "NOT_ESTABLISHED",
        }
        write_json(output / "result.json", receipt)
        receipts.append(receipt)
        print(json.dumps(receipt), flush=True)
    models = []
    if all(receipt["status"] == "COMPLETE" for receipt in receipts):
        # No held-out fitting starts until every planned factor pool is frozen.
        for run in plan["runs"]:
            try:
                load_plan(path)
                native_source(
                    root / plan["sourceIdentityFile"], Path(cosmosalpha.__file__).parent
                )
                verify_provider_inventory(root, plan)
                if runtime_versions() != plan["runtimeVersions"]:
                    raise ValueError("Runtime drifted before held-out fitting")
                model = native.downstream(root, plan, run)
                verify_provider_inventory(root, plan)
                write_json(
                    root / "receipts" / run["runId"] / "model-result.json", model
                )
                models.append(
                    {
                        "runId": run["runId"],
                        "status": "COMPLETE",
                        "metrics": model["metrics"],
                        "portfolioMetrics": model["portfolio_metrics"],
                    }
                )
            except Exception as error:
                models.append(
                    {
                        "runId": run["runId"],
                        "status": "INCONCLUSIVE",
                        "failure": {
                            "type": type(error).__name__,
                            "message": str(error),
                        },
                    }
                )
    verification = audit(path)
    write_json(root / "verification.json", verification)
    result = {
        "experimentId": plan["experimentId"],
        "kind": plan["kind"],
        "status": "COMPLETE"
        if verification["status"] == "PASS"
        and len(models) == len(plan["runs"])
        and all(r["status"] == "COMPLETE" for r in [*receipts, *models])
        else "INCONCLUSIVE",
        "arms": receipts,
        "models": models,
        "comparison": compare_models(plan, models)
        if verification["status"] == "PASS"
        and len(models) == len(plan["runs"])
        and all(model["status"] == "COMPLETE" for model in models)
        else None,
        "verificationSha256": digest(root / "verification.json"),
        "capitalAuthority": "NONE",
    }
    write_json(root / "result.json", result)
    return result


def compare_models(plan, models):
    by_run = {model["runId"]: model for model in models}
    values = {}
    for run in plan["runs"]:
        model = by_run[run["runId"]]
        signal, portfolio = model["metrics"], model["portfolioMetrics"]
        values[(run["seed"], run["arm"])] = {
            key: signal[key]
            for key in ["ic_mean", "ic_ir", "rank_ic_mean", "rank_ic_ir"]
        } | {
            key: portfolio[key]
            for key in ["annualized_return", "information_ratio", "max_drawdown"]
        }
    seeds = sorted({seed for seed, _ in values})
    paired = {}
    for control in ["mcts", "no-flow"]:
        paired["graph-minus-" + control] = {}
        for metric in next(iter(values.values())):
            differences = [
                values[(seed, "graph")][metric] - values[(seed, control)][metric]
                for seed in seeds
            ]
            paired["graph-minus-" + control][metric] = {
                "seeds": seeds,
                "differences": differences,
                "mean": mean(differences),
                "sampleStd": stdev(differences) if len(differences) > 1 else None,
            }
    return {
        "paired": paired,
        "scope": "All registered replicates. Reference zero-cost portfolio diagnostics; no economic qualification.",
    }


def audit(path):
    root, plan = load_plan(path)
    findings = []
    results = []
    for run in plan["runs"]:
        output = root / "receipts" / run["runId"]
        try:
            receipt = json.loads((output / "result.json").read_text())
            events = [
                json.loads(line)
                for line in (output / "requests.jsonl").read_text().splitlines()
            ]
            starts = [event for event in events if event["event"] == "started"]
            received = {
                event["number"]: event
                for event in events
                if event["event"] == "received"
            }
            terminal = {
                event["number"]
                for event in events
                if event["event"] in {"received", "failed"}
            }
            numbers = {event["number"] for event in starts}
            if numbers != set(range(1, len(starts) + 1)) or terminal != numbers:
                raise ValueError("Missing, duplicate or unfinished physical requests")
            for event in starts:
                if (
                    event["seed"] != run["seed"]
                    or event["model"] != MODEL
                    or event["parameters"] != PROFILE
                    or event["authorizationHeaderSent"] is not False
                ):
                    raise ValueError("Physical request differs from frozen profile")
                if (
                    digest(output / "wire" / f"{event['number']:06d}-request.json")
                    != event["requestSha256"]
                ):
                    raise ValueError("Physical request body differs")
                wire = json.loads(
                    (
                        output / "wire" / f"{event['number']:06d}-request.json"
                    ).read_text()
                )
                if (
                    wire.get("model") != MODEL
                    or wire.get("seed") != run["seed"]
                    or wire.get("max_tokens") != event["maxTokens"]
                    or any(wire.get(key) != value for key, value in PROFILE.items())
                    or "reasoning_effort" in wire
                ):
                    raise ValueError(
                        "Actual submitted parameters differ from the frozen profile"
                    )
            for number, event in received.items():
                if (
                    digest(output / "wire" / f"{number:06d}-response.json")
                    != event["responseSha256"]
                    or event["servingIdentity"] != plan["modelIdentity"]
                ):
                    raise ValueError("Physical response or serving identity differs")
                wire = json.loads(
                    (output / "wire" / f"{number:06d}-response.json").read_text()
                )
                if wire.get("usage") != event["usage"] or wire.get("model") != MODEL:
                    raise ValueError(
                        "Raw response usage or model differs from the journal"
                    )
            tokens = sum(
                event["usage"]["completion_tokens"]
                for event in received.values()
                if event["usage"] is not None
            )
            unknown = sum(
                number not in received or received[number]["usage"] is None
                for number in numbers
            )
            pool = json.loads((output / "pool.json").read_text())
            target = root / "pools" / run["runId"] / "factor_library" / "factors.csv"
            if (
                digest(target) != pool["csvSha256"]
                or len(set(pool["factorIds"])) != pool["evaluableFactors"]
            ):
                raise ValueError("Frozen factor pool differs")
            observed = {
                event["factorId"]
                for event in events
                if event["event"] == "evaluable-factor"
            }
            if observed != set(pool["factorIds"]):
                raise ValueError("Evaluator journal differs from admitted pool")
            resources = receipt["resources"]
            expected = {
                "physicalRequests": len(starts),
                "completionTokens": tokens,
                "promptTokens": sum(
                    event["usage"]["prompt_tokens"]
                    for event in received.values()
                    if event["usage"] is not None
                ),
                "rejectedRequests": sum(
                    event["event"] == "request-rejected" for event in events
                ),
                "unknownUsageRequests": unknown,
                "evaluableFactors": len(observed),
                "requestedProposalSlots": sum(
                    event["slots"]
                    for event in events
                    if event["event"] == "proposal-reserved"
                ),
                "successfulAuxiliaryResponses": sum(
                    event["event"] == "auxiliary-response" and event["valid"]
                    for event in events
                ),
                "failedAuxiliaryResponses": sum(
                    event["event"] == "auxiliary-response" and not event["valid"]
                    for event in events
                ),
            }
            if any(resources[key] != value for key, value in expected.items()):
                raise ValueError("Resource receipt differs from physical evidence")
            if resources["rejectedRequests"]:
                raise ValueError("Native runtime submitted a malformed model request")
            if expected["failedAuxiliaryResponses"] or (
                run["arm"] == "mcts" and not expected["successfulAuxiliaryResponses"]
            ):
                raise ValueError(
                    "MCTS auxiliary helpers did not produce usable responses"
                )
            contents = {}
            for number in received:
                response = json.loads(
                    (output / "wire" / f"{number:06d}-response.json").read_text()
                )
                for choice in response.get("choices", []):
                    content = choice.get("message", {}).get("content")
                    if isinstance(content, str):
                        contents[
                            hashlib.sha256(content.strip().encode()).hexdigest()
                        ] = content
            for event in events:
                if event["event"] == "auxiliary-response" and (
                    event["contentSha256"] not in contents
                    or not auxiliary_response_valid(
                        event["purpose"], contents[event["contentSha256"]]
                    )
                ):
                    raise ValueError(
                        "Auxiliary evidence differs from actual model content"
                    )
            if (
                tokens > plan["limits"]["completion_tokens"]
                or len(starts) > plan["limits"]["physical_requests"]
                or expected["requestedProposalSlots"] > plan["limits"]["proposal_slots"]
            ):
                raise ValueError("Frozen budget exceeded")
            expected_returns = plan["inputs"]["mining"]["targetArtifactId"]
            evaluated_factors = set()
            for candidate in (
                root / "runs" / run["runId"] / "objects" / "evaluation_result"
            ).glob("*.json"):
                evaluation = json.loads(candidate.read_text())
                if evaluation["forward_return_ref"]["artifact_id"] != expected_returns:
                    raise ValueError("Native evaluator consumed unverified labels")
                evaluated_factors.add(evaluation["factor_id"])
            if not observed.issubset(evaluated_factors):
                raise ValueError("Matched pool is missing native evaluation evidence")
            if (
                receipt["experimentId"] != plan["experimentId"]
                or receipt["targetId"] != plan["targetId"]
                or not receipt["identityUnchanged"]
            ):
                raise ValueError("Arm identity differs")
            if (
                receipt["status"] != "COMPLETE"
                or unknown
                or len(observed) != plan["limits"]["evaluable_factors"]
            ):
                raise ValueError("Arm is incomplete or has unknown usage")
            model = json.loads((output / "model-result.json").read_text())
            model_root = root / "models" / (run["runId"] + "-model")
            for key in [
                "model_ref",
                "training_curve_ref",
                "predictions_ref",
                "daily_signal_metrics_ref",
                "portfolio_report_ref",
                "portfolio_positions_ref",
            ]:
                ref = model[key]
                artifact_path = (
                    model_root
                    / "artifacts"
                    / ref["artifact_id"][:2]
                    / ref["artifact_id"]
                )
                if (
                    digest(artifact_path) != ref["artifact_id"]
                    or artifact_path.stat().st_size != ref["size_bytes"]
                ):
                    raise ValueError("Native model output artifact differs")
            if model["selected_factor_count"] != len(observed):
                raise ValueError("Downstream did not use the complete matched pool")
            consumption = json.loads(
                (
                    root
                    / "models"
                    / (run["runId"] + "-model")
                    / "target-consumption.json"
                ).read_text()
            )
            if consumption != plan["inputs"]["downstream"]:
                raise ValueError("Downstream target binding differs")
            results.append(
                {
                    "runId": run["runId"],
                    "resources": expected,
                    "receiptSha256": digest(output / "result.json"),
                    "modelSha256": digest(output / "model-result.json"),
                }
            )
        except (OSError, ValueError, KeyError, TypeError) as error:
            findings.append({"runId": run["runId"], "detail": str(error)})
    return {
        "experimentId": plan["experimentId"],
        "kind": plan["kind"],
        "status": "PASS"
        if not findings and len(results) == len(plan["runs"])
        else "FAIL",
        "arms": results,
        "verificationFailures": len(findings),
        "findings": findings,
        "scope": "Frozen targets, all planned pools, actual requests, matched allowances and downstream consumption. No industry-PIT or economic qualification.",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    prepare = commands.add_parser("freeze")
    prepare.add_argument("request")
    prepare.add_argument("output")
    run = commands.add_parser("run")
    run.add_argument("plan")
    check = commands.add_parser("audit")
    check.add_argument("plan")
    args = parser.parse_args()
    if args.command == "freeze":
        result = freeze(args.request, args.output)
    elif args.command == "run":
        result = execute(args.plan)
    else:
        result = audit(args.plan)
    print(json.dumps(result, indent=2), flush=True)
    return 0 if result.get("status", "COMPLETE") in {"COMPLETE", "PASS"} else 1


if __name__ == "__main__":
    raise SystemExit(main())
