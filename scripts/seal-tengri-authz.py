#!/usr/bin/env python3
"""Seal the shared SpiceDB credential for the Tengri control plane."""

import argparse
import json
import subprocess
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--context", required=True)
    args = parser.parse_args()
    source = json.loads(
        subprocess.check_output(
            [
                "kubectl",
                "--context",
                args.context,
                "-n",
                "ofz",
                "get",
                "secret",
                "ofz-spicedb-key",
                "-o",
                "json",
            ]
        )
    )
    secret = {
        "apiVersion": "v1",
        "kind": "Secret",
        "metadata": {"name": "tengri-spicedb-key", "namespace": "tengri"},
        "type": "Opaque",
        "data": {"preshared_key": source["data"]["preshared_key"]},
    }
    sealed = json.loads(
        subprocess.check_output(
            [
                "kubeseal",
                "--context",
                args.context,
                "--format",
                "json",
                "--scope",
                "strict",
                "--controller-name",
                "sealed-secrets",
                "--controller-namespace",
                "sealed-secrets",
            ],
            input=json.dumps(secret).encode(),
        )
    )
    sealed["metadata"].pop("creationTimestamp", None)
    sealed["spec"]["template"]["metadata"].pop("creationTimestamp", None)
    sealed["metadata"]["annotations"] = {"argocd.argoproj.io/sync-wave": "-1"}
    destination = (
        Path(__file__).resolve().parent.parent
        / "argocd/applications/tengri/spicedb-key-sealedsecret.yaml"
    )
    destination.write_text(json.dumps(sealed, indent=2) + "\n")
    print("Sealed the SpiceDB key for tengri/tengri-spicedb-key. No live changes.")


if __name__ == "__main__":
    main()
