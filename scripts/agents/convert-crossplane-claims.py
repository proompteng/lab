#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any, Iterable

import yaml

AGENT_KIND = "Agent"
AGENTRUN_KIND = "AgentRun"
AGENTPROVIDER_KIND = "AgentProvider"
NATIVE_API_VERSION = "agents.proompteng.ai/v1alpha1"

CROSSPLANE_SPEC_FIELDS = {
    "compositionRef",
    "compositionSelector",
    "compositeDeletePolicy",
    "publishConnectionDetailsTo",
    "resourceRef",
    "writeConnectionSecretToRef",
}

DROP_ANNOTATION_PREFIXES = (
    "crossplane.io/",
    "composition.crossplane.io/",
)

DROP_ANNOTATIONS = {
    "kubectl.kubernetes.io/last-applied-configuration",
}

METADATA_ALLOWLIST = {
    "name",
    "namespace",
    "labels",
    "annotations",
}

AGENT_SPEC_ALLOWLIST = {
    "providerRef",
    "env",
    "security",
    "defaults",
    "memoryRef",
}

AGENTRUN_SPEC_ALLOWLIST = {
    "agentRef",
    "parameters",
    "idempotencyKey",
    "implementation",
    "implementationSpecRef",
    "memoryRef",
    "secrets",
    "workload",
}

AGENTPROVIDER_SPEC_ALLOWLIST = {
    "binary",
    "argsTemplate",
    "envTemplate",
    "inputFiles",
    "outputArtifacts",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Convert Crossplane Agent claims to native agents.proompteng.ai/v1alpha1 CRDs.",
    )
    parser.add_argument(
        "inputs",
        nargs="+",
        help="Input YAML files from kubectl export. Use '-' to read from stdin.",
    )
    parser.add_argument(
        "--output",
        help="Write all converted resources to this file (default: stdout).",
    )
    parser.add_argument(
        "--output-dir",
        help="Write converted resources into native-*.yaml files in this directory.",
    )
    parser.add_argument(
        "--default-runtime",
        choices=["argo", "temporal", "job", "custom"],
        help="Default runtime type for AgentRuns when none can be inferred.",
    )
    return parser.parse_args()


def load_documents(paths: Iterable[str]) -> Iterable[dict[str, Any]]:
    for path in paths:
        if path == "-":
            content = sys.stdin.read()
        else:
            content = Path(path).read_text(encoding="utf-8")
        for doc in yaml.safe_load_all(content):
            if isinstance(doc, dict):
                yield doc


def expand_items(doc: dict[str, Any]) -> Iterable[dict[str, Any]]:
    items = doc.get("items")
    kind = doc.get("kind", "")
    if isinstance(items, list) and (kind == "List" or kind.endswith("List")):
        for item in items:
            if isinstance(item, dict):
                yield item
    else:
        yield doc


def sanitize_annotations(annotations: dict[str, Any] | None) -> dict[str, Any] | None:
    if not annotations:
        return None
    sanitized = {
        key: value
        for key, value in annotations.items()
        if key not in DROP_ANNOTATIONS and not key.startswith(DROP_ANNOTATION_PREFIXES)
    }
    return sanitized or None


def sanitize_metadata(metadata: dict[str, Any] | None) -> dict[str, Any]:
    if not metadata:
        return {}
    sanitized: dict[str, Any] = {}
    for key in METADATA_ALLOWLIST:
        if key in metadata and metadata[key] not in (None, ""):
            sanitized[key] = metadata[key]
    sanitized_annotations = sanitize_annotations(sanitized.get("annotations"))
    if sanitized_annotations is not None:
        sanitized["annotations"] = sanitized_annotations
    else:
        sanitized.pop("annotations", None)
    return sanitized


def build_agent_spec(spec: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    dropped: list[str] = []
    output: dict[str, Any] = {}

    for key in AGENT_SPEC_ALLOWLIST:
        if key in spec:
            output[key] = spec[key]

    config_fields = ["runtime", "inputs", "payloads", "resources", "observability"]
    config: dict[str, Any] = {}
    for key in config_fields:
        if key in spec:
            config[key] = spec[key]

    if config:
        output["config"] = config

    for key in spec.keys():
        if key in AGENT_SPEC_ALLOWLIST or key in config_fields or key in CROSSPLANE_SPEC_FIELDS:
            continue
        dropped.append(key)

    return output, dropped


def build_agentrun_spec(
    spec: dict[str, Any],
    default_runtime: str | None,
) -> tuple[dict[str, Any], list[str], list[str]]:
    dropped: list[str] = []
    warnings: list[str] = []
    output: dict[str, Any] = {}

    for key in AGENTRUN_SPEC_ALLOWLIST:
        if key in spec:
            output[key] = spec[key]

    if "deliveryId" in spec and "idempotencyKey" not in output:
        output["idempotencyKey"] = spec["deliveryId"]

    runtime = spec.get("runtime")
    runtime_overrides = spec.get("runtimeOverrides")
    runtime_config: dict[str, Any] = {}

    def build_runtime(runtime_type: str | None, config: dict[str, Any]) -> dict[str, Any]:
        runtime_output: dict[str, Any] = {"type": runtime_type}
        if config:
            runtime_output["config"] = config
        return runtime_output

    if isinstance(runtime, dict):
        runtime_config = dict(runtime.get("config", {}) or {})
        output["runtime"] = build_runtime(runtime.get("type"), runtime_config)
    else:
        runtime = None

    if isinstance(runtime_overrides, dict) and "argo" in runtime_overrides:
        argo_overrides = runtime_overrides.get("argo") or {}
        if isinstance(argo_overrides, dict):
            runtime_config.update({k: v for k, v in argo_overrides.items() if v is not None})
        output["runtime"] = build_runtime("argo", runtime_config)

    if "runtime" not in output:
        if default_runtime:
            output["runtime"] = build_runtime(default_runtime, runtime_config)
        else:
            warnings.append("spec.runtime missing; provide --default-runtime to set required runtime.type.")

    if "runtime" in output:
        runtime_config = dict(output["runtime"].get("config") or {})
        if "timeoutSeconds" in spec and "timeoutSeconds" not in runtime_config:
            runtime_config["timeoutSeconds"] = spec["timeoutSeconds"]
        if "retryPolicy" in spec and "retryPolicy" not in runtime_config:
            runtime_config["retryPolicy"] = spec["retryPolicy"]
        if runtime_config:
            output["runtime"]["config"] = runtime_config
        else:
            output["runtime"].pop("config", None)

    for key in spec.keys():
        if (
            key in AGENTRUN_SPEC_ALLOWLIST
            or key in {"deliveryId", "runtime", "runtimeOverrides", "timeoutSeconds", "retryPolicy"}
            or key in CROSSPLANE_SPEC_FIELDS
        ):
            continue
        dropped.append(key)

    return output, dropped, warnings


def build_agentprovider_spec(spec: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    dropped: list[str] = []
    output: dict[str, Any] = {}

    for key in AGENTPROVIDER_SPEC_ALLOWLIST:
        if key in spec:
            output[key] = spec[key]

    for key in spec.keys():
        if key in AGENTPROVIDER_SPEC_ALLOWLIST or key in CROSSPLANE_SPEC_FIELDS:
            continue
        dropped.append(key)

    return output, dropped


def validate_required(kind: str, spec: dict[str, Any], warnings: list[str]) -> list[str]:
    errors: list[str] = []
    if kind == AGENT_KIND and not spec.get("providerRef"):
        errors.append("spec.providerRef is required for Agent.")
    if kind == AGENTRUN_KIND:
        if not spec.get("agentRef"):
            errors.append("spec.agentRef is required for AgentRun.")
        runtime_type = (spec.get("runtime") or {}).get("type")
        if not runtime_type:
            errors.append("spec.runtime.type is required for AgentRun.")
        if not (spec.get("implementation") or spec.get("implementationSpecRef")):
            errors.append("spec.implementation or spec.implementationSpecRef is required for AgentRun.")
    if kind == AGENTPROVIDER_KIND and not spec.get("binary"):
        errors.append("spec.binary is required for AgentProvider.")
    if warnings:
        for warning in warnings:
            print(f"warning: {warning}", file=sys.stderr)
    return errors


def convert_resource(resource: dict[str, Any], default_runtime: str | None) -> tuple[dict[str, Any], list[str]]:
    kind = resource.get("kind")
    spec = resource.get("spec") if isinstance(resource.get("spec"), dict) else {}
    metadata = sanitize_metadata(resource.get("metadata") if isinstance(resource.get("metadata"), dict) else {})

    dropped: list[str] = []
    warnings: list[str] = []
    output_spec: dict[str, Any] = {}

    if kind == AGENT_KIND:
        output_spec, dropped = build_agent_spec(spec)
    elif kind == AGENTRUN_KIND:
        output_spec, dropped, warnings = build_agentrun_spec(spec, default_runtime)
    elif kind == AGENTPROVIDER_KIND:
        output_spec, dropped = build_agentprovider_spec(spec)
    else:
        return {}, []

    errors = validate_required(kind, output_spec, warnings)
    if errors:
        name = metadata.get("name", "<unknown>")
        error_msg = "; ".join(errors)
        raise ValueError(f"{kind}/{name}: {error_msg}")

    output: dict[str, Any] = {
        "apiVersion": NATIVE_API_VERSION,
        "kind": kind,
        "metadata": metadata,
        "spec": output_spec,
    }
    return output, dropped


def dump_documents(docs: list[dict[str, Any]]) -> str:
    return "\n---\n".join(yaml.safe_dump(doc, sort_keys=False).rstrip() for doc in docs) + "\n"


def main() -> int:
    args = parse_args()
    if args.output and args.output_dir:
        print("error: --output and --output-dir are mutually exclusive", file=sys.stderr)
        return 2

    errors: list[str] = []
    converted: list[dict[str, Any]] = []
    by_kind: dict[str, list[dict[str, Any]]] = {
        AGENT_KIND: [],
        AGENTRUN_KIND: [],
        AGENTPROVIDER_KIND: [],
    }

    for doc in load_documents(args.inputs):
        for resource in expand_items(doc):
            kind = resource.get("kind")
            if kind not in {AGENT_KIND, AGENTRUN_KIND, AGENTPROVIDER_KIND}:
                continue
            try:
                output, dropped = convert_resource(resource, args.default_runtime)
                if output:
                    converted.append(output)
                    by_kind[kind].append(output)
                if dropped:
                    name = output.get("metadata", {}).get("name", "<unknown>")
                    print(f"info: dropped fields from {kind}/{name}: {', '.join(dropped)}", file=sys.stderr)
            except ValueError as exc:
                errors.append(str(exc))

    if errors:
        for error in errors:
            print(f"error: {error}", file=sys.stderr)
        return 1

    if args.output_dir:
        output_dir = Path(args.output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)
        file_map = {
            AGENT_KIND: output_dir / "native-agents.yaml",
            AGENTPROVIDER_KIND: output_dir / "native-agentproviders.yaml",
            AGENTRUN_KIND: output_dir / "native-agentruns.yaml",
        }
        for kind, path in file_map.items():
            docs = by_kind[kind]
            if not docs:
                continue
            path.write_text(dump_documents(docs), encoding="utf-8")
        return 0

    output_text = dump_documents(converted)
    if args.output:
        Path(args.output).write_text(output_text, encoding="utf-8")
    else:
        sys.stdout.write(output_text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
