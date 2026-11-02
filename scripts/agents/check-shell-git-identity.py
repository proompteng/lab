"""Exercise rendered Agents Shell init and runtime Git identity in local fixtures."""

import os
import subprocess
import sys
import tempfile
from pathlib import Path

import yaml


def verify(rendered_path, entrypoint_path, expected_name, expected_email):
    documents = yaml.safe_load_all(Path(rendered_path).read_text())
    deployment = next(
        doc
        for doc in documents
        if isinstance(doc, dict)
        and doc.get("kind") == "Deployment"
        and any(
            container.get("name") == "agents-shell"
            for container in doc.get("spec", {})
            .get("template", {})
            .get("spec", {})
            .get("containers", [])
        )
    )
    pod = deployment["spec"]["template"]["spec"]
    bootstrap = next(
        item for item in pod["initContainers"] if item["name"] == "bootstrap-workspace"
    )
    runtime = next(item for item in pod["containers"] if item["name"] == "agents-shell")
    identity_keys = ("AGENTS_SHELL_GIT_USER_NAME", "AGENTS_SHELL_GIT_USER_EMAIL")
    expected = dict(zip(identity_keys, (expected_name, expected_email)))
    for container in (bootstrap, runtime):
        actual = {
            item["name"]: item.get("value")
            for item in container["env"]
            if item["name"] in identity_keys
        }
        assert actual == expected, (container["name"], actual, expected)

    with tempfile.TemporaryDirectory(
        prefix="agents-shell-rendered-identity-"
    ) as directory:
        root = Path(directory)
        home = root / "runtime-home"
        home.mkdir()
        environment = {
            "PATH": os.environ["PATH"],
            "HOME": str(home),
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": str(home / ".gitconfig"),
            **expected,
        }

        def run(*args, cwd=root, env=environment):
            return subprocess.run(
                args, cwd=cwd, env=env, check=True, capture_output=True, text=True
            ).stdout.strip()

        seed = root / "seed"
        checkout = root / "checkout"
        run("git", "init", "--initial-branch=main", str(seed))
        run(
            "git",
            "-C",
            str(seed),
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "--allow-empty",
            "-m",
            "fixture",
        )
        run("git", "clone", str(seed), str(checkout))
        run("git", "-C", str(checkout), "config", "user.name", "Stale Identity")
        run("git", "-C", str(checkout), "config", "user.email", "stale@example.invalid")

        # Only relocate fixed filesystem paths. Execute the complete rendered init
        # script, with real Git clone/fetch/config and a local-only repository.
        def isolate_paths(script):
            for original, replacement in (
                ("/tmp/git-home", str(root / "init-home")),
                ("/tmp/git-credentials", str(root / "unused-credentials")),
                ("/workspace/.agents-shell", str(root / "workspace-state")),
            ):
                script = script.replace(original, replacement)
            return script

        run(
            "bash",
            "-ec",
            isolate_paths(bootstrap["args"][0]),
            env={
                **environment,
                "GIT_REPOSITORY": str(seed),
                "GIT_BRANCH": "main",
                "GIT_TARGET_PATH": str(checkout),
                "GIT_DEPTH": "0",
            },
        )

        # Stub unrelated runtime launch/install commands, never Git identity setup.
        bin_path = root / "bin"
        bin_path.mkdir()
        for name in ("gh", "bun"):
            executable = bin_path / name
            executable.write_text("#!/usr/bin/env bash\nexit 0\n")
            executable.chmod(0o755)
        scripts = root / "scripts"
        scripts.mkdir()
        installer = scripts / "install-agents-shell-pstack.sh"
        installer.write_text("#!/usr/bin/env bash\nexit 0\n")
        installer.chmod(0o755)
        run(
            "bash",
            "-ec",
            isolate_paths(Path(entrypoint_path).read_text()),
            env={
                **environment,
                "PATH": f"{bin_path}:{environment['PATH']}",
            },
        )
        assert run("git", "config", "--global", "user.name") == expected_name
        assert run("git", "config", "--global", "user.email") == expected_email
        assert (
            run("git", "-C", str(checkout), "config", "--local", "user.name")
            == expected_name
        )
        assert (
            run("git", "-C", str(checkout), "config", "--local", "user.email")
            == expected_email
        )

        worktree = root / "worktree"
        run(
            "git",
            "-C",
            str(checkout),
            "worktree",
            "add",
            "--detach",
            str(worktree),
            "HEAD",
        )
        for path in (checkout, worktree):
            for role in ("GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"):
                identity = run("git", "-C", str(path), "var", role)
                assert identity.startswith(f"{expected_name} <{expected_email}> "), (
                    path,
                    role,
                    identity,
                )
        print(
            f"Rendered init/runtime identity passed for checkout and worktree: {expected_email}"
        )


if __name__ == "__main__":
    verify(*sys.argv[1:])
