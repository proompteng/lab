from __future__ import annotations

import re
from pathlib import Path

import yaml


REPO_ROOT = Path(__file__).resolve().parents[3]
COMMON_IMAGE_INPUTS = {
    ".github/actions/setup-nix-toolchain/**",
    ".github/workflows/nix-oci-build-common.yml",
    ".github/workflows/torghut-build-push.yaml",
    "flake.lock",
    "flake.nix",
    "nix/cache-push.sh",
    "nix/ci-nix-oci-summary.sh",
    "nix/ci-run-timed.sh",
    "nix/images/torghut.nix",
    "nix/oci-inspect-archive.sh",
    "nix/oci-push.sh",
    "nix/oci-release-contract.sh",
    "services/torghut/**",
}


def _workflow(name: str) -> dict[str, object]:
    payload = yaml.load(
        (REPO_ROOT / ".github/workflows" / name).read_text(encoding="utf-8"),
        Loader=yaml.BaseLoader,
    )
    assert isinstance(payload, dict)
    return payload


def _event_paths(workflow: dict[str, object], event: str) -> set[str]:
    triggers = workflow["on"]
    assert isinstance(triggers, dict)
    event_config = triggers[event]
    assert isinstance(event_config, dict)
    paths = event_config["paths"]
    assert isinstance(paths, list)
    assert all(isinstance(path, str) for path in paths)
    return set(paths)


def test_build_workflow_triggers_for_every_image_input() -> None:
    workflow = _workflow("torghut-build-push.yaml")

    for event in ("push", "pull_request"):
        assert COMMON_IMAGE_INPUTS <= _event_paths(workflow, event)


def test_ci_workflow_triggers_and_classifies_every_production_input() -> None:
    workflow = _workflow("torghut-ci.yml")
    ci_inputs = COMMON_IMAGE_INPUTS | {
        ".github/workflows/torghut-ci.yml",
        ".github/workflows/torghut-release.yml",
        "argocd/applications/torghut/**",
        "argocd/applications/torghut-hyperliquid-runtime/**",
        "argocd/applications/torghut-options/**",
    }
    for event in ("push", "pull_request"):
        assert ci_inputs <= _event_paths(workflow, event)

    workflow_text = (REPO_ROOT / ".github/workflows/torghut-ci.yml").read_text(
        encoding="utf-8"
    )
    classifier_match = re.search(
        r"if matches_any '([^']+)'\; then\n\s+service=true",
        workflow_text,
    )
    assert classifier_match is not None
    classifier = re.compile(classifier_match.group(1))
    classified_samples = {
        ".github/actions/setup-nix-toolchain/action.yml",
        ".github/workflows/nix-oci-build-common.yml",
        ".github/workflows/torghut-build-push.yaml",
        ".github/workflows/torghut-ci.yml",
        ".github/workflows/torghut-release.yml",
        "flake.lock",
        "flake.nix",
        "nix/images/torghut.nix",
        "nix/oci-release-contract.sh",
        "services/torghut/app/main.py",
    }
    assert all(classifier.search(path) for path in classified_samples)
