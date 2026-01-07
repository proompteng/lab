# Coder Workspace Bootstrap Runbook

This document explains how to maintain the single `k8s-arm64` template in Coder, publish new versions, and verify the bootstrap script so Codex tasks and local development stay reproducible. See the [Coder template documentation](https://coder.com/docs/admin/templates) for background.

## Prerequisites

- Logged in to the Coder deployment (`coder login ...`).
- `coder` CLI v2.28.6 or newer on your local machine (download instructions in the [Coder CLI manual](https://coder.com/docs/cli/install)).
- Repository cloned locally (this repo, default path `~/github.com/lab`).

## Template Update Loop

1. Edit `kubernetes/coder/main.tf` and `kubernetes/coder/template.yaml` as needed.
2. Bump `version` in `kubernetes/coder/template.yaml` (e.g., `1.0.8`).
3. Push a new template version (Coder increments template revisions automatically when `--message` is provided).
   ```bash
   coder templates push k8s-arm64 --directory kubernetes/coder --message 'feat: describe change' --yes
   ```
4. Confirm only one template exists:
   ```bash
   coder templates list
   ```
   If an extra template appears (e.g., `coder`), delete it:
   ```bash
   coder templates delete <template-name> --yes
   ```

## Workspace Recreation

1. Delete the old workspace before recreating:
   ```bash
   coder delete greg/proompteng --yes
   ```
2. Recreate it using the latest version (automatically active after push):
   ```bash
   coder create greg/proompteng \
     --template k8s-arm64 \
     --parameter cpu=4 \
     --parameter memory=8 \
     --parameter home_disk_size=30 \
     --parameter repository_url=https://github.com/proompteng/lab \
     --parameter repository_directory=/home/coder/github.com \
     --yes
   ```
   The CLI is interactive by default; pass `--yes` and explicit `--parameter` values or it will block waiting for input. Use an absolute workspace path (for example `/home/coder/github.com`) to avoid your local shell expanding `~` before it reaches Coder.
3. Wait for the workspace to provision. Use `coder list` to watch status.

## Bootstrap Script Overview

- Installs Bun (via the official shell script) so package scripts use the same runtime locally and in automation.
- Installs recommended CLI tools (`ripgrep`, `fd-find`, `fzf`, `bat`, `jq`) via apt.
- Installs Node.js LTS via nvm (nvm runs with nounset disabled to avoid unbound variable exits).
- Installs CLI dependencies in this order: `bun`, `convex@1.27.0`, `@openai/codex` (via `bun install -g`), `kubectl`, `argocd`, `gh`.
- Symlinks `kubectl`, `argocd`, and `gh` into `/tmp/coder-script-data/bin` so non-interactive shells can reach them.
- Workspace pods run with a service account bound to `cluster-admin` via a RoleBinding (namespace-scoped) so in-cluster `kubectl` has admin access.
- Appends `BUN_INSTALL/bin` and `~/.local/bin` to the login shells (`.profile`, `.bashrc`, `.zshrc`) so future shells inherit the toolchain.
- Dependency install runs only when a manifest exists: `bun install --frozen-lockfile` when a Bun lockfile is present, otherwise `bun install` when only `package.json` is present.

## Inspecting Bootstrap Logs

- Primary log directory: `/tmp/coder-bootstrap` (created by the bootstrap script).
- Agent logs:
  - `/tmp/coder-startup-script.log`
  - `/tmp/coder-agent.log`
  - `/tmp/coder-script-*.log`

Connect without waiting for scripts to finish so you can inspect logs while the bootstrap runs:

```bash
coder ssh greg/proompteng.main --wait=no
```

## Verifying Installed Tools

Run these checks inside the workspace to ensure bootstrap success:

```bash
bun --version
codex --version
convex --version
kubectl version --client
argocd version --client
gh --version
```

If a command is missing, re-run the bootstrap script manually for quicker iteration:

```bash
bash -x /tmp/coder-script-data/bin/bootstrap_tools
```

## Syncing Codex CLI Authentication

Codex sessions are stored locally under `~/.codex/auth.json`. When recreating the `proompteng` workspace you need to push that file into the remote home directory so CLI calls succeed without re-authenticating.

1. Make sure your local machine has an SSH host entry for each workspace:
   ```bash
   coder config-ssh --yes
   ```
   This creates aliases such as `coder.proompteng` that wrap the Coder proxy command.
2. Sync the Codex CLI credentials and config:
   ```bash
   ./scripts/sync-codex-cli.sh
   ```
   - Optional flags: `--workspace <name>`, `--auth <path>`, `--config <path>`, `--remote-home <path>`, `--remote-repo <path>`.
     - The script checks for both `rsync` and the OpenSSH client locally and will exit early if either is missing.
   - By default the script consumes `scripts/codex-config-template.toml` (no MCP stanza) and renders it for the remote paths, so `/home/coder` and `/home/coder/github.com/lab` remain trusted on Ubuntu. Supply `--config <path>` if you need a different template.
  - After syncing it installs a shell wrapper function in `~/.profile`, `~/.bashrc`, and `~/.zshrc` so running `codex …` automatically expands to `codex --full-auto --dangerously-bypass-approvals-and-sandbox --search --model gpt-5.2-codex …` without shadowing the binary.
   - Both files are locked down with `chmod 600` after transfer.
3. Verify on the remote host if desired:
   ```bash
   ssh coder.proompteng 'ls -l ~/.codex/auth.json'
   ```

If you skip step 1 the script fails fast with: `SSH host entry 'coder.<workspace>' not found. Run 'coder config-ssh --yes' to configure SSH access.`

## Debug Tips

- Exit code 127 usually means a command was not found. Ensure PATH exports in the bootstrap script include `$HOME/.local/bin` and `$HOME/.bun/bin` before using the tool.
- Every installation step writes detailed logs under `/tmp/coder-bootstrap/*.log`. Review these before editing the script.
- For Bun tooling, confirm `~/.bun/bin` is on PATH and `bun` resolves before re-running the script.
- Use `coder templates versions list k8s-arm64` to make sure the expected version is active.

## Research References

- Coder troubleshooting guide: https://coder.com/docs/admin/templates/troubleshooting
  - Covers non-blocking startup scripts, logging locations, and interpreting agent errors.

Following this loop keeps the template lineage clean and ensures future Codex runs can pick up where you leave off.

## Latest Update (January 7, 2026)

- Template version `1.0.28` installs Node.js LTS via nvm alongside Bun and adds recommended CLI tools.
- CLI installs use Bun (`bun add -g` for `convex`, `bun install -g` for `@openai/codex`).
- `kubectl`, `argocd`, and `gh` binaries are symlinked into `/tmp/coder-script-data/bin` for non-interactive shells.
