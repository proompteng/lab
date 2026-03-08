# Tooling Setup (March 8 2026)

This guide covers the contributor tooling that should match the current repo state.

## Node.js and Bun

- Node.js: `24.11.1`
- Bun: `1.3.10`

Examples with `nvm`:

```bash
nvm install 24.11.1
nvm alias default 24.11.1
```

Install Bun from the official installer:

```bash
curl -fsSL https://bun.sh/install | bash
```

## OpenTofu and Terraform

The infrastructure under `tofu/` uses OpenTofu. Keep Terraform available for legacy modules and upstream parity checks.

```bash
brew install opentofu
brew install terraform
```

## Kubernetes and Helm

Install the standard CLI tools:

```bash
brew install kubectl
brew install helm
```

This repo still requires Helm 3 for some Kustomize workflows. Use `mise` when you need that pinned major:

```bash
mise exec helm@3 -- helm version
```

## Ansible

```bash
brew install ansible
```

## PostgreSQL client utilities

macOS:

```bash
brew install postgresql
```

Ubuntu:

```bash
sudo apt update
sudo apt install postgresql-client
```

## Python tooling

We use Python across multiple repo areas:

- `apps/alchimie`: `3.9-3.12`
- `services/torghut`: `3.11-3.12`
- general automation: `3.12` is a good default

Recommended local setup:

```bash
brew install pyenv
brew install uv
brew install pipx
pipx ensurepath
```

Example Python install with `pyenv`:

```bash
pyenv install 3.12.5
pyenv global 3.12.5
```

## GitHub CLI

```bash
brew install gh
```

## Notes

- Prefer the nearest workspace README for service-specific setup and commands.
- Root workflow and repo conventions live in `AGENTS.md`.
- For deploy/build/reseal flows, prefer the typed scripts under `packages/scripts/src/**`.
