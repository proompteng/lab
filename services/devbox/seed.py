#!/usr/bin/env python3
"""Copy the approved personal development environment over an existing SSH connection."""

import argparse
import json
import os
import pathlib
import shlex
import subprocess
import tarfile
import tempfile
import tomllib


def run(arguments, **kwargs):
    return subprocess.run(arguments, check=True, **kwargs)


def seed(args):
    source = pathlib.Path(args.source_home).expanduser().resolve()
    destination = "/home/codex"
    ssh = ["ssh", "-o", "BatchMode=yes", args.host]
    run([*ssh, 'test "$(id -un)" = codex && test -d /home/codex/src/lab/.git'])
    with tempfile.TemporaryDirectory(prefix="codex-devbox-seed-") as directory:
        archive = pathlib.Path(directory) / "personal.tar.gz"
        with tarfile.open(archive, "w:gz") as output:
            for relative in [".codex/skills", ".agents/skills", ".codex/memories"]:
                path = source / relative
                if not path.is_dir():
                    raise FileNotFoundError(path)
                output.add(path, arcname=relative)
        with archive.open("rb") as payload:
            run([*ssh, f"umask 077; tar -xzf - -C {destination}"], stdin=payload)

    guidance = (source / ".codex/AGENTS.md").read_text()
    guidance += """

## Persistent memory

Read ~/.codex/memories/memory_summary.md for relevant background. Search
~/.codex/memories/MEMORY.md before substantial work that depends on previous
decisions. Verify changing facts against the current repository and runtime.
When a memory references /Users/gregkonush/.codex/memories, resolve the suffix
under /home/codex/.codex/memories. The lab checkout here is /home/codex/src/lab.
Historical source paths are provenance, not proof that those paths exist here.
Only update memories when the user explicitly asks.
"""
    run([*ssh, "umask 077; cat > ~/.codex/AGENTS.md"], input=guidance.encode())
    config_path = source / ".codex/config.toml"
    if config_path.exists():
        settings = tomllib.loads(config_path.read_text())
        selected = {
            key: settings[key]
            for key in [
                "model",
                "model_reasoning_effort",
                "model_personality",
                "personality",
            ]
            if isinstance(settings.get(key), str)
        }
        config = "".join(
            f"{key} = {json.dumps(value)}\n" for key, value in selected.items()
        )
        run(
            [
                *ssh,
                "umask 077; test ! -e ~/.codex/config.toml || cp ~/.codex/config.toml ~/.codex/config.toml.before-seed; cat > ~/.codex/config.toml",
            ],
            input=config.encode(),
        )
    for key in ["user.name", "user.email"]:
        value = run(
            ["git", "config", "--get", key], capture_output=True, text=True
        ).stdout.strip()
        run([*ssh, f"git config --global {shlex.quote(key)} {shlex.quote(value)}"])
    if args.github_auth:
        identity = run(
            ["gh", "api", "user", "--jq", ".login"], capture_output=True, text=True
        ).stdout.strip()
        token = run(
            ["gh", "auth", "token", "--hostname", "github.com"], capture_output=True
        ).stdout
        run(
            [
                *ssh,
                "gh auth login --hostname github.com --git-protocol https --with-token",
            ],
            input=token,
            stdout=subprocess.DEVNULL,
        )
        observed = run(
            [*ssh, "gh api user --jq .login"], capture_output=True, text=True
        ).stdout.strip()
        if observed != identity:
            raise RuntimeError(
                "Remote GitHub identity differs from the approved source identity"
            )
        run([*ssh, "gh auth setup-git --hostname github.com"])
    if args.kube_context:
        config = run(
            [
                "kubectl",
                "--context",
                args.kube_context,
                "config",
                "view",
                "--raw",
                "--minify",
                "--flatten",
                "-o",
                "json",
            ],
            capture_output=True,
        ).stdout
        run([*ssh, "umask 077; mkdir -p ~/.kube; cat > ~/.kube/config"], input=config)
        run(
            [
                *ssh,
                f"kubectl --context {shlex.quote(args.kube_context)} -n default auth whoami",
            ]
        )
    run([*ssh, "codex app-server daemon restart"])
    print("Personal skills, memories, settings, and approved access were installed.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("host", help="Verified SSH alias for the codex user")
    parser.add_argument("--source-home", default=os.path.expanduser("~"))
    parser.add_argument(
        "--github-auth",
        action="store_true",
        help="Transfer the explicitly approved GitHub credential",
    )
    parser.add_argument(
        "--kube-context",
        help="Transfer only this explicitly approved Kubernetes context",
    )
    seed(parser.parse_args())
