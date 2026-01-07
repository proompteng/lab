# Coder Template: Kubernetes Workspace (arm64)

This template provisions a Coder workspace on Kubernetes with:

- arm64 agent binary tuned for arm64 nodes
- `code-server` exposed at <http://localhost:13337>
- Persistent home volume sized via the `home_disk_size` parameter
- Git checkout via `coder/git-clone`, followed by dependency install on first boot
- Cursor launcher, Bun, kubectl, Argo CD CLI, Convex CLI, OpenAI Codex CLI, and GitHub CLI

## Install

Prereqs:

- Coder CLI logged in to your instance (`coder login https://coder.proompteng.ai`)
- Admin access to push templates

Steps:

1. Navigate to this directory:

```bash
cd kubernetes/coder
```

2. Push the template into Coder:

```bash
coder templates push --directory . --yes
```

3. Create a workspace from the `kubernetes/coder` template in the UI, or via CLI:

```bash
coder workspaces create sutro --template "kubernetes/coder"
```

## Parameters

- CPU cores: 4/6/8 (default 4)
- Memory (GiB): 4/6/8 (default 8)
- Home disk size (GiB): default 30
- Repository URL: defaults to `https://github.com/proompteng/lab`; accepts HTTPS or SSH remotes
- Checkout directory: defaults to `~/github.com` and expands to `${directory}/${repo}` inside the workspace

## Modules & automation

- `coder/git-clone@1.1.1` for repository checkout
- `coder/cursor@1.3.2` to expose Cursor Desktop
- `coder_script.bootstrap_tools` runs on start to:
  - Install Bun (via the official installer)
  - Install Convex CLI, OpenAI Codex CLI, kubectl, Argo CD CLI, and GitHub CLI when missing
  - Expand the repository path, then run `bun install --frozen-lockfile` or `bun install` based on repo files
  - Persist Bun environment variables in `.profile` and `.zshrc`

If a workspace becomes unhealthy, check logs inside the pod:

- `/tmp/coder-startup-script.log`
- `/tmp/coder-agent.log`

## Troubleshooting

- Force restart a workspace pod to re-run the init:

```bash
kubectl -n coder delete pod -l app.kubernetes.io/name=coder-workspace
```

- SSH without waiting for the startup script:

```bash
coder ssh <workspace-name> --wait=no
```
